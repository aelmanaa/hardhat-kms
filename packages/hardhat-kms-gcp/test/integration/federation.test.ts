// Workload identity federation through the real SDK and google-auth-library: an `external_account`
// credentials file whose token exchange and project lookup point at a local server, with no
// project in the environment. The plugin passes the key's project, so the project lookup, which a
// principal with only the key's roles may not call, never happens.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import * as kms from "@google-cloud/kms";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import gax from "google-gax";
import type { GcpKmsKeyConfig, KmsHistoryRequest } from "hardhat-kms/types";

import {
  createGcpKeyAdapter,
  type GaxModule,
  type GcpClientOptions,
} from "../../src/internal/adapter.ts";
import { readGcpSignHistory } from "../../src/internal/history.ts";
import { loadLogging } from "../../src/internal/hook-handlers/kms.ts";
import { SECRET_CLAIM } from "../helpers/auth-errors.ts";
import { isolateGcpEnvironment, type KmsServer, startKmsServer } from "../helpers/kms-server.ts";
import { type LoggingServer, startLoggingServer } from "../helpers/logging-server.ts";

const PROJECT_NUMBER = "987654321098";
const KEY_VERSION_NAME =
  "projects/p/locations/global/keyRings/r/cryptoKeys/deployer/cryptoKeyVersions/1";
const ACCESS_TOKEN = "federated-access-token";
const secretKey = secp256k1.utils.randomSecretKey();

/** Settings that would give google-auth-library a project without the plugin. */
const PROJECT_SETTINGS = [
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "google_cloud_project",
  "gcloud_project",
];

/** The local token exchange and project lookup, and what they received. */
interface AuthServer {
  url: string;
  exchanges: number;
  lookups: number;
  /** Answer the token exchange with this OAuth error instead of a token. */
  refuse: string | undefined;
  /** The HTTP status of that refusal; 400 unless set. */
  refuseStatus: number;
  /** Clears the counts and the refusal. */
  reset(): void;
  close(): Promise<void>;
}

async function startAuthServer(): Promise<AuthServer> {
  const state = {
    exchanges: 0,
    lookups: 0,
    refuse: undefined as string | undefined,
    refuseStatus: 400,
  };
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/token") {
        state.exchanges++;
        if (state.refuse !== undefined) {
          response.statusCode = state.refuseStatus;
          response.end(
            JSON.stringify({ error: state.refuse, error_description: `subject ${SECRET_CLAIM}` }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            access_token: ACCESS_TOKEN,
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
        return;
      }
      // The project lookup: it answers, so a test that sees it can say so instead of hanging.
      state.lookups++;
      response.end(JSON.stringify({ projectId: "looked-up" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    get exchanges() {
      return state.exchanges;
    },
    get lookups() {
      return state.lookups;
    },
    get refuse() {
      return state.refuse;
    },
    set refuse(code) {
      state.refuse = code;
    },
    get refuseStatus() {
      return state.refuseStatus;
    },
    set refuseStatus(status) {
      state.refuseStatus = status;
    },
    reset: () => {
      state.exchanges = 0;
      state.lookups = 0;
      state.refuse = undefined;
      state.refuseStatus = 400;
    },
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

const context = () => ({
  signal: new AbortController().signal,
  displayMessage: async () => {},
  requestId: "r1",
});

function gcpKey(): GcpKmsKeyConfig {
  return {
    provider: "gcp",
    name: "deployer",
    keyVersionName: { get: async () => await Promise.resolve(KEY_VERSION_NAME), display: "v" },
    timeoutMs: 10_000,
    displayId: "gcp:v",
  };
}

/** A one-day history request for the key. */
function historyRequest(): KmsHistoryRequest {
  return {
    key: gcpKey(),
    since: new Date("2026-10-01T00:00:00Z"),
    until: new Date("2026-10-02T00:00:00Z"),
    limit: 1,
  };
}

describe("workload identity federation with no project in the environment", () => {
  let auth: AuthServer;
  let kmsServer: KmsServer;
  let logging: LoggingServer;
  let scratch: string;
  let restoreEnvironment: () => void;

  before(async () => {
    auth = await startAuthServer();
    kmsServer = await startKmsServer(secretKey);
    logging = await startLoggingServer();
  });

  after(async () => {
    await Promise.all([auth.close(), kmsServer.close(), logging.close()]);
  });

  beforeEach(() => {
    restoreEnvironment = isolateGcpEnvironment();
    scratch = mkdtempSync(join(tmpdir(), "hardhat-kms-gcp-federation-"));
    const subjectToken = join(scratch, "subject-token");
    writeFileSync(subjectToken, "external-oidc-token");
    const credentials = join(scratch, "external-account.json");
    writeFileSync(
      credentials,
      JSON.stringify({
        type: "external_account",
        audience: `//iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/pool/providers/github`,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: `${auth.url}/v1/token`,
        cloud_resource_manager_url: `${auth.url}/v1/projects/`,
        credential_source: { file: subjectToken },
      }),
    );
    for (const name of PROJECT_SETTINGS) {
      Reflect.deleteProperty(process.env, name);
    }
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentials;
    // No gcloud on the PATH and no metadata server (its host is a closed local port): without the
    // plugin's project, the library's last resort is the project lookup, which the tests then see.
    process.env.PATH = scratch;
    process.env.METADATA_SERVER_DETECTION = "none";
    process.env.GCE_METADATA_HOST = "127.0.0.1:9";
    auth.reset();
  });

  afterEach(() => {
    restoreEnvironment();
    rmSync(scratch, { recursive: true, force: true });
  });

  /** The real SDK, its requests sent to the local KMS server, its credentials from the file. */
  async function adapter() {
    class KeyManagementServiceClient extends kms.KeyManagementServiceClient {
      public constructor(options: GcpClientOptions, gaxModule?: GaxModule) {
        super(
          { ...options, apiEndpoint: "127.0.0.1", port: kmsServer.port, protocol: "http" },
          gaxModule,
        );
      }
    }
    return await createGcpKeyAdapter(
      gcpKey(),
      { KeyManagementServiceClient, gax },
      "hardhat-kms/test",
    );
  }

  it("signs with the exchanged token and never looks the project up", async () => {
    const sentBefore = kmsServer.requests.length;
    const signer = await adapter();
    try {
      const publicKey = await signer.getPublicKey?.(context());
      assert.deepEqual(publicKey, secp256k1.getPublicKey(secretKey, false));
      const signature = await signer.signDigest?.(
        { digest: new Uint8Array(32).fill(7) },
        context(),
      );
      assert.ok(signature !== undefined && "format" in signature);
      assert.equal(signature.format, "der");
    } finally {
      await signer.close?.();
    }
    const sent = kmsServer.requests.slice(sentBefore);
    assert.equal(sent.length, 2);
    for (const request of sent) {
      assert.equal(request.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
    }
    assert.ok(auth.exchanges >= 1);
    assert.equal(auth.lookups, 0);
  });

  it("reads the history with the exchanged token and never looks the project up", async () => {
    logging.answers.push({ status: 200, body: { entries: [] } });
    const list = await loadLogging("hardhat-kms/test", "p", logging.endpoint);
    const result = await readGcpSignHistory(gcpKey(), historyRequest(), list);
    assert.equal(result.events.length, 0);
    assert.equal(logging.requests.at(-1)?.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.ok(auth.exchanges >= 1);
    assert.equal(auth.lookups, 0);
  });

  it("sees the project lookup when no project is given, as a control for the tests above", async () => {
    logging.answers.push({ status: 200, body: { entries: [] } });
    const list = await loadLogging("hardhat-kms/test", undefined, logging.endpoint);
    await readGcpSignHistory(gcpKey(), historyRequest(), list);
    assert.equal(auth.lookups, 1);
  });

  it("reports a refused token exchange by its OAuth error code only", async () => {
    auth.refuse = "invalid_grant";
    const sentBefore = kmsServer.requests.length;
    const signer = await adapter();
    const list = await loadLogging("hardhat-kms/test", "p", logging.endpoint);
    const attempts: Array<["sign" | "history", () => Promise<unknown>]> = [
      ["sign", async () => await signer.getPublicKey?.(context())],
      ["history", async () => await readGcpSignHistory(gcpKey(), historyRequest(), list)],
    ];
    try {
      for (const [operation, attempt] of attempts) {
        await assert.rejects(
          attempt(),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            const where = operation === "history" ? "gcp, history," : "gcp, connect,";
            assert.ok(error.message.includes(where), error.message);
            assert.match(error.message, /refused the external credentials \(invalid_grant\)/);
            assert.ok(!error.message.includes(SECRET_CLAIM), error.message);
            assert.ok(!error.message.includes(PROJECT_NUMBER), error.message);
            assert.ok(!error.message.includes(auth.url), error.message);
            return true;
          },
          operation,
        );
      }
    } finally {
      await signer.close?.();
    }
    assert.equal(kmsServer.requests.length, sentBefore);
    assert.equal(auth.lookups, 0);
  });

  it("retries a token exchange that is unavailable, as before", async () => {
    auth.refuse = "temporarily_unavailable";
    auth.refuseStatus = 503;
    const signer = await adapter();
    try {
      await assert.rejects(
        signer.getPublicKey?.(context()) ?? Promise.resolve(),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /Google Cloud KMS is unavailable \(UNAVAILABLE\), after 4 attempts/,
          );
          return true;
        },
      );
    } finally {
      await signer.close?.();
    }
    assert.ok(auth.exchanges >= 4, String(auth.exchanges));
    assert.equal(auth.lookups, 0);
  });
});
