import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import hardhatKms from "hardhat-kms";
import { crc32c } from "hardhat-kms/provider-utils";
import type { KmsKeyAdapter, KmsKeyConfig } from "hardhat-kms/types";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatPlugin } from "hardhat/types/plugins";

import hardhatKmsGcp from "../../src/index.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { KEY_VERSION_NAME } from "../helpers/fake-gcp-kms.ts";
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
  Reflect.get(Object(createRequire(import.meta.url)("hardhat-kms-gcp/package.json")), "version"),
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

describe("hardhat-kms-gcp plugin", () => {
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

    // The plugin's handler with the real SDK: creating the client makes no call.
    const adapter = await createAdapter(hre, "deployer", unclaimed);
    assert.equal(adapter.describe().provider, "gcp");
    await adapter.close?.();
    await assert.rejects(createAdapter(hre, "amazon", unclaimed), /unclaimed/);
    assert.deepEqual(unclaimed, ["aws:alias/deployer"]);
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
    }
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

  it("refuses gcp keys when hardhat-kms is another version, and passes other keys on", async () => {
    const hre = await runtime([hardhatKmsGcp], false);
    hre.hooks.registerHandlers("kms", kmsHandlers("9.9.9"));
    const unclaimed: string[] = [];

    await assert.rejects(createAdapter(hre, "deployer"), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes(
          `gcp, create adapter, key gcp:${KEY_VERSION_NAME}: hardhat-kms-gcp 9.9.9 needs hardhat-kms 9.9.9, but hardhat-kms ${coreVersion} is installed`,
        ),
        error.message,
      );
      assert.ok(
        error.message.includes("npm install --save-dev hardhat-kms@9.9.9 hardhat-kms-gcp@9.9.9"),
      );
      return true;
    });
    await assert.rejects(createAdapter(hre, "amazon", unclaimed), /unclaimed/);
    assert.equal(unclaimed.length, 1);
  });
});
