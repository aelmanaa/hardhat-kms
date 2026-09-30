import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { AwsKmsKeyConfig } from "hardhat-kms/types";
import { HardhatPluginError } from "hardhat/plugins";

import { createAwsKeyAdapter } from "../../src/internal/adapter.ts";
import { fakeAwsKmsSdk, type FakeKmsOptions, KEY_ARN } from "../helpers/fake-aws-kms.ts";

const secretKey = secp256k1.utils.randomSecretKey();
const context = () => ({
  signal: new AbortController().signal,
  displayMessage: async () => {},
  requestId: "r1",
});

/** A resolved AWS key, as hardhat-kms passes it to the adapter. */
function awsKey(
  keyId: string,
  settings: Partial<Pick<AwsKmsKeyConfig, "region" | "profile" | "endpoint">> = {},
  display = keyId,
): AwsKmsKeyConfig {
  return {
    provider: "aws",
    name: "deployer",
    keyId: { get: async () => await Promise.resolve(keyId), display },
    timeoutMs: 1000,
    displayId: `aws:${display}`,
    ...settings,
  };
}

async function adapterFor(key: AwsKmsKeyConfig, options: Partial<FakeKmsOptions> = {}) {
  const fake = fakeAwsKmsSdk({ secretKey, ...options });
  const adapter = await createAwsKeyAdapter(key, fake.sdk);
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
  it("returns the key's public key and KMS's DER signature of the digest, unchanged", async () => {
    for (const highS of [false, true]) {
      const { adapter } = await adapterFor(awsKey("alias/deployer"), { highS });
      const ctx = context();
      const digest = new Uint8Array(32).fill(9);

      assert.deepEqual(await adapter.getPublicKey?.(ctx), secp256k1.getPublicKey(secretKey, false));
      const signature = await adapter.signDigest?.({ digest }, ctx);
      assert.ok(signature !== undefined && "format" in signature && signature.format === "der");
      const parsed = secp256k1.Signature.fromBytes(signature.bytes, "der");
      // The core signer folds high S; the adapter must pass KMS's answer on as it came.
      assert.equal(parsed.hasHighS(), highS);
      assert.ok(
        secp256k1.verify(parsed.toBytes("compact"), digest, secp256k1.getPublicKey(secretKey), {
          prehash: false,
          lowS: false,
        }),
      );
    }
  });

  it("signs digests with the key ARN from GetPublicKey, never the alias, and MessageType DIGEST", async () => {
    const { adapter, calls } = await adapterFor(awsKey("alias/deployer"));
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
    const { adapter, calls } = await adapterFor(awsKey("alias/deployer"));
    await adapter.signDigest?.({ digest: new Uint8Array(32) }, context());

    assert.deepEqual(
      calls.map((call) => call.command),
      ["GetPublicKey", "Sign"],
    );
  });

  it("uses the region of a key ARN over the key's, and passes profile and endpoint", async () => {
    // A key id read from a variable (or --kms) can hold an ARN: its region wins when it is read.
    const arn = awsKey(KEY_ARN, { region: "us-east-1" });
    const plain = awsKey("alias/a", {
      region: "us-east-1",
      profile: "ci",
      endpoint: "http://localhost:4566",
    });

    assert.deepEqual((await adapterFor(arn)).clients[0]?.config, { region: "eu-west-1" });
    assert.deepEqual((await adapterFor(plain)).clients[0]?.config, {
      region: "us-east-1",
      profile: "ci",
      endpoint: "http://localhost:4566",
    });
    // No region anywhere: the SDK's own chain (AWS_REGION, profiles) decides.
    assert.deepEqual((await adapterFor(awsKey("alias/a"))).clients[0]?.config, {});
  });

  it("describes the key by its display values, and closes the client", async () => {
    const { adapter, clients } = await adapterFor(awsKey("alias/secret", {}, "<KEY>"));

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
        const { adapter } = await adapterFor(awsKey("alias/deployer"), options);
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
        "another key id that differs only in case",
        { signResponseKeyId: KEY_ARN.toUpperCase() },
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
        const { adapter } = await adapterFor(awsKey("alias/deployer"), options);
        await assertAwsError(
          adapter.signDigest?.({ digest: new Uint8Array(32) }, context()) ?? Promise.resolve(),
          ["aws, sign, key aws:alias/deployer:", message],
        );
      });
    }
  });

  it("works with multi-region keys, whose ARNs use mrk- ids", async () => {
    const mrkArn = `arn:aws:kms:eu-west-1:111122223333:key/mrk-${"a".repeat(32)}`;
    const { adapter, calls } = await adapterFor(awsKey("alias/deployer"), { keyArn: mrkArn });
    await adapter.signDigest?.({ digest: new Uint8Array(32).fill(1) }, context());

    assert.equal(calls.at(-1)?.input.KeyId, mrkArn);
  });

  it("says when no region is configured, instead of a bare error class", async () => {
    const { adapter } = await adapterFor(awsKey("alias/deployer"), {
      sendError: new Error("Region is missing"),
    });
    await assertAwsError(adapter.getPublicKey?.(context()) ?? Promise.resolve(), [
      "aws, connect, key aws:alias/deployer: no AWS region is configured",
    ]);
  });

  it("passes other SDK errors on unchanged", async () => {
    const error = new Error("AccessDeniedException");
    const { adapter } = await adapterFor(awsKey("alias/deployer"), { sendError: error });
    await assert.rejects(
      adapter.getPublicKey?.(context()) ?? Promise.resolve(),
      (thrown) => thrown === error,
    );
  });

  it("does not keep the ARN from a call that was abandoned", async () => {
    const { adapter, calls } = await adapterFor(awsKey("alias/deployer"), {
      answerAfterAbort: true,
    });
    const controller = new AbortController();
    const pending = adapter.getPublicKey?.({ ...context(), signal: controller.signal });
    controller.abort();
    await pending;
    // Signing now has no ARN to trust, so it looks the key up again (the fake then hangs, which
    // the aborted signal below ends).
    const retry = new AbortController();
    const signing = adapter.signDigest?.(
      { digest: new Uint8Array(32) },
      { ...context(), signal: retry.signal },
    );
    retry.abort();
    await assertAwsError(signing ?? Promise.resolve(), ["the key lookup did not finish"]);

    assert.deepEqual(
      calls.map((call) => call.command),
      ["GetPublicKey", "GetPublicKey"],
    );
  });
});
