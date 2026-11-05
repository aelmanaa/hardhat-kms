import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import * as kms from "@google-cloud/kms";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import gax from "google-gax";
import hardhatKms from "hardhat-kms";
import { crc32c } from "hardhat-kms/provider-utils";
import type { KmsKeyAdapter, KmsKeyConfig } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatPlugin } from "hardhat/types/plugins";

import hardhatKmsGcp from "../../src/index.ts";
import {
  createGcpKeyAdapter,
  type GaxModule,
  type GcpClientOptions,
} from "../../src/internal/adapter.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { fakeGcpKmsSdk, KEY_VERSION_NAME } from "../helpers/fake-gcp-kms.ts";
import {
  isolateGcpEnvironment,
  type KmsServer,
  localSdk,
  startKmsServer,
} from "../helpers/kms-server.ts";

const secretKey = secp256k1.utils.randomSecretKey();
const signContext = () => ({
  signal: new AbortController().signal,
  displayMessage: async () => {},
  requestId: "r1",
});

let server: KmsServer;
let restoreEnvironment: () => void;
const coreVersion = String(
  Reflect.get(Object(createRequire(import.meta.url)("hardhat-kms/package.json")), "version"),
);
const ownVersion = String(
  Reflect.get(Object(createRequire(import.meta.url)("@hardhat-kms/gcp/package.json")), "version"),
);

async function runtime(plugins: HardhatPlugin[] = [hardhatKmsGcp], local = true) {
  const hre = await createHardhatRuntimeEnvironment({
    plugins,
    kms: {
      keys: {
        deployer: { provider: "gcp", keyVersionName: KEY_VERSION_NAME },
        parts: {
          provider: "gcp",
          projectId: "p",
          location: "europe-west1",
          keyRing: "r",
          keyName: "deployer",
          keyVersion: 1,
        },
        amazon: { provider: "aws", keyId: "alias/deployer", region: "eu-west-1" },
        hsm: { provider: "gcp", keyVersionName: KEY_VERSION_NAME, protectionLevel: "HSM" },
        software: {
          provider: "gcp",
          keyVersionName: KEY_VERSION_NAME,
          protectionLevel: "SOFTWARE",
        },
      },
    },
  });
  if (local) {
    // Run-time handlers run first: the plugin's own handler, with the SDK pointed at the server.
    hre.hooks.registerHandlers(
      "kms",
      kmsHandlers(ownVersion, async () => localSdk(server.port)),
    );
  }
  return hre;
}

/** Runs the `kms` hook chain the way hardhat-kms does, recording the keys that reach its end. */
async function createAdapter(
  hre: Awaited<ReturnType<typeof runtime>>,
  name: string,
  unclaimed: string[] = [],
): Promise<KmsKeyAdapter> {
  const key = hre.config.kms.keys[name];
  assert.ok(key);
  return await hre.hooks.runHandlerChain(
    "kms",
    "createKeyAdapter",
    [key],
    async (_context, rest: KmsKeyConfig) => {
      unclaimed.push(rest.displayId);
      return await Promise.reject(new Error("unclaimed"));
    },
  );
}

/**
 * Runs `use` with an adapter on the real SDK, pointed at the local server, whose credentials
 * come from a `GOOGLE_APPLICATION_CREDENTIALS` file that does not exist until `use` writes it.
 * Then closes the adapter and checks that nothing was left unhandled or printed: the SDK prints
 * some failures with console.error, the credentials file's path included.
 */
async function withCredentialsFile(
  use: (adapter: KmsKeyAdapter, write: () => void, directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "hardhat-kms-gcp-credentials-"));
  const keyFilename = join(directory, "service-account.json");
  const write = (): void => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(
      keyFilename,
      JSON.stringify({
        type: "service_account",
        client_email: "hardhat-kms-test@example.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      }),
    );
  };
  class KeyManagementServiceClient extends kms.KeyManagementServiceClient {
    public constructor(options: GcpClientOptions, gaxModule?: GaxModule) {
      super(
        { ...options, apiEndpoint: "127.0.0.1", port: server.port, protocol: "http" },
        gaxModule,
      );
    }
  }
  const saved = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFilename;
  const unhandled: unknown[] = [];
  const record = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", record);
  const printed = mock.method(console, "error", () => {});
  const adapter = await createGcpKeyAdapter(
    {
      provider: "gcp",
      name: "deployer",
      keyVersionName: { get: async () => await Promise.resolve(KEY_VERSION_NAME), display: "v" },
      timeoutMs: 10_000,
      displayId: "gcp:v",
    },
    { KeyManagementServiceClient, gax },
    `hardhat-kms/${ownVersion}`,
  );
  try {
    await use(adapter, write, directory);
    await adapter.close?.();
    // An unhandled rejection is reported on a later turn of the event loop.
    await sleep(50);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(
      printed.mock.calls.map(({ arguments: args }) => args),
      [],
    );
  } finally {
    printed.mock.restore();
    process.off("unhandledRejection", record);
    if (saved === undefined) {
      Reflect.deleteProperty(process.env, "GOOGLE_APPLICATION_CREDENTIALS");
    } else {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = saved;
    }
    await adapter.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The details of a 403 as Google sends it: the ErrorInfo's metadata and the Help link name the
 * consumer project, which no message may show.
 */
const permissionDeniedDetails = (reason: string): unknown[] => [
  {
    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
    reason,
    domain: "googleapis.com",
    metadata: { consumer: "projects/secret-project", service: "cloudkms.googleapis.com" },
  },
  {
    "@type": "type.googleapis.com/google.rpc.Help",
    links: [{ description: "x", url: "https://console.cloud.google.com?project=secret-project" }],
  },
];

describe("@hardhat-kms/gcp plugin", () => {
  before(async () => {
    server = await startKmsServer(secretKey);
    restoreEnvironment = isolateGcpEnvironment();
  });

  after(async () => {
    restoreEnvironment();
    await server.close();
  });

  it("loads hardhat-kms through its plugin dependency", async () => {
    const hre = await runtime();

    assert.equal(hre.config.kms.keys.deployer?.provider, "gcp");
    const both = await runtime([hardhatKms, hardhatKmsGcp]);
    assert.equal(both.config.kms.keys.deployer?.provider, "gcp");
  });

  it("claims gcp keys with its own handler and passes other keys on", async () => {
    const hre = await runtime([hardhatKmsGcp], false);
    const unclaimed: string[] = [];

    // The plugin's handler with the real SDK: the adapter creates no client and makes no call.
    const adapter = await createAdapter(hre, "deployer", unclaimed);
    assert.equal(adapter.describe().provider, "gcp");
    await adapter.close?.();
    await assert.rejects(createAdapter(hre, "amazon", unclaimed), /unclaimed/);
    assert.deepEqual(unclaimed, ["aws:alias/deployer"]);
  });

  it("gives the client the key's project in every config form", async () => {
    process.env.HHKMS_GCP_FORM_NAME =
      "projects/123456789012/locations/global/keyRings/r/cryptoKeys/k/cryptoKeyVersions/2";
    process.env.HHKMS_GCP_FORM_PROJECT = "example.com:scoped";
    try {
      const hre = await createHardhatRuntimeEnvironment({
        plugins: [hardhatKmsGcp],
        kms: {
          keys: {
            name: { provider: "gcp", keyVersionName: KEY_VERSION_NAME },
            nameVariable: {
              provider: "gcp",
              keyVersionName: configVariable("HHKMS_GCP_FORM_NAME"),
            },
            parts: {
              provider: "gcp",
              projectId: "parts-project",
              location: "global",
              keyRing: "r",
              keyName: "k",
              keyVersion: 1,
            },
            partsVariable: {
              provider: "gcp",
              projectId: configVariable("HHKMS_GCP_FORM_PROJECT"),
              location: "global",
              keyRing: "r",
              keyName: "k",
              keyVersion: "1",
            },
          },
        },
      });
      const fake = fakeGcpKmsSdk({ secretKey });
      hre.hooks.registerHandlers(
        "kms",
        kmsHandlers(ownVersion, async () => await Promise.resolve(fake.sdk)),
      );
      const projects: unknown[] = [];
      for (const name of ["name", "nameVariable", "parts", "partsVariable"]) {
        const adapter = await createAdapter(hre, name);
        // The fake answers with its own key version name, so only the client's options count.
        await adapter.getPublicKey?.(signContext()).catch(() => {});
        await adapter.close?.();
        projects.push(fake.clients.at(-1)?.options.projectId);
      }
      assert.deepEqual(projects, ["p", "123456789012", "parts-project", "example.com:scoped"]);
    } finally {
      Reflect.deleteProperty(process.env, "HHKMS_GCP_FORM_NAME");
      Reflect.deleteProperty(process.env, "HHKMS_GCP_FORM_PROJECT");
    }
  });

  it("signs through the real SDK over REST, with the version name and CRC32C", async () => {
    const hre = await runtime();
    for (const name of ["deployer", "parts"]) {
      const adapter = await createAdapter(hre, name);
      const ctx = signContext();
      const digest = new Uint8Array(32).fill(5);
      server.requests.length = 0;

      const publicKey = await adapter.getPublicKey?.(ctx);
      const signature = await adapter.signDigest?.({ digest }, ctx);
      await adapter.close?.();

      assert.deepEqual(publicKey, secp256k1.getPublicKey(secretKey, false));
      assert.ok(signature !== undefined && "format" in signature && signature.format === "der");
      // The server returns high S: the adapter hands it to the core as it came.
      const parsed = secp256k1.Signature.fromBytes(signature.bytes, "der");
      assert.ok(parsed.hasHighS());
      assert.ok(
        secp256k1.verify(parsed.toBytes("compact"), digest, secp256k1.getPublicKey(secretKey), {
          prehash: false,
          lowS: false,
        }),
      );
      assert.deepEqual(
        server.requests.map(({ method, path }) => [method, path]),
        [
          ["GET", `/v1/${KEY_VERSION_NAME}/publicKey`],
          ["POST", `/v1/${KEY_VERSION_NAME}:asymmetricSign`],
        ],
      );
      const sign = server.requests[1]?.body;
      assert.deepEqual(sign?.digest, { sha256: Buffer.from(digest).toString("base64") });
      assert.equal(sign?.digestCrc32c, String(crc32c(digest)));
      assert.match(String(server.requests[0]?.headers.authorization), /^Bearer /);
      // Both requests start their user agent with the plugin's tag, before google-auth-library's
      // own, and Cloud Audit Logs records it as `callerSuppliedUserAgent`.
      for (const { headers } of server.requests) {
        assert.ok(String(headers["user-agent"]).startsWith(`hardhat-kms/${ownVersion} `));
        assert.match(String(headers["user-agent"]), / google-api-nodejs-client\//);
      }
    }
  });

  it("reads the protection level through the real SDK, and refuses another one before signing (#637)", async () => {
    const hre = await runtime();
    const digest = new Uint8Array(32).fill(5);
    // The server sends the level as the number 2, as Cloud KMS does for `enum-encoding=int`.
    for (const name of ["deployer", "hsm"]) {
      const adapter = await createAdapter(hre, name);
      await adapter.getPublicKey?.(signContext());
      assert.equal(adapter.protectionLevel?.(), "HSM");
      assert.ok((await adapter.signDigest?.({ digest }, signContext())) !== undefined);
      await adapter.close?.();
    }

    const adapter = await createAdapter(hre, "software");
    server.requests.length = 0;
    await assert.rejects(
      adapter.signDigest?.({ digest }, signContext()) ?? Promise.resolve(),
      /the key version's protection level is HSM, not SOFTWARE as the key's protectionLevel requires/,
    );
    await adapter.close?.();
    assert.deepEqual(
      server.requests.map(({ method }) => method),
      ["GET"],
    );
  });

  it("asks again after a corrupted signature checksum from the real SDK", async () => {
    const hre = await runtime();
    const adapter = await createAdapter(hre, "deployer");
    await adapter.getPublicKey?.(signContext());
    server.requests.length = 0;
    server.faults.corruptSignatureCrc32c = 2;

    await adapter.signDigest?.({ digest: new Uint8Array(32).fill(6) }, signContext());
    await adapter.close?.();

    assert.equal(server.requests.length, 3);
  });

  it("asks again when Cloud KMS refuses the digest's checksum", async () => {
    const hre = await runtime();
    const adapter = await createAdapter(hre, "deployer");
    await adapter.getPublicKey?.(signContext());
    server.requests.length = 0;
    server.faults.corruptDigest = 2;

    await adapter.signDigest?.({ digest: new Uint8Array(32).fill(7) }, signContext());
    await adapter.close?.();

    assert.equal(server.requests.length, 3);
  });

  it("looks the credentials up again after the real SDK failed to load them", async () => {
    // The SDK keeps the rejected promise of its first initialize(): the adapter must replace the
    // client, or the call after the credentials file appears still fails.
    await withCredentialsFile(async (adapter, write, directory) => {
      await assert.rejects(adapter.getPublicKey?.(signContext()) ?? Promise.resolve(), (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("gcp, connect,"), error.message);
        assert.ok(
          error.message.includes("the credentials file GOOGLE_APPLICATION_CREDENTIALS names"),
          error.message,
        );
        assert.ok(!error.message.includes(directory), error.message);
        return true;
      });

      write();
      server.requests.length = 0;
      assert.deepEqual(
        await adapter.getPublicKey?.(signContext()),
        secp256k1.getPublicKey(secretKey, false),
      );
      assert.equal(server.requests.length, 1);
    });
  });

  it("creates the real SDK's client at the first call, not with the adapter", async () => {
    // A client created with the adapter starts a credentials lookup at once, for its operations
    // client, and keeps a failure of it: credentials that appear before the first call would
    // work, but closing the client would print the failure.
    await withCredentialsFile(async (adapter, write) => {
      await sleep(0);
      write();
      server.requests.length = 0;
      assert.deepEqual(
        await adapter.getPublicKey?.(signContext()),
        secp256k1.getPublicKey(secretKey, false),
      );
      assert.equal(server.requests.length, 1);
    });
  });

  it("says it could not reach Cloud KMS, without the host, when the connection is refused", async () => {
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKmsGcp],
      kms: { keys: { deployer: { provider: "gcp", keyVersionName: KEY_VERSION_NAME } } },
    });
    // Nothing listens on port 1.
    hre.hooks.registerHandlers(
      "kms",
      kmsHandlers(ownVersion, async () => localSdk(1)),
    );
    const adapter = await createAdapter(hre, "deployer");

    await assert.rejects(adapter.getPublicKey?.(signContext()) ?? Promise.resolve(), (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /could not reach Google Cloud KMS \(ECONNREFUSED\), after 4 attempts/,
      );
      assert.ok(!error.message.includes("127.0.0.1"), error.message);
      return true;
    });
    await adapter.close?.();
  });

  it("sends no more requests once the call's signal aborts", async () => {
    const hre = await runtime();
    const adapter = await createAdapter(hre, "deployer");
    server.requests.length = 0;
    server.faults.error = { http: 503, status: "UNAVAILABLE", message: "try later" };
    try {
      const controller = new AbortController();
      const pending = adapter.getPublicKey?.({ ...signContext(), signal: controller.signal });
      while (server.requests.length === 0) {
        await sleep(5);
      }
      controller.abort();
      await assert.rejects(pending ?? Promise.resolve());
      // The SDK's own retries are off, and the adapter does not start another attempt.
      await sleep(1000);
      assert.equal(server.requests.length, 1);
    } finally {
      server.faults.error = undefined;
      await adapter.close?.();
    }
  });

  it("closes a sign request the call abandoned, before its deadline (#651)", async () => {
    const hre = await runtime();
    const adapter = await createAdapter(hre, "deployer");
    try {
      await adapter.getPublicKey?.(signContext());
      server.requests.length = 0;
      server.faults.holdSign = true;
      const controller = new AbortController();
      const started = Date.now();
      const pending = adapter.signDigest?.(
        { digest: new Uint8Array(32).fill(7) },
        { ...signContext(), signal: controller.signal },
      );
      while (server.requests.length === 0) {
        await sleep(5);
      }
      controller.abort();
      await assert.rejects(pending ?? Promise.resolve());
      // The key's timeoutMs is the default 30 s: the request is closed long before its deadline.
      while (server.closedUnanswered() === 0 && Date.now() - started < 5000) {
        await sleep(5);
      }
      assert.equal(server.closedUnanswered(), 1);
      assert.ok(Date.now() - started < 5000);
      assert.equal(server.requests.length, 1);
    } finally {
      server.faults.holdSign = undefined;
      await adapter.close?.();
    }
  });

  it("explains the errors the real SDK reports, without the server's message", async () => {
    const hre = await runtime();
    const cases: Array<[number, string, string]> = [
      [404, "NOT_FOUND", "the key version was not found (NOT_FOUND)"],
      [400, "FAILED_PRECONDITION", "may be disabled, destroyed or scheduled for destruction"],
      [403, "PERMISSION_DENIED", "permission denied (PERMISSION_DENIED)"],
    ];
    try {
      for (const [http, status, message] of cases) {
        server.faults.error = { http, status, message: "projects/secret-project is DISABLED" };
        const adapter = await createAdapter(hre, "deployer");
        await assert.rejects(
          adapter.getPublicKey?.(signContext()) ?? Promise.resolve(),
          (error) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes(`gcp, get public key, key gcp:`), error.message);
            assert.ok(error.message.includes(message), error.message);
            assert.ok(!error.message.includes("secret-project"), error.message);
            return true;
          },
        );
        await adapter.close?.();
      }
    } finally {
      server.faults.error = undefined;
    }
  });

  it("names the key version state Cloud KMS gives with FAILED_PRECONDITION", async () => {
    const hre = await runtime();
    const name = "projects/secret-project/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1";
    const cases: Array<[string, string]> = [
      [
        `The request cannot be fulfilled. Resource ${name} has value PENDING_GENERATION in field crypto_key_version.state.`,
        "the key version is still being generated (FAILED_PRECONDITION, PENDING_GENERATION). Retry in a minute",
      ],
      [
        `The request cannot be fulfilled. Resource ${name} has value DISABLED in field crypto_key_version.state.`,
        "its state is DISABLED, and only an ENABLED version signs (FAILED_PRECONDITION)",
      ],
      [
        `${name} is not enabled, current state is: DESTROY_SCHEDULED.`,
        "its state is DESTROY_SCHEDULED, and only an ENABLED version signs (FAILED_PRECONDITION)",
      ],
      [
        `Resource ${name} has crypto_key_version.state: DESTROYED, but ENABLED is required.`,
        "its state is DESTROYED, and only an ENABLED version signs (FAILED_PRECONDITION)",
      ],
      [`${name} cannot be used`, "may be disabled, destroyed or scheduled for destruction"],
    ];
    try {
      for (const [serverMessage, message] of cases) {
        server.faults.error = { http: 400, status: "FAILED_PRECONDITION", message: serverMessage };
        const adapter = await createAdapter(hre, "deployer");
        await assert.rejects(
          adapter.getPublicKey?.(signContext()) ?? Promise.resolve(),
          (error) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes(message), error.message);
            assert.ok(!error.message.includes("secret-project"), error.message);
            return true;
          },
        );
        await adapter.close?.();
      }
    } finally {
      server.faults.error = undefined;
    }
  });

  it("does not take a proxy's 4xx page for Cloud KMS's FAILED_PRECONDITION", async () => {
    const hre = await runtime();
    const cases = [
      { http: 412, contentType: "text/html", body: "<html>secret-proxy blocked DISABLED</html>" },
      { http: 407, contentType: "text/html", body: "<html>secret-proxy needs a login</html>" },
      { http: 418, contentType: "text/plain", body: "" },
    ];
    try {
      for (const page of cases) {
        server.faults.page = page;
        const adapter = await createAdapter(hre, "deployer");
        await assert.rejects(
          adapter.getPublicKey?.(signContext()) ?? Promise.resolve(),
          (error) => {
            assert.ok(error instanceof Error);
            assert.ok(
              error.message.includes(
                `the request was refused with HTTP ${page.http}, by something other than Google Cloud KMS`,
              ),
              error.message,
            );
            assert.ok(!error.message.includes("secret-proxy"), error.message);
            assert.ok(!error.message.includes("FAILED_PRECONDITION"), error.message);
            return true;
          },
        );
        await adapter.close?.();
      }
    } finally {
      server.faults.page = undefined;
    }
  });

  it("names a disabled API or an unusable quota project from the 403's ErrorInfo reason", async () => {
    const hre = await runtime();
    const cases: Array<[unknown[] | undefined, string]> = [
      [
        permissionDeniedDetails("SERVICE_DISABLED"),
        "the Cloud KMS API is not enabled in the project the request is billed to (PERMISSION_DENIED, SERVICE_DISABLED). Enable it with `gcloud services enable cloudkms.googleapis.com --project p`",
      ],
      [
        permissionDeniedDetails("USER_PROJECT_DENIED"),
        "the quota project of the Google Cloud credentials cannot be used (PERMISSION_DENIED, USER_PROJECT_DENIED). Pick another with `gcloud auth application-default set-quota-project`",
      ],
      [
        permissionDeniedDetails("CONSUMER_INVALID"),
        "the quota project of the Google Cloud credentials cannot be used (PERMISSION_DENIED, CONSUMER_INVALID)",
      ],
      // Any other reason, or none, keeps the IAM hint.
      [
        permissionDeniedDetails("IAM_PERMISSION_DENIED"),
        "permission denied (PERMISSION_DENIED). The caller needs",
      ],
      [undefined, "permission denied (PERMISSION_DENIED). The caller needs"],
    ];
    try {
      for (const [errorDetails, message] of cases) {
        server.faults.error = {
          http: 403,
          status: "PERMISSION_DENIED",
          message: "Cloud KMS API has not been used in project secret-project before",
          details: errorDetails,
        };
        const adapter = await createAdapter(hre, "deployer");
        for (const call of [
          () => adapter.getPublicKey?.(signContext()),
          () => adapter.signDigest?.({ digest: new Uint8Array(32) }, signContext()),
        ]) {
          await assert.rejects(call() ?? Promise.resolve(), (error) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes(message), error.message);
            assert.ok(!error.message.includes("secret-project"), error.message);
            return true;
          });
        }
        await adapter.close?.();
      }
    } finally {
      server.faults.error = undefined;
    }
  });

  it("refuses gcp keys when hardhat-kms is another version, and passes other keys on", async () => {
    const hre = await runtime([hardhatKmsGcp], false);
    hre.hooks.registerHandlers("kms", kmsHandlers("9.9.9"));
    const unclaimed: string[] = [];

    await assert.rejects(createAdapter(hre, "deployer"), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes(
          `gcp, create adapter, key gcp:${KEY_VERSION_NAME}: @hardhat-kms/gcp 9.9.9 needs hardhat-kms 9.9.9, but hardhat-kms ${coreVersion} is installed`,
        ),
        error.message,
      );
      assert.ok(
        error.message.includes("npm install --save-dev hardhat-kms@9.9.9 @hardhat-kms/gcp@9.9.9"),
      );
      return true;
    });
    await assert.rejects(createAdapter(hre, "amazon", unclaimed), /unclaimed/);
    assert.equal(unclaimed.length, 1);
  });
});
