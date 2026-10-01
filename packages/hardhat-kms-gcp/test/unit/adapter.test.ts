import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { crc32c } from "hardhat-kms/provider-utils";
import type { GcpKmsKeyConfig } from "hardhat-kms/types";
import { HardhatPluginError } from "hardhat/plugins";

import { CHECKSUM_RETRIES, createGcpKeyAdapter } from "../../src/internal/adapter.ts";
import {
  fakeGcpKmsSdk,
  type FakeKmsOptions,
  googleError,
  KEY_VERSION_NAME,
} from "../helpers/fake-gcp-kms.ts";

const secretKey = secp256k1.utils.randomSecretKey();
const publicKey = secp256k1.getPublicKey(secretKey, false);
const context = (signal: AbortSignal = new AbortController().signal) => ({
  signal,
  displayMessage: async () => {},
  requestId: "r1",
});
const digest = new Uint8Array(32).fill(9);
const ATTEMPTS = CHECKSUM_RETRIES + 1;

it("retries a checksum mismatch at most three times, as the docs say", () => {
  assert.equal(CHECKSUM_RETRIES, 3);
});

/** A resolved Google Cloud key, as hardhat-kms passes it to the adapter. */
function gcpKey(name = KEY_VERSION_NAME, display = name): GcpKmsKeyConfig {
  return {
    provider: "gcp",
    name: "deployer",
    keyVersionName: { get: async () => await Promise.resolve(name), display },
    timeoutMs: 1234,
    displayId: `gcp:${display}`,
  };
}

async function adapterFor(options: Partial<FakeKmsOptions> = {}, key = gcpKey()) {
  const fake = fakeGcpKmsSdk({ secretKey, ...options });
  const adapter = await createGcpKeyAdapter(key, fake.sdk);
  const methods = (method: string) => fake.calls.filter((call) => call.method === method).length;
  return { adapter, methods, ...fake };
}

async function assertGcpError(promise: Promise<unknown>, includes: string[]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    for (const part of includes) {
      assert.ok(error.message.includes(part), `"${error.message}" should include "${part}"`);
    }
    return true;
  });
}

async function sign(adapter: Awaited<ReturnType<typeof adapterFor>>["adapter"]) {
  return await (adapter.signDigest?.({ digest }, context()) ?? Promise.resolve(undefined));
}

async function lookUp(adapter: Awaited<ReturnType<typeof adapterFor>>["adapter"]) {
  return await (adapter.getPublicKey?.(context()) ?? Promise.resolve(undefined));
}

describe("Google Cloud KMS adapter", () => {
  it("reads the PEM public key and returns the DER signature of the digest, unchanged", async () => {
    for (const [highS, int64Form] of [
      [false, "string"],
      [true, "number"],
    ] as const) {
      const { adapter } = await adapterFor({ highS, int64Form });

      assert.deepEqual(await lookUp(adapter), publicKey);
      const signature = await sign(adapter);
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

  it("signs the digest with the configured version, its CRC32C and the key's timeout", async () => {
    const { adapter, calls, clients } = await adapterFor();
    await lookUp(adapter);
    await sign(adapter);

    assert.deepEqual(clients[0]?.options, { fallback: true });
    assert.deepEqual(
      calls.map(({ method, request }) => [method, request.name]),
      [
        ["getPublicKey", KEY_VERSION_NAME],
        ["asymmetricSign", KEY_VERSION_NAME],
      ],
    );
    assert.deepEqual(calls[1]?.request.digest, { sha256: digest });
    assert.deepEqual(calls[1]?.request.digestCrc32c, { value: crc32c(digest) });
    assert.ok(calls.every((call) => call.options.timeout === 1234));
  });

  it("looks the key up, and checks its algorithm, if asked to sign first", async () => {
    const { adapter, calls } = await adapterFor();
    await sign(adapter);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["getPublicKey", "asymmetricSign"],
    );

    const wrong = await adapterFor({ algorithm: "EC_SIGN_P256_SHA256" });
    await assertGcpError(sign(wrong.adapter), ["is EC_SIGN_P256_SHA256"]);
    assert.equal(wrong.methods("asymmetricSign"), 0);
  });

  it("describes the key by its display values, and closes the client", async () => {
    const { adapter, clients } = await adapterFor({}, gcpKey(KEY_VERSION_NAME, "<GCP_KEY>"));

    assert.deepEqual(adapter.describe(), {
      provider: "gcp",
      pinnedId: "<GCP_KEY>",
      displayId: "gcp:<GCP_KEY>",
    });
    await adapter.close?.();
    assert.equal(clients[0]?.closed, true);
  });

  describe("refuses key versions and responses that are not what it asked for", () => {
    it("a key version whose algorithm is not EC_SIGN_SECP256K1_SHA256", async () => {
      for (const algorithm of ["EC_SIGN_P256_SHA256", "RSA_SIGN_PSS_2048_SHA256"] as const) {
        const { adapter } = await adapterFor({ algorithm });
        await assertGcpError(lookUp(adapter), [
          "gcp, get public key, key gcp:projects/p/",
          `the key version's algorithm is ${algorithm}, not EC_SIGN_SECP256K1_SHA256`,
          "--protection-level hsm",
        ]);
      }
    });

    it("a public key for another key version, without asking again", async () => {
      const { adapter, methods } = await adapterFor({
        publicKeyName: KEY_VERSION_NAME.replace(/1$/, "2"),
      });
      await assertGcpError(lookUp(adapter), [
        "gcp, get public key,",
        "the response is for another key version than the one requested",
      ]);
      assert.equal(methods("getPublicKey"), 1);
    });

    it("a signature from another key version, without asking again", async () => {
      const { adapter, methods } = await adapterFor({
        signName: KEY_VERSION_NAME.replace("deployer", "other"),
      });
      await assertGcpError(sign(adapter), [
        "gcp, sign,",
        "the response is for another key version than the one requested",
      ]);
      assert.equal(methods("asymmetricSign"), 1);
    });

    it("a response without a public key or a signature", async () => {
      await assertGcpError(lookUp((await adapterFor({ omitPem: true })).adapter), [
        "the response has no public key",
      ]);
      await assertGcpError(sign((await adapterFor({ omitSignature: true })).adapter), [
        "the response has no signature",
      ]);
    });
  });

  describe("CRC32C", () => {
    // Each check: the fault, the method it affects, and the error after the last attempt.
    const checks: Array<[string, Partial<FakeKmsOptions>, Partial<FakeKmsOptions>, string]> = [
      [
        "pemCrc32c",
        { corruptPemCrc32c: 2 },
        { corruptPemCrc32c: Infinity },
        "the public key does not match its checksum (pemCrc32c)",
      ],
      [
        "verifiedDigestCrc32c",
        { unverifiedDigest: 2 },
        { unverifiedDigest: Infinity },
        "did not confirm the digest's checksum (verifiedDigestCrc32c)",
      ],
      [
        "signatureCrc32c",
        { corruptSignatureCrc32c: 2 },
        { corruptSignatureCrc32c: Infinity },
        "the signature does not match its checksum (signatureCrc32c)",
      ],
    ];
    for (const [field, transient, persistent, message] of checks) {
      const method = field === "pemCrc32c" ? "getPublicKey" : "asymmetricSign";
      const run = async (adapter: Awaited<ReturnType<typeof adapterFor>>["adapter"]) =>
        field === "pemCrc32c" ? await lookUp(adapter) : await sign(adapter);

      it(`asks again after a ${field} mismatch`, async () => {
        const { adapter, methods } = await adapterFor(transient);
        await run(adapter);
        assert.equal(methods(method), 3);
      });

      it(`fails after ${ATTEMPTS} attempts when ${field} never matches`, async () => {
        const { adapter, methods } = await adapterFor(persistent);
        await assertGcpError(run(adapter), [message, `after ${ATTEMPTS} attempts`]);
        assert.equal(methods(method), ATTEMPTS);
      });
    }

    it("treats a missing checksum or confirmation as a mismatch, never as a pass", async () => {
      const missing: Array<[Partial<FakeKmsOptions>, "getPublicKey" | "asymmetricSign", string]> = [
        [{ omitPemCrc32c: true }, "getPublicKey", "pemCrc32c"],
        [{ omitVerifiedDigest: true }, "asymmetricSign", "verifiedDigestCrc32c"],
        [{ omitSignatureCrc32c: true }, "asymmetricSign", "signatureCrc32c"],
      ];
      for (const [options, method, field] of missing) {
        const { adapter, methods } = await adapterFor(options);
        const run = method === "getPublicKey" ? lookUp(adapter) : sign(adapter);
        await assertGcpError(run, [field]);
        assert.equal(methods(method), ATTEMPTS, field);
      }
    });

    it("stops asking again once the call's signal is aborted", async () => {
      const { adapter, methods } = await adapterFor({ corruptSignatureCrc32c: Infinity });
      await lookUp(adapter);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        adapter.signDigest?.({ digest }, context(controller.signal)) ?? Promise.resolve(),
        (error: unknown) => {
          assert.ok(error instanceof HardhatPluginError);
          assert.ok(error.message.includes("signatureCrc32c"), error.message);
          assert.ok(!error.message.includes("attempts"), error.message);
          return true;
        },
      );
      assert.equal(methods("asymmetricSign"), 1);
    });
  });

  describe("errors", () => {
    const statuses: Array<[number, string]> = [
      [5, "the key version was not found (NOT_FOUND)"],
      [7, "permission denied (PERMISSION_DENIED)"],
      [9, "may be disabled, destroyed or scheduled for destruction"],
      [16, "credentials were refused (UNAUTHENTICATED)"],
      [8, "throttling requests (RESOURCE_EXHAUSTED)"],
      [4, "did not answer in time (DEADLINE_EXCEEDED)"],
      [13, "the Google Cloud KMS call failed (INTERNAL)"],
    ];
    for (const [code, message] of statuses) {
      it(`explains status ${code} without the server's message`, async () => {
        const secret = "projects/secret-project/locations/l/keyRings/r";
        const { adapter } = await adapterFor({ callError: googleError(code, secret) });
        await assert.rejects(lookUp(adapter), (error: unknown) => {
          assert.ok(error instanceof HardhatPluginError);
          assert.ok(error.message.includes(`gcp, get public key, key gcp:`), error.message);
          assert.ok(error.message.includes(message), error.message);
          assert.ok(!error.message.includes("secret-project"), error.message);
          return true;
        });
      });
    }

    it("explains missing Application Default Credentials", async () => {
      const { adapter } = await adapterFor({
        callError: new Error(
          "Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.",
        ),
      });
      await assertGcpError(lookUp(adapter), [
        "gcp, connect,",
        "no Google Cloud credentials found",
        "gcloud auth application-default login",
      ]);
    });

    it("passes other errors on unchanged", async () => {
      for (const error of [new Error("socket hang up"), googleError(99, "?")]) {
        const { adapter } = await adapterFor({ callError: error });
        await assert.rejects(lookUp(adapter), (thrown) => thrown === error);
      }
    });
  });

  it("does not trust the algorithm check of a call that was abandoned", async () => {
    const hang = new AbortController();
    const { adapter, methods } = await adapterFor({ hangPublicKey: { signal: hang.signal } });
    const pending = adapter.getPublicKey?.(context(hang.signal));
    hang.abort();
    assert.deepEqual(await pending, publicKey);
    // The fake answers at once now that its signal fired; the signing call's signal is aborted
    // too, so its own lookup is abandoned as well and nothing is signed.
    await assertGcpError(
      adapter.signDigest?.({ digest }, context(hang.signal)) ?? Promise.resolve(),
      ["the key lookup did not finish"],
    );
    assert.equal(methods("getPublicKey"), 2);
    assert.equal(methods("asymmetricSign"), 0);
  });
});
