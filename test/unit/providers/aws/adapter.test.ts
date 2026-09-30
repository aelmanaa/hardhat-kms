import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { HardhatUserConfig } from "hardhat/config";
import { configVariable } from "hardhat/config";
import { HardhatPluginError } from "hardhat/plugins";

import { resolveKmsConfig } from "../../../../src/internal/config/resolve.ts";
import { awsModule } from "../../../../src/internal/providers/aws/adapter.ts";
import { KmsSigner } from "../../../../src/internal/signer/kms-signer.ts";
import type { AwsKmsKeyConfig } from "../../../../src/types.ts";
import { fakeResolver } from "../../../helpers/config-variables.ts";
import { fakeAwsKmsSdk, type FakeKmsOptions, KEY_ARN } from "../../../helpers/fake-aws-kms.ts";
import { HARDHAT_ACCOUNT_0, PERSONAL_SIGN_VECTORS } from "../../../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const secretKey = hex(HARDHAT_ACCOUNT_0.secretKey);
const context = () => ({
  signal: new AbortController().signal,
  displayMessage: async () => {},
  requestId: "r1",
});

function awsKey(
  key: Record<string, unknown>,
  values: Record<string, string> = {},
  defaults = {},
): AwsKmsKeyConfig {
  const config: unknown = { kms: { defaults, keys: { k: { provider: "aws", ...key } } } };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test configs are valid AWS keys
  const resolved = resolveKmsConfig(config as HardhatUserConfig, fakeResolver(values)).keys.k;
  assert.ok(resolved?.provider === "aws");
  return resolved;
}

async function adapterFor(key: AwsKmsKeyConfig, options: Partial<FakeKmsOptions> = {}) {
  const fake = fakeAwsKmsSdk({ secretKey, ...options });
  const adapter = await awsModule.createKeyAdapter(key, {
    loadSdk: async () => await Promise.resolve(fake.sdk),
  });
  return { adapter, ...fake };
}

async function assertAwsError(promise: Promise<unknown>, includes: string[]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    for (const part of includes) {
      assert.ok(error.message.includes(part), `"${error.message}" should include "${part}"`);
    }
    return true;
  });
}

describe("AWS KMS adapter", () => {
  it("signs exactly like Hardhat's local accounts, even from high-S DER signatures", async () => {
    for (const highS of [false, true]) {
      const { adapter } = await adapterFor(awsKey({ keyId: "alias/deployer" }), { highS });
      const signer = new KmsSigner(adapter, { timeoutMs: 1000, displayMessage: async () => {} });

      assert.equal(await signer.getAddress(), HARDHAT_ACCOUNT_0.address);
      for (const vector of PERSONAL_SIGN_VECTORS) {
        assert.equal(await signer.signPersonalMessage(hex(vector.message)), vector.signature);
      }
    }
  });

  it("signs digests with the key ARN from GetPublicKey, never the alias, and MessageType DIGEST", async () => {
    const { adapter, calls } = await adapterFor(awsKey({ keyId: "alias/deployer" }));
    const ctx = context();
    await adapter.getPublicKey?.(ctx);
    await adapter.signDigest?.({ digest: new Uint8Array(32).fill(7) }, ctx);

    assert.deepEqual(
      calls.map(({ command, input }) => [command, input.KeyId]),
      [
        ["GetPublicKey", "alias/deployer"],
        ["Sign", KEY_ARN],
      ],
    );
    const sign = calls[1]?.input;
    assert.equal(sign?.MessageType, "DIGEST");
    assert.equal(sign?.SigningAlgorithm, "ECDSA_SHA_256");
    assert.deepEqual(sign?.Message, new Uint8Array(32).fill(7));
    assert.ok(calls.every((call) => call.abortSignal === ctx.signal));
  });

  it("looks the ARN up first if asked to sign before the public key", async () => {
    const { adapter, calls } = await adapterFor(awsKey({ keyId: "alias/deployer" }));
    await adapter.signDigest?.({ digest: new Uint8Array(32) }, context());

    assert.deepEqual(
      calls.map((call) => call.command),
      ["GetPublicKey", "Sign"],
    );
  });

  it("uses the region from a key ARN, the key or the defaults, and passes profile and endpoint", async () => {
    const arnKey = awsKey({ keyId: KEY_ARN }, {}, { aws: { region: "us-east-1" } });
    const variableArn = awsKey(
      { keyId: configVariable("KEY") },
      { KEY: KEY_ARN },
      { aws: { region: "us-east-1" } },
    );
    const plain = awsKey(
      { keyId: "alias/a", profile: "ci", endpoint: "http://localhost:4566" },
      {},
      { aws: { region: "us-east-1" } },
    );
    const noRegion = awsKey({ keyId: "alias/a" });

    assert.deepEqual((await adapterFor(arnKey)).clients[0]?.config, { region: "eu-west-1" });
    // A key id from a variable (or --kms) that holds an ARN: the ARN's region wins when it is read.
    assert.deepEqual((await adapterFor(variableArn)).clients[0]?.config, { region: "eu-west-1" });
    assert.deepEqual((await adapterFor(plain)).clients[0]?.config, {
      region: "us-east-1",
      profile: "ci",
      endpoint: "http://localhost:4566",
    });
    // No region anywhere: the SDK's own chain (AWS_REGION, profiles) decides.
    assert.deepEqual((await adapterFor(noRegion)).clients[0]?.config, {});
  });

  it("describes the key without its values, and closes the client", async () => {
    const { adapter, clients } = await adapterFor(
      awsKey({ keyId: configVariable("KEY") }, { KEY: "alias/secret" }),
    );

    assert.deepEqual(adapter.describe(), {
      provider: "aws",
      pinnedId: "<KEY>",
      displayId: "aws:<KEY>",
    });
    await adapter.close?.();
    assert.equal(clients[0]?.destroyed, true);
  });

  describe("refuses keys and responses that are not what it asked for", () => {
    const cases: Array<[string, Partial<FakeKmsOptions>, string]> = [
      [
        "a P-256 key",
        { keySpec: "ECC_NIST_P256" },
        "the key spec is ECC_NIST_P256, not ECC_SECG_P256K1",
      ],
      [
        "an encryption key",
        { keyUsage: "ENCRYPT_DECRYPT" },
        "the key usage is ENCRYPT_DECRYPT, not SIGN_VERIFY",
      ],
      [
        "no ECDSA_SHA_256",
        { signingAlgorithms: ["ECDSA_SHA_384"] },
        "does not support ECDSA_SHA_256",
      ],
      ["no algorithms", { signingAlgorithms: undefined }, "does not support ECDSA_SHA_256"],
      ["an alias instead of an ARN", { keyArn: "alias/deployer" }, "the response has no key ARN"],
      ["no public key", { omitPublicKey: true }, "the response has no public key"],
    ];
    for (const [name, options, message] of cases) {
      it(`on GetPublicKey: ${name}`, async () => {
        const { adapter } = await adapterFor(awsKey({ keyId: "alias/deployer" }), options);
        await assertAwsError(adapter.getPublicKey?.(context()) ?? Promise.resolve(), [
          "aws, get public key, key aws:alias/deployer:",
          message,
        ]);
      });
    }

    const signCases: Array<[string, Partial<FakeKmsOptions>, string]> = [
      [
        "a signature from another key",
        { signResponseKeyId: "arn:aws:kms:eu-west-1:111122223333:key/other" },
        "for another key",
      ],
      [
        "another algorithm",
        { signResponseAlgorithm: "ECDSA_SHA_384" },
        "does not use ECDSA_SHA_256",
      ],
      ["no signature", { omitSignature: true }, "the response has no signature"],
    ];
    for (const [name, options, message] of signCases) {
      it(`on Sign: ${name}`, async () => {
        const { adapter } = await adapterFor(awsKey({ keyId: "alias/deployer" }), options);
        await assertAwsError(
          adapter.signDigest?.({ digest: new Uint8Array(32) }, context()) ?? Promise.resolve(),
          ["aws, sign, key aws:alias/deployer:", message],
        );
      });
    }
  });

  it("rejects an SDK module that does not look like @aws-sdk/client-kms", async () => {
    await assertAwsError(
      awsModule.createKeyAdapter(awsKey({ keyId: "alias/a" }), {
        loadSdk: async () => await Promise.resolve({}),
      }),
      ["the installed @aws-sdk/client-kms does not export KMSClient"],
    );
  });

  it("refuses keys of other providers", async () => {
    const config: unknown = {
      kms: { keys: { k: { provider: "azure", keyId: "https://v.vault.azure.net/keys/k" } } },
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a valid Azure key
    const azure = resolveKmsConfig(config as HardhatUserConfig, fakeResolver({})).keys.k;
    assert.ok(azure);
    await assert.rejects(
      awsModule.createKeyAdapter(azure, { loadSdk: async () => await Promise.resolve({}) }),
      /Expected a "aws" key, got "azure"/,
    );
  });
});
