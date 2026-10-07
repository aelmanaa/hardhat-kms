import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import gax from "google-gax";
import { crc32c } from "hardhat-kms/provider-utils";
import type { GcpKmsKeyConfig } from "hardhat-kms/types";
import { HardhatPluginError } from "hardhat/plugins";

import { createGcpKeyAdapter, MAX_RETRIES } from "../../src/internal/adapter.ts";
import {
  gaxiosError,
  projectLookupRefused,
  SECRET_CLAIM,
  SECRET_PROJECT_NUMBER,
  tokenExchangeRefused,
} from "../helpers/auth-errors.ts";
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
const USER_AGENT = "hardhat-kms/1.2.3";
const ATTEMPTS = MAX_RETRIES + 1;

/** UNAVAILABLE with a refused connection under it, as the SDK reports one over REST. */
const refused = (): Error =>
  Object.assign(googleError(14, "request to http://kms.example failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
      code: "ECONNREFUSED",
    }),
  });

it("retries a failed call at most three times, as the docs say", () => {
  assert.equal(MAX_RETRIES, 3);
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
  const adapter = await createGcpKeyAdapter(key, fake.sdk, USER_AGENT);
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

/** Checks that a rejection names neither the project number nor the token's claims. */
function assertNoSecrets(error: unknown): void {
  assert.ok(error instanceof HardhatPluginError, String(error));
  assert.doesNotMatch(error.message, new RegExp(SECRET_PROJECT_NUMBER));
  assert.doesNotMatch(
    error.message,
    /acme-secret|audience does not match|cloudresourcemanager\.googleapis\.com\/v1/,
  );
  assert.ok(!error.message.includes(SECRET_CLAIM), error.message);
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

    // The key's project, so that google-auth-library never looks it up.
    assert.deepEqual(clients[0]?.options, { fallback: true, projectId: "p" });
    // The client runs on this package's google-gax (^6.5.0), which enforces the deadline.
    assert.equal(clients[0]?.gax, gax);
    assert.deepEqual(
      calls.map(({ method, request }) => [method, request.name]),
      [
        ["getPublicKey", KEY_VERSION_NAME],
        ["asymmetricSign", KEY_VERSION_NAME],
      ],
    );
    assert.deepEqual(calls[1]?.request.digest, { sha256: digest });
    assert.deepEqual(calls[1]?.request.digestCrc32c, { value: crc32c(digest) });
    // The key's timeout as gax's deadline, no SDK retries (the adapter's loop is the only one), and
    // the plugin's user agent.
    for (const call of calls) {
      assert.deepEqual(call.options, {
        timeout: 1234,
        retry: null,
        otherArgs: { headers: { "User-Agent": USER_AGENT } },
      });
    }
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
    // The first call creates the client: its constructor starts a credentials lookup.
    assert.equal(clients.length, 0);
    await adapter.close?.();
    assert.equal(clients.length, 0);

    await lookUp(adapter);
    await adapter.close?.();
    assert.deepEqual(
      clients.map(({ closed }) => closed),
      [1],
    );
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

    // Another version, a version with the configured one as a prefix, an empty name and none.
    const otherNames = [
      KEY_VERSION_NAME.replace(/1$/, "2"),
      `${KEY_VERSION_NAME}0`,
      KEY_VERSION_NAME.replace("deployer", "other"),
      "",
      null,
    ];

    it("a public key for another key version, without asking again", async () => {
      for (const publicKeyName of otherNames) {
        const { adapter, methods } = await adapterFor({ publicKeyName });
        await assertGcpError(lookUp(adapter), [
          "gcp, get public key,",
          "the response is for another key version than the one requested",
        ]);
        assert.equal(methods("getPublicKey"), 1, String(publicKeyName));
      }
    });

    it("a signature from another key version, without asking again", async () => {
      for (const signName of otherNames) {
        const { adapter, methods } = await adapterFor({ signName });
        await assertGcpError(sign(adapter), [
          "gcp, sign,",
          "the response is for another key version than the one requested",
        ]);
        assert.equal(methods("asymmetricSign"), 1, String(signName));
      }
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

    it("counts a digest refused for its checksum (INVALID_ARGUMENT) as a mismatch", async () => {
      const digestRefused = googleError(
        3,
        "The checksum in field digest_crc32c did not match the data in field digest.",
      );
      const { adapter, methods } = await adapterFor({
        failFirst: { method: "asymmetricSign", error: digestRefused, times: 2 },
      });
      await sign(adapter);
      assert.equal(methods("asymmetricSign"), 3);

      const persistent = await adapterFor({
        failFirst: { method: "asymmetricSign", error: digestRefused, times: Infinity },
      });
      await assertGcpError(sign(persistent.adapter), [
        "Google Cloud KMS refused the digest's checksum (digestCrc32c, INVALID_ARGUMENT)",
        `after ${ATTEMPTS} attempts`,
        "Data is being corrupted",
      ]);
      assert.equal(persistent.methods("asymmetricSign"), ATTEMPTS);

      // Any other INVALID_ARGUMENT is not retried.
      const other = await adapterFor({ callError: googleError(3, "bad request") });
      await assertGcpError(lookUp(other.adapter), [
        "the Google Cloud KMS call failed (INVALID_ARGUMENT)",
      ]);
      assert.equal(other.methods("getPublicKey"), 1);
    });
  });

  describe("unavailable service", () => {
    it("asks again after a pause, and passes when the service comes back", async () => {
      const { adapter, methods } = await adapterFor({
        failFirst: { method: "getPublicKey", error: refused(), times: 2 },
      });
      assert.deepEqual(await lookUp(adapter), publicKey);
      assert.equal(methods("getPublicKey"), 3);
    });

    it("names the network error, not the host, after the last attempt", async () => {
      const { adapter, methods } = await adapterFor({ callError: refused() });
      await assert.rejects(lookUp(adapter), (error: unknown) => {
        assert.ok(error instanceof HardhatPluginError);
        assert.ok(
          error.message.includes(
            `could not reach Google Cloud KMS (ECONNREFUSED), after ${ATTEMPTS} attempts. Check the network connection`,
          ),
          error.message,
        );
        assert.ok(!error.message.includes("10.0.0.1") && !error.message.includes("kms.example"));
        return true;
      });
      assert.equal(methods("getPublicKey"), ATTEMPTS);

      const plain = await adapterFor({ callError: googleError(14, "unavailable") });
      await assertGcpError(lookUp(plain.adapter), [
        "Google Cloud KMS is unavailable (UNAVAILABLE)",
      ]);
    });

    it("stops asking again when the call's signal aborts during the pause", async () => {
      const { adapter, methods } = await adapterFor({ callError: refused() });
      const controller = new AbortController();
      const pending = adapter.getPublicKey?.(context(controller.signal));
      controller.abort();
      await assert.rejects(pending ?? Promise.resolve(), (error: unknown) => {
        assert.ok(error instanceof HardhatPluginError);
        assert.ok(!error.message.includes("attempts"), error.message);
        return true;
      });
      assert.equal(methods("getPublicKey"), 1);
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

    const UNREADABLE_FILE =
      "Unable to read the credential file specified by the GOOGLE_APPLICATION_CREDENTIALS environment variable: The file at /secret/path/adc.json does not exist, or it is not a file. ENOENT: no such file or directory";

    it("explains a credentials file that cannot be read, without its path", async () => {
      const { adapter } = await adapterFor({ callError: new Error(UNREADABLE_FILE) });
      await assert.rejects(lookUp(adapter), (error: unknown) => {
        assert.ok(error instanceof HardhatPluginError);
        assert.ok(error.message.includes("gcp, connect,"), error.message);
        assert.ok(
          error.message.includes("the credentials file GOOGLE_APPLICATION_CREDENTIALS names"),
          error.message,
        );
        assert.ok(!error.message.includes("/secret/path"), error.message);
        return true;
      });
    });

    it("gives the client the key's project, by id, number or domain-scoped id", async () => {
      const rest = "locations/global/keyRings/r/cryptoKeys/k/cryptoKeyVersions/3";
      for (const project of ["my-project", "123456789012", "example.com:my-project"]) {
        const { adapter, clients } = await adapterFor({}, gcpKey(`projects/${project}/${rest}`));
        await lookUp(adapter).catch(() => {});
        assert.deepEqual(clients[0]?.options, { fallback: true, projectId: project });
      }
      // A name the config check would refuse: no project, so the library looks it up as before.
      const { adapter, clients } = await adapterFor({}, gcpKey("not-a-key-version-name"));
      await lookUp(adapter).catch(() => {});
      assert.deepEqual(clients[0]?.options, { fallback: true });
    });

    it("reports a refused token exchange by its OAuth error code only", async () => {
      // As the SDK rejects a call when the exchange fails: a gRPC status from the HTTP status,
      // with google-auth-library's error as the cause.
      const wrapped = Object.assign(googleError(3, "Error code invalid_grant: …"), {
        cause: tokenExchangeRefused(),
      });
      for (const options of [{ callError: wrapped }, { initializeError: tokenExchangeRefused() }]) {
        const { adapter } = await adapterFor(options);
        await assert.rejects(lookUp(adapter), (error: unknown) => {
          assertNoSecrets(error);
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /gcp, connect, .*the token exchange refused the external credentials \(invalid_grant\)/,
          );
          assert.doesNotMatch(error.message, /INVALID_ARGUMENT/);
          return true;
        });
      }
    });

    it("reports a refused auth request by its status and endpoint, without its path", async () => {
      const cases: Array<[Error, RegExp]> = [
        [
          projectLookupRefused(),
          /gcp, connect, .*the project lookup \(cloudresourcemanager\.googleapis\.com\) answered HTTP 403\. See gcp\.connect\.auth-endpoint in the errors reference$/,
        ],
        [
          gaxiosError(
            "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/x@y.iam.gserviceaccount.com:generateAccessToken",
            403,
          ),
          /service account impersonation \(iamcredentials\.googleapis\.com\) answered HTTP 403\. See gcp\.connect\.auth-endpoint in the errors reference$/,
        ],
      ];
      for (const [refusal, expected] of cases) {
        const { adapter, calls } = await adapterFor({ initializeError: refusal });
        await assert.rejects(lookUp(adapter), (error: unknown) => {
          assertNoSecrets(error);
          assert.ok(error instanceof Error);
          assert.match(error.message, expected);
          assert.doesNotMatch(error.message, /serviceAccounts|x@y/);
          return true;
        });
        assert.equal(calls.length, 0);
      }
    });

    it("asks to log in again when the OAuth token endpoint refuses the login", async () => {
      for (const [status, code] of [
        [400, 3],
        [401, 16],
      ] as const) {
        // As the SDK rejects a call whose token refresh failed.
        const refusal = Object.assign(googleError(code, "invalid_grant"), {
          cause: gaxiosError("https://oauth2.googleapis.com/token", status),
        });
        const { adapter } = await adapterFor({ callError: refusal });
        await assertGcpError(lookUp(adapter), [
          "gcp, get public key,",
          "the Google Cloud credentials were refused (UNAUTHENTICATED). Run `gcloud auth application-default login` again",
        ]);
      }
    });

    it("retries an auth endpoint that is unavailable or throttling, as before", async () => {
      // As the SDK rejects a call whose token request failed with a server error: UNAVAILABLE.
      for (const url of [
        "https://oauth2.googleapis.com/token",
        "https://sts.googleapis.com/v1/token",
      ]) {
        const unavailable = Object.assign(googleError(14, "unavailable"), {
          cause: gaxiosError(url, 503),
        });
        const { adapter, methods } = await adapterFor({ callError: unavailable });
        await assertGcpError(lookUp(adapter), [
          `Google Cloud KMS is unavailable (UNAVAILABLE), after ${ATTEMPTS} attempts`,
        ]);
        assert.equal(methods("getPublicKey"), ATTEMPTS);
      }
      const throttled = Object.assign(googleError(8, "throttled"), {
        cause: gaxiosError("https://sts.googleapis.com/v1/token", 429),
      });
      const { adapter } = await adapterFor({ callError: throttled });
      await assertGcpError(lookUp(adapter), ["throttling requests (RESOURCE_EXHAUSTED)"]);
    });

    it("keeps Cloud KMS's own refusal as its status", async () => {
      const refusal = Object.assign(googleError(7, "denied"), {
        cause: gaxiosError("https://cloudkms.googleapis.com/v1/projects/p/x/publicKey", 403),
      });
      const { adapter } = await adapterFor({ callError: refusal });
      await assertGcpError(lookUp(adapter), ["permission denied (PERMISSION_DENIED)"]);
    });

    it("initializes the client before each call, and makes no call when that fails", async () => {
      const { adapter, calls, clients } = await adapterFor({
        initializeError: new Error(UNREADABLE_FILE),
      });
      for (const attempt of [lookUp(adapter), sign(adapter)]) {
        await assertGcpError(attempt, ["gcp, connect,", "GOOGLE_APPLICATION_CREDENTIALS names"]);
      }
      assert.deepEqual(calls, []);
      // Both calls started together on the client, which failed and was closed once.
      assert.deepEqual(
        clients.map(({ initialized, closed }) => ({ initialized, closed })),
        [{ initialized: 2, closed: 1 }],
      );

      const healthy = await adapterFor();
      await sign(healthy.adapter);
      assert.equal(healthy.clients.length, 1);
      assert.equal(healthy.clients[0]?.initialized, healthy.calls.length);
    });

    it("replaces a client whose initialization failed, so the next call looks up credentials again", async () => {
      // The SDK keeps the first initialize() promise, rejected or not: the same client would
      // fail every later call with the first error.
      const { adapter, clients, methods } = await adapterFor({
        initializeError: new Error(UNREADABLE_FILE),
        initializeFailures: 1,
      });
      await assertGcpError(lookUp(adapter), [
        "gcp, connect,",
        "the credentials file GOOGLE_APPLICATION_CREDENTIALS names could not be read",
      ]);
      assert.equal(methods("getPublicKey"), 0);
      // The failed client is closed, and the next call creates another.
      assert.deepEqual(
        clients.map(({ closed }) => closed),
        [1],
      );

      assert.deepEqual(await lookUp(adapter), publicKey);
      assert.ok((await sign(adapter)) !== undefined);
      assert.equal(clients.length, 2);
      assert.deepEqual(
        clients.map(({ initialized, closed }) => ({ initialized, closed })),
        [
          { initialized: 1, closed: 1 },
          { initialized: 2, closed: 0 },
        ],
      );
      await adapter.close?.();
      assert.equal(clients[1]?.closed, 1);
    });

    it("closes each failed client, however often initialization fails", async () => {
      const { adapter, clients } = await adapterFor({
        initializeError: new Error(UNREADABLE_FILE),
      });
      for (let attempt = 1; attempt <= 5; attempt++) {
        await assertGcpError(lookUp(adapter), ["gcp, connect,"]);
        // One client per attempt, each initialized once and closed.
        assert.deepEqual(
          clients.map(({ initialized, closed }) => ({ initialized, closed })),
          Array.from({ length: attempt }, () => ({ initialized: 1, closed: 1 })),
        );
      }
      await adapter.close?.();
      assert.equal(clients.length, 5);
    });

    it("replaces a failed client once when concurrent calls share it", async () => {
      const { adapter, clients } = await adapterFor({
        initializeError: new Error(UNREADABLE_FILE),
        initializeFailures: 1,
      });
      const results = await Promise.allSettled([lookUp(adapter), lookUp(adapter)]);
      assert.deepEqual(
        results.map(({ status }) => status),
        ["rejected", "rejected"],
      );
      assert.equal(clients.length, 1);
      assert.deepEqual(await lookUp(adapter), publicKey);
      assert.equal(clients.length, 2);
    });

    it("keeps the new client when a call on the failed one learns of the failure late", async () => {
      // Calls 0 and 1 share the first client; call 1 sees its failure 50 ms after call 0 does.
      // Call 2, made in between, creates the second client.
      const { adapter, clients } = await adapterFor({
        initializeError: new Error(UNREADABLE_FILE),
        initializeFailures: 1,
        initializeDelayMs: (call) => (call === 1 ? 50 : 0),
      });
      const early = lookUp(adapter);
      const late = lookUp(adapter);
      await assertGcpError(early, ["gcp, connect,"]);
      assert.deepEqual(await lookUp(adapter), publicKey);
      await assertGcpError(late, ["gcp, connect,"]);

      // The late failure neither closes the first client again nor drops the second.
      assert.deepEqual(await lookUp(adapter), publicKey);
      assert.deepEqual(
        clients.map(({ closed }) => closed),
        [1, 0],
      );
    });

    it("passes other errors on unchanged, and keeps the client", async () => {
      for (const error of [new Error("socket hang up"), googleError(99, "?")]) {
        const { adapter, clients } = await adapterFor({ callError: error });
        await assert.rejects(lookUp(adapter), (thrown) => thrown === error);
        await assert.rejects(lookUp(adapter), (thrown) => thrown === error);
        // Only a failed initialization replaces the client; a failed call does not.
        assert.equal(clients.length, 1);
        assert.equal(clients[0]?.closed, 0);
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
