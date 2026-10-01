import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AccessToken } from "@azure/identity";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { InvalidPublicKeyError } from "hardhat-kms/provider-utils";
import type { AzureKmsKeyConfig } from "hardhat-kms/types";
import { HardhatPluginError } from "hardhat/plugins";

import { createAzureKeyAdapter } from "../../src/internal/adapter.ts";
import {
  fakeKeyVaultSdk,
  type FakeKeyVaultOptions,
  KEY_NAME,
  KEY_URL,
  KEY_VERSION,
  restError,
  VAULT_URL,
  VERSIONED_KEY_URL,
} from "../helpers/fake-key-vault.ts";

const secretKey = secp256k1.utils.randomSecretKey();
const context = () => ({
  signal: new AbortController().signal,
  displayMessage: async () => {},
  requestId: "r1",
});
const credential = {
  getToken: async (): Promise<AccessToken> =>
    await Promise.resolve({ token: "t", expiresOnTimestamp: Date.now() + 3_600_000 }),
};

/** A resolved Azure key, as hardhat-kms passes it to the adapter. */
function azureKey(keyId: string, display = keyId): AzureKmsKeyConfig {
  return {
    provider: "azure",
    name: "deployer",
    keyId: { get: async () => await Promise.resolve(keyId), display },
    timeoutMs: 1000,
    displayId: `azure:${display}`,
  };
}

async function adapterFor(keyId: string, options: Partial<FakeKeyVaultOptions> = {}) {
  const fake = fakeKeyVaultSdk({ secretKey, ...options });
  const adapter = await createAzureKeyAdapter(azureKey(keyId), fake.sdk, credential);
  return { adapter, ...fake };
}

async function assertAzureError(promise: Promise<unknown>, includes: string[]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    for (const part of includes) {
      assert.ok(error.message.includes(part), `"${error.message}" should include "${part}"`);
    }
    return true;
  });
}

const digest = new Uint8Array(32).fill(9);

describe("Azure Key Vault adapter", () => {
  it("returns the key's public key and Key Vault's r || s signature of the digest, unchanged", async () => {
    for (const highS of [false, true]) {
      const { adapter } = await adapterFor(VERSIONED_KEY_URL, { highS });
      const ctx = context();

      assert.deepEqual(await adapter.getPublicKey?.(ctx), secp256k1.getPublicKey(secretKey, false));
      const signature = await adapter.signDigest?.({ digest }, ctx);
      assert.ok(signature !== undefined && "format" in signature);
      assert.equal(signature.format, "compact");
      assert.equal(signature.bytes.length, 64);
      const parsed = secp256k1.Signature.fromBytes(signature.bytes, "compact");
      // The core signer folds high S; the adapter must pass Key Vault's answer on as it came.
      assert.equal(parsed.hasHighS(), highS);
      assert.ok(
        secp256k1.verify(signature.bytes, digest, secp256k1.getPublicKey(secretKey), {
          prehash: false,
          lowS: false,
        }),
      );
    }
  });

  it("signs with ES256K against the versioned key, in the vault of the key id", async () => {
    const { adapter, calls, vaults, cryptographyKeys } = await adapterFor(VERSIONED_KEY_URL);
    const ctx = context();
    await adapter.getPublicKey?.(ctx);
    await adapter.signDigest?.({ digest }, ctx);

    assert.deepEqual(vaults, [VAULT_URL]);
    assert.deepEqual(cryptographyKeys, [VERSIONED_KEY_URL]);
    assert.deepEqual(
      calls.map(({ method, target, version, algorithm }) => [method, target, version, algorithm]),
      [
        ["getKey", KEY_NAME, KEY_VERSION, undefined],
        ["sign", VERSIONED_KEY_URL, undefined, "ES256K"],
      ],
    );
    assert.deepEqual(calls[1]?.digest, digest);
    assert.ok(calls.every((call) => call.abortSignal === ctx.signal));
  });

  it("pins the current version of an unversioned key once, and signs with it", async () => {
    const current = "fedcba9876543210fedcba9876543210";
    const { adapter, calls, cryptographyKeys } = await adapterFor(KEY_URL, {
      currentVersion: current,
    });
    await adapter.getPublicKey?.(context());
    await adapter.signDigest?.({ digest }, context());
    // A second lookup reads the pinned version, not whatever is current by then.
    await adapter.getPublicKey?.(context());

    assert.deepEqual(
      calls.map(({ method, version }) => [method, version]),
      [
        ["getKey", undefined],
        ["sign", undefined],
        ["getKey", current],
      ],
    );
    assert.deepEqual(cryptographyKeys, [`${KEY_URL}/${current}`]);
  });

  it("looks the key up first if asked to sign before the public key", async () => {
    const { adapter, calls } = await adapterFor(KEY_URL);
    await adapter.signDigest?.({ digest }, context());

    assert.deepEqual(
      calls.map((call) => call.method),
      ["getKey", "sign"],
    );
  });

  it("accepts EC-HSM keys and coordinates without their leading zeros", async () => {
    // A key whose x starts with a zero byte, so trimming it shortens the coordinate.
    let key = secp256k1.utils.randomSecretKey();
    while (secp256k1.getPublicKey(key, false)[1] !== 0) {
      key = secp256k1.utils.randomSecretKey();
    }
    const fake = fakeKeyVaultSdk({ secretKey: key, kty: "EC-HSM", trimCoordinates: true });
    const adapter = await createAzureKeyAdapter(azureKey(VERSIONED_KEY_URL), fake.sdk, credential);

    assert.deepEqual(await adapter.getPublicKey?.(context()), secp256k1.getPublicKey(key, false));
  });

  it("describes the key by its display values", async () => {
    const fake = fakeKeyVaultSdk({ secretKey });
    const adapter = await createAzureKeyAdapter(
      azureKey(VERSIONED_KEY_URL, "<AZURE_KEY_VAULT_KEY_ID>"),
      fake.sdk,
      credential,
    );

    assert.deepEqual(adapter.describe(), {
      provider: "azure",
      pinnedId: "<AZURE_KEY_VAULT_KEY_ID>",
      displayId: "azure:<AZURE_KEY_VAULT_KEY_ID>",
    });
  });

  it("refuses a key id that is not a Key Vault key URL", async () => {
    await assertAzureError(
      createAzureKeyAdapter(
        azureKey("https://example.com/keys/a"),
        fakeKeyVaultSdk({ secretKey }).sdk,
        credential,
      ),
      [
        "azure, create adapter, key azure:https://example.com/keys/a:",
        "not an Azure Key Vault key URL",
      ],
    );
  });

  describe("refuses keys and responses that are not what it asked for", () => {
    const cases: Array<[string, Partial<FakeKeyVaultOptions>, string]> = [
      ["an RSA key", { kty: "RSA" }, "the key type is RSA, not EC or EC-HSM"],
      ["no key type", { kty: undefined }, "the key type is missing, not EC or EC-HSM"],
      [
        "a P-256 key",
        { crv: "P-256" },
        "the key curve is P-256, not P-256K (secp256k1). Create the key with --kty EC --curve P-256K",
      ],
      [
        "the curve spelled SECP256K1",
        { crv: "SECP256K1" },
        "the key curve is SECP256K1, not P-256K",
      ],
      ["no curve", { crv: undefined }, "the key curve is missing"],
      ["no public key", { omitJwk: true }, "the response has no public key"],
      ["a disabled key", { enabled: false }, "the key version is disabled"],
      [
        "a key that is not valid yet",
        { notBefore: new Date(Date.now() + 86_400_000) },
        "the key version is not valid before",
      ],
      ["an expired key", { expiresOn: new Date(Date.now() - 1000) }, "the key version expired at"],
      [
        "a key that may not sign",
        { keyOperations: ["verify"] },
        "the key's permitted operations do not include sign",
      ],
      ["no key id", { keyId: undefined }, "the response has no versioned key id"],
      ["an unversioned key id", { keyId: KEY_URL }, "the response has no versioned key id"],
      [
        "another key",
        { keyId: `${VAULT_URL}/keys/other/${KEY_VERSION}` },
        "the response is for another key than the one requested",
      ],
      [
        "another version",
        { keyId: `${KEY_URL}/ffffffffffffffffffffffffffffffff` },
        "the response is for another key version",
      ],
      [
        "a version that is a prefix of the configured one",
        { keyId: `${KEY_URL}/${KEY_VERSION.slice(0, -1)}` },
        "the response is for another key version",
      ],
      [
        "a version that extends the configured one",
        { keyId: `${KEY_URL}/${KEY_VERSION}0` },
        "the response is for another key version",
      ],
      [
        "a key whose name is a prefix of the configured one",
        { keyId: `${VAULT_URL}/keys/${KEY_NAME.slice(0, -1)}/${KEY_VERSION}` },
        "the response is for another key than the one requested",
      ],
      [
        "a key whose name extends the configured one",
        { keyId: `${VAULT_URL}/keys/${KEY_NAME}2/${KEY_VERSION}` },
        "the response is for another key than the one requested",
      ],
    ];
    for (const [name, options, message] of cases) {
      it(`on getKey: ${name}`, async () => {
        const { adapter } = await adapterFor(VERSIONED_KEY_URL, options);
        await assertAzureError(adapter.getPublicKey?.(context()) ?? Promise.resolve(), [
          `azure, get public key, key azure:${VERSIONED_KEY_URL}:`,
          message,
        ]);
      });
    }

    it("on getKey: a point that is not on the curve", async () => {
      const fake = fakeKeyVaultSdk({ secretKey });
      const adapter = await createAzureKeyAdapter(
        azureKey(VERSIONED_KEY_URL),
        {
          ...fake.sdk,
          KeyClient: class extends fake.sdk.KeyClient {
            public override async getKey(name: string) {
              const key = await super.getKey(name);
              return { ...key, key: { ...key.key, y: new Uint8Array(32).fill(1) } };
            }
          },
        },
        credential,
      );
      await assert.rejects(
        adapter.getPublicKey?.(context()) ?? Promise.resolve(),
        InvalidPublicKeyError,
      );
    });

    it("accepts versions that differ only in case, as Key Vault does", async () => {
      const { adapter } = await adapterFor(VERSIONED_KEY_URL, {
        keyId: `${VAULT_URL}/keys/${KEY_NAME.toUpperCase()}/${KEY_VERSION.toUpperCase()}`,
        signKid: `${VAULT_URL}/keys/${KEY_NAME}/${KEY_VERSION.toUpperCase()}`,
      });
      await adapter.signDigest?.({ digest }, context());
    });

    const signCases: Array<[string, Partial<FakeKeyVaultOptions>, string]> = [
      [
        "a kid with another version",
        { signKid: `${KEY_URL}/ffffffffffffffffffffffffffffffff` },
        "the signature is from another key version than the pinned one",
      ],
      [
        "a kid whose version is a prefix of the pinned one",
        { signKid: `${KEY_URL}/${KEY_VERSION.slice(0, -1)}` },
        "the signature is from another key version than the pinned one",
      ],
      [
        "a kid whose version extends the pinned one",
        { signKid: `${KEY_URL}/${KEY_VERSION}0` },
        "the signature is from another key version than the pinned one",
      ],
      [
        "a kid of another key",
        { signKid: `${VAULT_URL}/keys/other/${KEY_VERSION}` },
        "the response is for another key than the one requested",
      ],
      ["an unversioned kid", { signKid: KEY_URL }, "the response has no versioned key id"],
      ["no kid", { signKid: undefined }, "the response has no versioned key id"],
      ["a kid that is not a string", { signKid: 7 }, "the response has no versioned key id"],
      ["no response body", { omitSignBody: true }, "the response has no versioned key id"],
      ["no signature", { omitSignature: true }, "the response has no signature"],
    ];
    for (const [name, options, message] of signCases) {
      it(`on sign: ${name}`, async () => {
        const { adapter } = await adapterFor(VERSIONED_KEY_URL, options);
        await assertAzureError(adapter.signDigest?.({ digest }, context()) ?? Promise.resolve(), [
          `azure, sign, key azure:${VERSIONED_KEY_URL}:`,
          message,
        ]);
      });
    }
  });

  it("checks the pinned key's dates again before each signature", async () => {
    const { adapter, calls } = await adapterFor(VERSIONED_KEY_URL, {
      expiresOn: new Date(Date.now() + 100),
    });
    await adapter.getPublicKey?.(context());
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assertAzureError(adapter.signDigest?.({ digest }, context()) ?? Promise.resolve(), [
      `azure, sign, key azure:${VERSIONED_KEY_URL}: the key version expired at`,
    ]);
    assert.ok(calls.every((call) => call.method === "getKey"));
  });

  it("passes a signature of the wrong length on unchanged, for the core to reject", async () => {
    const { adapter } = await adapterFor(VERSIONED_KEY_URL, { signatureLength: 63 });
    const signature = await adapter.signDigest?.({ digest }, context());
    assert.ok(signature !== undefined && "format" in signature);
    assert.deepEqual([signature.format, signature.bytes.length], ["compact", 63]);
  });

  describe("explains Key Vault and credential errors without their messages", () => {
    const cases: Array<[string, Error, string]> = [
      [
        "403",
        restError(403, "Forbidden"),
        "Key Vault answered 403 Forbidden: the identity may not use this key. It needs the keys/get and keys/sign permissions: the Key Vault Crypto User role",
      ],
      [
        "404",
        restError(404, "KeyNotFound"),
        "Key Vault answered 404 KeyNotFound: the key or key version does not exist",
      ],
      ["401", restError(401), "Key Vault answered 401: the credential was not accepted"],
      ["429", restError(429, "Throttled"), "Key Vault answered 429 Throttled"],
      ["an unusual code", restError(500, "<script>"), "Key Vault answered 500"],
      [
        "no response",
        restError(undefined, "REQUEST_SEND_ERROR"),
        "Key Vault could not be reached (REQUEST_SEND_ERROR). Check the vault URL",
      ],
      ["no response or code", restError(undefined), "Key Vault could not be reached. Check"],
    ];
    for (const [name, error, message] of cases) {
      it(name, async () => {
        const { adapter } = await adapterFor(VERSIONED_KEY_URL, { error });
        await assert.rejects(adapter.getPublicKey?.(context()) ?? Promise.resolve(), (thrown) => {
          assert.ok(thrown instanceof HardhatPluginError);
          assert.ok(thrown.message.includes(message), thrown.message);
          assert.ok(!thrown.message.includes("secret details"));
          assert.ok(!thrown.message.includes("<script>"));
          return true;
        });
      });
    }

    for (const name of ["AuthenticationError", "AuthenticationRequiredError"]) {
      it(`a configured credential that fails (${name})`, async () => {
        const error = new Error("AADSTS7000215: Invalid client secret for app 1234");
        error.name = name;
        const { adapter } = await adapterFor(VERSIONED_KEY_URL, { error });
        await assert.rejects(adapter.getPublicKey?.(context()) ?? Promise.resolve(), (thrown) => {
          assert.ok(thrown instanceof HardhatPluginError);
          assert.ok(
            thrown.message.includes(
              `a configured Azure credential could not sign in (${name}). Check the service principal`,
            ),
            thrown.message,
          );
          assert.ok(!thrown.message.includes("AADSTS"));
          return true;
        });
      });
    }

    for (const name of ["CredentialUnavailableError", "AggregateAuthenticationError"]) {
      it(`no credential (${name})`, async () => {
        const error = new Error("ChainedTokenCredential authentication failed: details");
        error.name = name;
        const { adapter } = await adapterFor(VERSIONED_KEY_URL, { error });
        await assertAzureError(adapter.signDigest?.({ digest }, context()) ?? Promise.resolve(), [
          `azure, get public key, key azure:${VERSIONED_KEY_URL}: no Azure credential returned a token (${name}). Run \`az login\``,
        ]);
      });
    }

    it("passes other errors on unchanged", async () => {
      for (const error of [new Error("socket hang up"), new TypeError("bad")]) {
        const { adapter } = await adapterFor(VERSIONED_KEY_URL, { error });
        await assert.rejects(
          adapter.getPublicKey?.(context()) ?? Promise.resolve(),
          (thrown) => thrown === error,
        );
      }
    });
  });

  it("does not pin a version from a call that was abandoned", async () => {
    const { adapter, calls } = await adapterFor(KEY_URL, { answerAfterAbort: true });
    const controller = new AbortController();
    const pending = adapter.getPublicKey?.({ ...context(), signal: controller.signal });
    controller.abort();
    await pending;
    // Signing now has no pinned version, so it looks the key up again (the fake then hangs, which
    // the aborted signal below ends).
    const retry = new AbortController();
    const signing = adapter.signDigest?.({ digest }, { ...context(), signal: retry.signal });
    retry.abort();
    await assertAzureError(signing ?? Promise.resolve(), ["the key lookup did not finish"]);

    assert.deepEqual(
      calls.map((call) => call.method),
      ["getKey", "getKey"],
    );
  });
});
