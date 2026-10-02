import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { ConfigurationVariable, ResolvedConfigurationVariable } from "hardhat/types/config";
import type { HookContext } from "hardhat/types/hooks";

import hardhatKms from "../../../src/index.ts";
import { resolveIdentifier } from "../../../src/internal/config/identifiers.ts";
import { resolveKey } from "../../../src/internal/config/resolve.ts";
import { SignerCache } from "../../../src/internal/signer/key-cache.ts";
import type { Timers } from "../../../src/internal/signer/timeout.ts";
import type {
  AwsKmsKeyConfig,
  AzureKmsKeyConfig,
  GcpKmsKeyConfig,
  KmsIdentifier,
  KmsKeyConfig,
  KmsKeyUserConfig,
} from "../../../src/types.ts";
import { fakeAdapter } from "../../helpers/fake-adapter.ts";
import { fakeTimers } from "../../helpers/fake-timers.ts";
import { COW_ACCOUNT } from "../../helpers/vectors.ts";

const secretKey = new Uint8Array(Buffer.from(COW_ACCOUNT.secretKey, "hex"));

/** A runtime with one third-party key, whose adapters the test counts and can make fail. */
async function setUp(failFirst = false) {
  const keyConfig: unknown = { provider: "myvault" };
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a third-party provider's key
    kms: { keys: { vault: keyConfig as KmsKeyUserConfig } },
  });
  const state = { created: 0, closed: 0 };
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async () => {
      state.created++;
      if (failFirst && state.created === 1) {
        throw new TypeError("first attempt fails");
      }
      const adapter = fakeAdapter({ secretKey });
      return {
        ...adapter,
        close: async () => {
          state.closed++;
          await Promise.resolve();
        },
      };
    },
  });
  const key: KmsKeyConfig | undefined = hre.config.kms.keys.vault;
  assert.ok(key);
  const context: HookContext = hre;
  return { context, key, state };
}

describe("SignerCache", () => {
  it("creates one signer per key and reuses it", async () => {
    const { context, key, state } = await setUp();
    const cache = new SignerCache(fakeTimers());

    const [first, second] = await Promise.all([
      cache.signerFor(context, key),
      cache.signerFor(context, key),
    ]);
    assert.equal(first, second);
    assert.equal(await first.getAddress(), COW_ACCOUNT.address);
    assert.equal(state.created, 1);
  });

  it("does not keep a signer that failed to open", async () => {
    const { context, key, state } = await setUp(true);
    const cache = new SignerCache(fakeTimers());

    await assert.rejects(
      cache.signerFor(context, key),
      /creating the adapter failed \(TypeError\)/,
    );
    await cache.signerFor(context, key);
    assert.equal(state.created, 2);
  });

  it("closes an adapter that the signer refuses, and reports the signer's error", async () => {
    const { context, key, state } = await setUp();
    // describe() passes the contract check, then fails when the signer calls it.
    let describes = 0;
    context.hooks.registerHandlers("kms", {
      createKeyAdapter: async () => {
        state.created++;
        const adapter = fakeAdapter({ secretKey });
        return {
          ...adapter,
          describe: () => {
            describes++;
            if (describes > 1) {
              throw new TypeError("describe failed");
            }
            return adapter.describe();
          },
          close: async () => {
            state.closed++;
            await Promise.reject(new Error("close failed too"));
          },
        };
      },
    });
    const cache = new SignerCache(fakeTimers());

    await assert.rejects(cache.signerFor(context, key), /describe failed/);
    assert.equal(state.closed, 1);
  });

  it("sends adapter status messages to the display it was given", async () => {
    const { context, key } = await setUp();
    const shown: string[] = [];
    context.hooks.registerHandlers("kms", {
      createKeyAdapter: async () => {
        const adapter = fakeAdapter({ secretKey });
        return {
          ...adapter,
          getPublicKey: async (ctx) => {
            await ctx.displayMessage("waiting");
            return await (adapter.getPublicKey?.(ctx) ?? Promise.reject(new Error("no key")));
          },
        };
      },
    });
    const cache = new SignerCache(fakeTimers(), async (displayContext, message) => {
      assert.equal(displayContext, context);
      shown.push(message);
      await Promise.resolve();
    });

    assert.equal(await (await cache.signerFor(context, key)).getAddress(), COW_ACCOUNT.address);
    assert.deepEqual(shown, ["waiting"]);
  });

  it("closes the signers once idle after the last connection, and opens them again on use", async () => {
    const { context, key, state } = await setUp();
    const timers = fakeTimers();
    const cache = new SignerCache(timers);

    cache.connectionOpened();
    cache.connectionOpened();
    await cache.signerFor(context, key);
    cache.connectionClosed();
    assert.equal(timers.pending(), 0, "a connection is still open");

    cache.connectionClosed();
    assert.equal(timers.pending(), 1);
    timers.fire();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.closed, 1);

    await cache.signerFor(context, key);
    assert.equal(state.created, 2, "the next use opens a new signer");
  });

  it("keeps the signers when a connection opens before the idle timer fires", async () => {
    const { context, key, state } = await setUp();
    const timers = fakeTimers();
    const cache = new SignerCache(timers);

    cache.connectionOpened();
    await cache.signerFor(context, key);
    cache.connectionClosed();
    assert.equal(timers.pending(), 1);
    cache.connectionOpened();
    assert.equal(timers.pending(), 0);
    assert.equal(state.closed, 0);
  });

  it("does not let extra closes count against later connections", async () => {
    const { context, key, state } = await setUp();
    const timers = fakeTimers();
    const cache = new SignerCache(timers);

    cache.connectionOpened();
    cache.connectionClosed();
    cache.connectionClosed();
    cache.connectionOpened();
    cache.connectionOpened();
    await cache.signerFor(context, key);
    cache.connectionClosed();
    assert.equal(timers.pending(), 0, "one connection is still open");
    assert.equal(state.closed, 0);
  });

  it("starts no idle timer when nothing is open", () => {
    const timers = fakeTimers();
    const cache = new SignerCache(timers);

    cache.connectionOpened();
    cache.connectionClosed();
    cache.connectionClosed();
    assert.equal(timers.pending(), 0);
  });
});

describe("SignerCache after closeAll", () => {
  it("keeps the signer created after closeAll when an older creation fails", async () => {
    const { context, key, state } = await setUp();
    let failFirst: (() => void) | undefined;
    const firstFails = new Promise<void>((resolve) => {
      failFirst = resolve;
    });
    context.hooks.registerHandlers("kms", {
      createKeyAdapter: async () => {
        state.created++;
        if (state.created === 1) {
          await firstFails;
          throw new TypeError("first attempt fails");
        }
        return fakeAdapter({ secretKey });
      },
    });
    const cache = new SignerCache(fakeTimers());

    const first = cache.signerFor(context, key);
    const closing = cache.closeAll();
    const second = await cache.signerFor(context, key);
    failFirst?.();
    await assert.rejects(first, /creating the adapter failed \(TypeError\)/);
    await closing;

    // The failed creation was no longer cached, so it must not drop the signer that replaced it.
    assert.equal(await cache.signerFor(context, key), second);
    assert.equal(state.created, 2);
  });

  it("starts the idle close for a request still running after closeAll", async () => {
    const { context, key, state } = await setUp();
    const timers = fakeTimers();
    const cache = new SignerCache(timers);
    let finish: (() => void) | undefined;
    const signing = new Promise<void>((resolve) => {
      finish = resolve;
    });

    cache.connectionOpened();
    const inFlight = cache.withSigner(context, key, async () => {
      await signing;
      // The request opens a signer again after the cache was emptied.
      await cache.signerFor(context, key);
    });
    await new Promise((resolve) => setImmediate(resolve));
    await cache.closeAll();
    assert.equal(state.closed, 1);
    cache.connectionClosed();
    assert.equal(timers.pending(), 1, "the running request may still open a signer");

    finish?.();
    await inFlight;
    while (timers.pending() > 0) {
      timers.fire();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(state.created, 2);
    assert.equal(state.closed, 2);
  });
});

describe("SignerCache adapters", () => {
  it("passes an adapter's status messages to Hardhat, and survives a failing close", async () => {
    const keyConfig: unknown = { provider: "myvault" };
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a third-party provider's key
      kms: { keys: { vault: keyConfig as KmsKeyUserConfig } },
    });
    const shown: string[] = [];
    hre.hooks.registerHandlers("userInterruptions", {
      displayMessage: async (_context, interruptor, message) => {
        shown.push(`${interruptor}: ${message}`);
        await Promise.resolve();
      },
    });
    hre.hooks.registerHandlers("kms", {
      createKeyAdapter: async () => {
        const adapter = fakeAdapter({ secretKey });
        return {
          ...adapter,
          getPublicKey: async (ctx) => {
            await ctx.displayMessage("approve the request on your device");
            return await (adapter.getPublicKey?.(ctx) ?? Promise.reject(new Error("no key")));
          },
          close: async () => await Promise.reject(new Error("close failed")),
        };
      },
    });
    const key = hre.config.kms.keys.vault;
    assert.ok(key);
    const cache = new SignerCache(fakeTimers());
    const signer = await cache.signerFor(hre, key);

    assert.equal(await signer.getAddress(), COW_ACCOUNT.address);
    assert.deepEqual(shown, ["hardhat-kms: approve the request on your device"]);
    await cache.closeAll();
  });
});

describe("SignerCache idle close", () => {
  it("does not close while a connection is open, even if the timer was not cancelled", async () => {
    const { context, key, state } = await setUp();
    const callbacks: (() => void)[] = [];
    // Timers whose cancel does nothing: the idle callback runs after a connection reopened.
    const timers: Timers = {
      setTimeout(callback) {
        callbacks.push(callback);
        return () => {
          // Does not cancel.
        };
      },
    };
    const cache = new SignerCache(timers);

    cache.connectionOpened();
    await cache.signerFor(context, key);
    cache.connectionClosed();
    cache.connectionOpened();
    assert.equal(callbacks.length, 1);
    for (const callback of callbacks.splice(0)) {
      callback();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.closed, 0);
  });

  it("waits for a request that is still signing", async () => {
    const { context, key, state } = await setUp();
    const timers = fakeTimers();
    const cache = new SignerCache(timers);
    let finish: (() => void) | undefined;
    const signing = new Promise<void>((resolve) => {
      finish = resolve;
    });

    cache.connectionOpened();
    const inFlight = cache.withSigner(context, key, async () => {
      await signing;
    });
    await new Promise((resolve) => setImmediate(resolve));
    cache.connectionClosed();
    timers.fire();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.closed, 0, "the signer is still in use");
    assert.equal(timers.pending(), 1, "the idle close tries again later");

    finish?.();
    await inFlight;
    timers.fire();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.closed, 1);
  });
});

/** A resolved configuration variable whose value comes from `get`. */
function resolvedWith(get: () => Promise<string>): ResolvedConfigurationVariable {
  return {
    _type: "ResolvedConfigurationVariable",
    format: "{variable}",
    get,
    getUrl: get,
    getBigInt: async () => BigInt(await get()),
    getHexString: get,
  };
}

/** A literal identifier, built by config resolution. */
function literal(value: string): KmsIdentifier {
  return resolveIdentifier(
    value,
    () => resolvedWith(async () => await Promise.resolve(value)),
    "test",
  );
}

/** Reads the value both test variables hold. */
async function deployerAlias(): Promise<string> {
  return await Promise.resolve("alias/deployer");
}

/** An identifier that config resolution did not build, so it has no comparison form. */
function handMade(): KmsIdentifier {
  return { get: deployerAlias, display: "alias/deployer" };
}

/** An identifier from a configuration variable, built by config resolution. */
function variable(
  name: string,
  get: () => Promise<string>,
  fields: Pick<ConfigurationVariable, "format" | "default"> = {},
): KmsIdentifier {
  const written: ConfigurationVariable = { _type: "ConfigurationVariable", name, ...fields };
  return resolveIdentifier(written, () => resolvedWith(get), "test");
}

/** A Google Cloud key given as components, resolved as the config resolves it. */
function gcpComponentsKey(projectId: ConfigurationVariable): KmsKeyConfig {
  return resolveKey(
    {
      provider: "gcp",
      projectId,
      location: "global",
      keyRing: "ring",
      keyName: "key",
      keyVersion: 1,
    },
    {
      name: "gcp",
      path: "kms.keys.gcp",
      resolveVariable: () => resolvedWith(async () => await Promise.resolve("project")),
      defaults: { aws: {}, timeoutMs: 1000 },
    },
  );
}

/** A new AWS key object; each call returns a separate copy, as Hardhat does for an override. */
function awsKey(changes: Partial<AwsKmsKeyConfig> = {}): AwsKmsKeyConfig {
  return {
    provider: "aws",
    name: "deployer",
    displayId: "aws:alias/deployer",
    keyId: literal("alias/deployer"),
    region: "us-east-1",
    timeoutMs: 1000,
    ...changes,
  };
}

function gcpKey(changes: Partial<GcpKmsKeyConfig> = {}): GcpKmsKeyConfig {
  return {
    provider: "gcp",
    name: "gcp",
    displayId: "gcp:k/1",
    keyVersionName: literal("projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1"),
    timeoutMs: 1000,
    ...changes,
  };
}

function azureKey(changes: Partial<AzureKmsKeyConfig> = {}): AzureKmsKeyConfig {
  return {
    provider: "azure",
    name: "azure",
    displayId: "azure:k",
    keyId: literal("https://vault.vault.azure.net/keys/k"),
    timeoutMs: 1000,
    ...changes,
  };
}

/**
 * A runtime whose `kms` hook serves every key with a fake adapter. Like the real adapters, it
 * reads a first-party key's identifier, so an unreadable identifier fails adapter creation.
 */
async function identitySetUp() {
  const hre = await createHardhatRuntimeEnvironment({ plugins: [hardhatKms] });
  const state = { created: 0, closed: 0, getPublicKey: 0 };
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (_context, key) => {
      if (key.provider === "aws" || key.provider === "azure") {
        await key.keyId.get();
      }
      state.created++;
      const adapter = fakeAdapter({ secretKey });
      return {
        ...adapter,
        getPublicKey: async (ctx) => {
          state.getPublicKey++;
          return await (adapter.getPublicKey?.(ctx) ?? Promise.reject(new Error("no key")));
        },
        close: async () => {
          state.closed++;
          await Promise.resolve();
        },
      };
    },
  });
  const context: HookContext = hre;
  return { context, state };
}

describe("SignerCache identity", () => {
  it("shares one signer between copies of a key, and looks the key up once", async () => {
    const { context, state } = await identitySetUp();
    const cache = new SignerCache(fakeTimers());

    const [first, second] = await Promise.all([
      cache.signerFor(context, awsKey()),
      cache.signerFor(context, awsKey()),
    ]);
    assert.equal(first, second);
    assert.equal(await first.getAddress(), COW_ACCOUNT.address);
    assert.equal(
      await (await cache.signerFor(context, awsKey())).getAddress(),
      COW_ACCOUNT.address,
    );
    assert.equal(state.created, 1);
    assert.equal(state.getPublicKey, 1);
  });

  it("shares signers between copies of Google Cloud and Azure keys", async () => {
    const { context, state } = await identitySetUp();
    const cache = new SignerCache(fakeTimers());

    assert.equal(
      await cache.signerFor(context, gcpKey()),
      await cache.signerFor(context, gcpKey()),
    );
    assert.equal(
      await cache.signerFor(context, azureKey()),
      await cache.signerFor(context, azureKey()),
    );
    assert.equal(state.created, 2);
  });

  const arn = "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000";
  const variants: Record<string, [KmsKeyConfig, KmsKeyConfig]> = {
    "the key id": [awsKey(), awsKey({ keyId: literal("alias/other") })],
    "the profile": [awsKey(), awsKey({ profile: "other" })],
    "the profile of an ARN key": [
      awsKey({ keyId: literal(arn), profile: "first" }),
      awsKey({ keyId: literal(arn), profile: "second" }),
    ],
    "the region": [awsKey(), awsKey({ region: "eu-west-1" })],
    "the endpoint": [awsKey(), awsKey({ endpoint: "http://127.0.0.1:4566" })],
    "the address pin": [awsKey(), awsKey({ address: COW_ACCOUNT.address })],
    "the time budget": [awsKey(), awsKey({ timeoutMs: 2000 })],
    "the approval time budget": [awsKey(), awsKey({ approvalTimeoutMs: 60_000 })],
    "the display form": [awsKey(), awsKey({ displayId: "aws:<AWS_KMS_KEY_ID>" })],
    "the name": [awsKey(), awsKey({ name: "treasury" })],
    "the provider": [gcpKey(), azureKey({ name: "gcp", displayId: "gcp:k/1" })],
    "a Google Cloud key version": [
      gcpKey(),
      gcpKey({
        keyVersionName: literal(
          "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/2",
        ),
      }),
    ],
    "a Google Cloud time budget": [gcpKey(), gcpKey({ timeoutMs: 2000 })],
    "an Azure key": [
      azureKey(),
      azureKey({ keyId: literal("https://vault.vault.azure.net/keys/j") }),
    ],
    "an Azure vault": [
      azureKey(),
      azureKey({ keyId: literal("https://other.vault.azure.net/keys/k") }),
    ],
  };
  for (const [setting, [first, second]] of Object.entries(variants)) {
    it(`gives keys that differ only in ${setting} separate signers`, async () => {
      const { context, state } = await identitySetUp();
      const cache = new SignerCache(fakeTimers());

      assert.notEqual(
        await cache.signerFor(context, first),
        await cache.signerFor(context, second),
      );
      assert.equal(state.created, 2);
    });
  }

  const sameName: Record<string, [KmsIdentifier, KmsIdentifier]> = {
    format: [
      variable("KEY", deployerAlias),
      variable("KEY", deployerAlias, { format: "alias/{variable}" }),
    ],
    default: [
      variable("KEY", deployerAlias, { default: "alias/first" }),
      variable("KEY", deployerAlias, { default: "alias/second" }),
    ],
  };
  for (const [field, [first, second]] of Object.entries(sameName)) {
    it(`gives one variable name with a different ${field} two signers`, async () => {
      const { context, state } = await identitySetUp();
      const cache = new SignerCache(fakeTimers());

      assert.notEqual(
        await cache.signerFor(context, awsKey({ keyId: first })),
        await cache.signerFor(context, awsKey({ keyId: second })),
      );
      assert.equal(state.created, 2);
    });
  }

  it("shares a signer between copies of a variable with the same format and default", async () => {
    const { context, state } = await identitySetUp();
    const cache = new SignerCache(fakeTimers());
    const fields = { format: "alias/{variable}", default: "deployer" };

    assert.equal(
      await cache.signerFor(context, awsKey({ keyId: variable("KEY", deployerAlias, fields) })),
      await cache.signerFor(context, awsKey({ keyId: variable("KEY", deployerAlias, fields) })),
    );
    assert.equal(state.created, 1);
  });

  it("gives Google Cloud keys whose parts differ only in one part's format two signers", async () => {
    const { context, state } = await identitySetUp();
    const cache = new SignerCache(fakeTimers());
    const plain = gcpComponentsKey(configVariable("GCP_PROJECT"));

    assert.equal(
      await cache.signerFor(context, plain),
      await cache.signerFor(context, gcpComponentsKey(configVariable("GCP_PROJECT"))),
    );
    assert.notEqual(
      await cache.signerFor(context, plain),
      await cache.signerFor(
        context,
        gcpComponentsKey(configVariable("GCP_PROJECT", { format: "p-{variable}" })),
      ),
    );
    assert.equal(state.created, 2);
  });

  it("keeps a variable's default out of the identifier's printed and serialized forms", () => {
    const identifier = variable("KEY", deployerAlias, { default: "secret-default-value" });

    assert.equal(identifier.display, "<KEY>");
    assert.ok(!inspect(identifier, { showHidden: true, depth: 5 }).includes("secret-default"));
    assert.ok(!JSON.stringify(identifier).includes("secret-default"));
  });

  it("gives a key whose identifier config resolution did not build its own signer", async () => {
    const { context, state } = await identitySetUp();
    const cache = new SignerCache(fakeTimers());

    assert.notEqual(
      await cache.signerFor(context, awsKey({ keyId: handMade() })),
      await cache.signerFor(context, awsKey({ keyId: handMade() })),
    );
    assert.equal(state.created, 2);
  });

  it("gives each object of a third-party key its own signer", async () => {
    const { context, key, state } = await setUp();
    const copy: KmsKeyConfig = { ...key };
    const cache = new SignerCache(fakeTimers());

    assert.notEqual(await cache.signerFor(context, key), await cache.signerFor(context, copy));
    assert.equal(state.created, 2);
  });

  it("reads no identifier to find the signer, so a failed read is the adapter's and is retried", async () => {
    const { context, state } = await identitySetUp();
    let reads = 0;
    const flaky = variable("AWS_KMS_KEY_ID", async () => {
      reads++;
      if (reads === 1) {
        throw new TypeError("variable not set");
      }
      return await Promise.resolve("alias/deployer");
    });
    const key = awsKey({ keyId: flaky });
    const cache = new SignerCache(fakeTimers());

    // Both concurrent requests share one adapter, which reads the identifier once and fails as it
    // does without the cache.
    const results = await Promise.allSettled([
      cache.signerFor(context, key),
      cache.signerFor(context, key),
    ]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.match(String(result.reason), /creating the adapter failed \(TypeError\)/);
    }
    assert.equal(reads, 1);

    const signer = await cache.signerFor(context, key);
    assert.equal(await signer.getAddress(), COW_ACCOUNT.address);
    assert.equal(await cache.signerFor(context, key), signer, "the same object reuses it");
    assert.equal(
      await cache.signerFor(context, awsKey({ keyId: flaky })),
      signer,
      "a copy of the key reuses it",
    );
    assert.equal(reads, 2);
    assert.equal(state.created, 1);
    assert.equal(state.getPublicKey, 1);
  });

  it("leaves the first error to the provider plugin, before any identifier is read", async () => {
    // No handler claims AWS keys: the error names the package, as without the cache.
    const hre = await createHardhatRuntimeEnvironment({ plugins: [hardhatKms] });
    let reads = 0;
    const key = awsKey({
      keyId: variable("AWS_KMS_KEY_ID", async () => {
        reads++;
        return await Promise.resolve("alias/deployer");
      }),
    });
    const cache = new SignerCache(fakeTimers());

    await assert.rejects(cache.signerFor(hre, key), /hardhat-kms-aws/);
    assert.equal(reads, 0);
  });

  it("gives two variables that hold the same value two signers", async () => {
    const { context, state } = await identitySetUp();
    const cache = new SignerCache(fakeTimers());

    const first = awsKey({ keyId: variable("FIRST_KEY_ID", deployerAlias) });
    const second = awsKey({ keyId: variable("SECOND_KEY_ID", deployerAlias) });
    assert.notEqual(await cache.signerFor(context, first), await cache.signerFor(context, second));
    assert.equal(state.created, 2);
  });

  it("closes a signer whose creation outlives the last connection", async () => {
    const { context, state } = await identitySetUp();
    const timers = fakeTimers();
    const cache = new SignerCache(timers);
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const key = awsKey({
      keyId: variable("AWS_KMS_KEY_ID", async () => {
        await released;
        return "alias/deployer";
      }),
    });

    cache.connectionOpened();
    const inFlight = cache.withSigner(context, key, async (signer) => await signer.getAddress());
    await new Promise((resolve) => setImmediate(resolve));
    cache.connectionClosed();
    release?.();
    assert.equal(await inFlight, COW_ACCOUNT.address);
    while (timers.pending() > 0) {
      timers.fire();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(state.created, 1);
    assert.equal(state.closed, 1);
    assert.equal(timers.pending(), 0);
  });

  it("keeps a shared signer open until every connection is closed, then closes it once", async () => {
    const { context, state } = await identitySetUp();
    const timers = fakeTimers();
    const cache = new SignerCache(timers);

    // A plain connection and an override connection, each with its own copy of the key.
    cache.connectionOpened();
    cache.connectionOpened();
    const shared = await cache.signerFor(context, awsKey());
    assert.equal(await cache.signerFor(context, awsKey()), shared);
    cache.connectionClosed();
    assert.equal(timers.pending(), 0, "the override connection is still open");
    await cache.withSigner(context, awsKey(), async (signer) => {
      assert.equal(signer, shared);
      assert.equal(await signer.getAddress(), COW_ACCOUNT.address);
    });
    assert.equal(state.closed, 0);

    cache.connectionClosed();
    timers.fire();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.closed, 1);
    assert.equal(state.created, 1);
  });
});
