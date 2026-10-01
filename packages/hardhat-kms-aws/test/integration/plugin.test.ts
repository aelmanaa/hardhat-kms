import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import hardhatKms from "hardhat-kms";
import type { KmsKeyAdapter, KmsKeyConfig } from "hardhat-kms/types";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatPlugin } from "hardhat/types/plugins";

import hardhatKmsAws from "../../src/index.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { isolateAwsEnvironment } from "../helpers/aws-env.ts";
import { KEY_ARN } from "../helpers/fake-aws-kms.ts";
import { type KmsServer, startKmsServer } from "../helpers/kms-server.ts";

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

async function runtime(plugins: HardhatPlugin[] = [hardhatKmsAws]) {
  return await createHardhatRuntimeEnvironment({
    plugins,
    kms: {
      keys: {
        deployer: {
          provider: "aws",
          keyId: "alias/deployer",
          region: "eu-west-1",
          endpoint: server.url,
        },
        noRegion: { provider: "aws", keyId: "alias/deployer", endpoint: server.url },
        google: {
          provider: "gcp",
          keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
        },
      },
    },
  });
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

describe("hardhat-kms-aws plugin", () => {
  before(async () => {
    server = await startKmsServer(secretKey);
    restoreEnvironment = isolateAwsEnvironment();
  });

  after(async () => {
    restoreEnvironment();
    await server.close();
  });

  it("loads hardhat-kms through its plugin dependency", async () => {
    const hre = await runtime();

    assert.equal(hre.config.kms.keys.deployer?.provider, "aws");
    // Listing both, as users coming from hardhat-kms alone may do, loads the core once.
    const both = await runtime([hardhatKms, hardhatKmsAws]);
    assert.equal(both.config.kms.keys.deployer?.provider, "aws");
  });

  it("claims aws keys and passes other keys on", async () => {
    const hre = await runtime();
    const unclaimed: string[] = [];

    const adapter = await createAdapter(hre, "deployer", unclaimed);
    assert.equal(adapter.describe().provider, "aws");
    await adapter.close?.();
    await assert.rejects(createAdapter(hre, "google", unclaimed), /unclaimed/);
    assert.deepEqual(unclaimed, [
      "gcp:projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
    ]);
  });

  it("signs through the real AWS SDK, with the key ARN and MessageType DIGEST", async () => {
    const hre = await runtime();
    const adapter = await createAdapter(hre, "deployer");
    const ctx = signContext();
    const digest = new Uint8Array(32).fill(5);
    server.requests.length = 0;

    const publicKey = await adapter.getPublicKey?.(ctx);
    const signature = await adapter.signDigest?.({ digest }, ctx);
    await adapter.close?.();

    assert.deepEqual(publicKey, secp256k1.getPublicKey(secretKey, false));
    assert.ok(signature !== undefined && "format" in signature && signature.format === "der");
    assert.ok(
      secp256k1.verify(
        secp256k1.Signature.fromBytes(signature.bytes, "der").toBytes("compact"),
        digest,
        secp256k1.getPublicKey(secretKey),
        { prehash: false },
      ),
    );
    assert.deepEqual(
      server.requests.map(({ headers, body }) => [headers["x-amz-target"], body.KeyId]),
      [
        ["TrentService.GetPublicKey", "alias/deployer"],
        ["TrentService.Sign", KEY_ARN],
      ],
    );
    const sign = server.requests[1]?.body;
    assert.equal(sign?.MessageType, "DIGEST");
    assert.equal(sign?.SigningAlgorithm, "ECDSA_SHA_256");
    assert.equal(sign?.Message, Buffer.from(digest).toString("base64"));
    // The request is signed for the configured region.
    assert.match(
      String(server.requests[0]?.headers.authorization),
      /\/eu-west-1\/kms\/aws4_request/,
    );
  });

  it("explains a missing region the real SDK reports", async () => {
    const hre = await runtime();
    const adapter = await createAdapter(hre, "noRegion");

    await assert.rejects(adapter.getPublicKey?.(signContext()) ?? Promise.resolve(), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /no AWS region is configured/);
      return true;
    });
    await adapter.close?.();
  });

  it("refuses AWS keys when hardhat-kms is another version, and passes other keys on", async () => {
    const hre = await runtime();
    // Handlers registered at run time run first: these behave like a hardhat-kms-aws 9.9.9.
    hre.hooks.registerHandlers("kms", kmsHandlers("9.9.9"));
    const unclaimed: string[] = [];

    await assert.rejects(createAdapter(hre, "deployer"), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes(
          `aws, create adapter, key aws:alias/deployer: hardhat-kms-aws 9.9.9 needs hardhat-kms 9.9.9, but hardhat-kms ${coreVersion} is installed`,
        ),
        error.message,
      );
      assert.ok(
        error.message.includes("npm install --save-dev hardhat-kms@9.9.9 hardhat-kms-aws@9.9.9"),
      );
      return true;
    });
    await assert.rejects(createAdapter(hre, "google", unclaimed), /unclaimed/);
    assert.equal(unclaimed.length, 1);
  });
});
