import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import type { HardhatPlugin } from "hardhat/types/plugins";

import hardhatKms from "../../src/index.ts";
import { createKeyAdapter } from "../../src/internal/providers/create-adapter.ts";
import { KmsSigner } from "../../src/internal/signer/kms-signer.ts";
import type { KmsHooks, KmsKeyAdapter, KmsKeyConfig, KmsKeyUserConfig } from "../../src/types.ts";
import { fakeAdapter } from "../helpers/fake-adapter.ts";
import { HARDHAT_ACCOUNT_0, PERSONAL_SIGN_VECTORS } from "../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const secretKey = hex(HARDHAT_ACCOUNT_0.secretKey);

/** A third-party plugin that provides "myvault" keys, as a separate npm package would. */
const myVaultPlugin: HardhatPlugin = {
  id: "hardhat-kms-myvault-test",
  hookHandlers: {
    kms: async () => ({
      default: async (): Promise<Partial<KmsHooks>> => ({
        createKeyAdapter: async (context, vaultKey, next) => {
          // A provider that does not augment KmsProviderConfigs compares the id as a string.
          const provider: string = vaultKey.provider;
          return provider === "myvault"
            ? fakeAdapter({ secretKey })
            : await next(context, vaultKey);
        },
      }),
    }),
  },
};

const keysValue: unknown = {
  vault: { provider: "myvault", keyPath: "a/b" },
  aws: { provider: "aws", keyId: "alias/deployer" },
  nobody: { provider: "nobody" },
  gcp: {
    provider: "gcp",
    keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
  },
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- providers this package does not know
const keys = keysValue as Record<string, KmsKeyUserConfig>;

async function runtime(plugins: HardhatPlugin[] = [hardhatKms, myVaultPlugin]) {
  return await createHardhatRuntimeEnvironment({ plugins, kms: { keys } });
}

function key(
  hre: { config: { kms: { keys: Record<string, KmsKeyConfig> } } },
  name: string,
): KmsKeyConfig {
  const resolved = hre.config.kms.keys[name];
  assert.ok(resolved);
  return resolved;
}

async function assertPluginError(promise: Promise<unknown>, includes: string[]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    for (const part of includes) {
      assert.ok(error.message.includes(part), `"${error.message}" should include "${part}"`);
    }
    return true;
  });
}

describe("kms hook", () => {
  it("builds adapters for a third-party provider, which then sign like any other key", async () => {
    const hre = await runtime();
    const adapter = await createKeyAdapter(hre, key(hre, "vault"));
    const signer = new KmsSigner(adapter, { timeoutMs: 1000, displayMessage: async () => {} });
    const vector = PERSONAL_SIGN_VECTORS[0];

    assert.equal(await signer.getAddress(), HARDHAT_ACCOUNT_0.address);
    assert.equal(await signer.signPersonalMessage(hex(vector.message)), vector.signature);
  });

  it("names the package to install for a first-party key that no plugin claims", async () => {
    const hre = await runtime();

    await assertPluginError(createKeyAdapter(hre, key(hre, "aws")), [
      "aws, create adapter, key aws:alias/deployer:",
      "AWS KMS keys need the @hardhat-kms/aws plugin",
      "`npm install --save-dev @hardhat-kms/aws`",
      "`plugins`",
    ]);
    await assertPluginError(createKeyAdapter(hre, key(hre, "gcp")), [
      "Google Cloud KMS keys need the @hardhat-kms/gcp plugin",
      "`npm install --save-dev @hardhat-kms/gcp`",
    ]);
  });

  it("fails clearly when no plugin provides the key's provider", async () => {
    const hre = await runtime();

    await assertPluginError(createKeyAdapter(hre, key(hre, "nobody")), [
      'no plugin provides "nobody" keys',
      "`plugins`",
    ]);
    const withoutVault = await runtime([hardhatKms]);
    await assertPluginError(createKeyAdapter(withoutVault, key(withoutVault, "vault")), [
      'no plugin provides "myvault" keys',
    ]);
  });

  it("refuses a reserved provider id even when a plugin claims its keys", async () => {
    const hre = await runtime();
    const claimed: string[] = [];
    hre.hooks.registerHandlers("kms", {
      createKeyAdapter: async (context, reservedKey, next) => {
        const provider: string = reservedKey.provider;
        if (provider === "turnkey" || provider === "fireblocks") {
          claimed.push(provider);
          return fakeAdapter({ secretKey });
        }
        return await next(context, reservedKey);
      },
    });
    const vault = key(hre, "vault");
    for (const [provider, name, issue] of [
      ["turnkey", "Turnkey", 54],
      ["fireblocks", "Fireblocks", 55],
    ] as const) {
      // Validation refuses these ids, so change a resolved key at run time, as another plugin's
      // config hook could. No provider config type has these ids, hence Reflect.set.
      const reservedKey: KmsKeyConfig = { ...vault, displayId: `${provider}:a` };
      Reflect.set(reservedKey, "provider", provider);
      await assertPluginError(createKeyAdapter(hre, reservedKey), [
        `${provider}, create adapter, key ${provider}:a:`,
        `signing with ${name} keys is not available yet`,
        `https://github.com/aelmanaa/hardhat-kms/issues/${issue}`,
      ]);
    }
    assert.deepEqual(claimed, []);
  });

  it("lets a test provide a first-party provider with a handler registered at run time", async () => {
    const hre = await runtime();
    const seen: string[] = [];
    hre.hooks.registerHandlers("kms", {
      createKeyAdapter: async (context, resolvedKey, next) => {
        seen.push(resolvedKey.provider);
        return resolvedKey.provider === "aws"
          ? fakeAdapter({ secretKey })
          : await next(context, resolvedKey);
      },
    });

    const adapter = await createKeyAdapter(hre, key(hre, "aws"));
    await createKeyAdapter(hre, key(hre, "vault"));

    assert.equal(adapter.describe().provider, "fake");
    // Run-time handlers run before plugin handlers, and pass other keys on.
    assert.deepEqual(seen, ["aws", "myvault"]);
  });

  describe("checks the adapters handlers return", () => {
    const cases: Array<[string, unknown, string]> = [
      ["not an object", 42, "is not an object"],
      ["no describe()", { signDigest: async () => {} }, "has no describe() method"],
      [
        "no signing method",
        { describe: () => ({}), getPublicKey: async () => {} },
        "has no signing method",
      ],
      [
        "no identity and no pin",
        { describe: () => ({}), signDigest: async () => {} },
        "has no `address` pin",
      ],
    ];
    for (const [name, returned, message] of cases) {
      it(`rejects an adapter with ${name}`, async () => {
        const hre = await runtime();
        hre.hooks.registerHandlers("kms", {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately broken adapters
          createKeyAdapter: async () => returned as KmsKeyAdapter,
        });

        await assertPluginError(createKeyAdapter(hre, key(hre, "vault")), [
          "myvault, create adapter, key myvault:vault",
          message,
        ]);
      });
    }

    it("accepts an address-only adapter when the key has an address pin", async () => {
      const hre = await createHardhatRuntimeEnvironment({
        plugins: [hardhatKms],
        kms: {
          keys: {
            pinned: { provider: "aws", keyId: "alias/a", address: HARDHAT_ACCOUNT_0.address },
          },
        },
      });
      hre.hooks.registerHandlers("kms", {
        createKeyAdapter: async () => fakeAdapter({ secretKey, identity: "none" }),
      });

      const adapter = await createKeyAdapter(hre, key(hre, "pinned"));
      assert.equal(adapter.describe().provider, "fake");
    });
  });
});
