// Runs the AWS adapter against LocalStack's KMS with the real SDK: `pnpm run test:localstack`.
// Needs Docker. It creates its own keys, which disappear with the container.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  CreateAliasCommand,
  CreateKeyCommand,
  KMSClient,
  type KeySpec,
  type KeyUsageType,
  UpdateAliasCommand,
} from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { KmsKeyAdapter, KmsKeyConfig } from "hardhat-kms/types";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsAws from "../../src/index.ts";
import { isolateAwsEnvironment } from "../helpers/aws-env.ts";
import { type LocalStack, startLocalStack } from "../helpers/localstack.ts";

const REGION = "eu-west-1";
const HALF_ORDER = secp256k1.Point.CURVE().n / 2n;

let localstack: LocalStack;
let restoreEnvironment: () => void;
let kms: KMSClient;

const signContext = () => ({
  signal: new AbortController().signal,
  displayMessage: async () => {},
  requestId: "r1",
});

/** Creates a KMS key and returns its id. */
async function createKey(keySpec: KeySpec, keyUsage: KeyUsageType): Promise<string> {
  const created = await kms.send(new CreateKeyCommand({ KeySpec: keySpec, KeyUsage: keyUsage }));
  const keyId = created.KeyMetadata?.KeyId;
  assert.ok(keyId !== undefined);
  return keyId;
}

/**
 * Builds the adapter for a key the way a Hardhat project with hardhat-kms-aws does, runs `use`
 * with it and closes it.
 */
async function withAdapter(
  keyId: string,
  use: (adapter: KmsKeyAdapter) => Promise<void>,
  region: string | undefined = REGION,
): Promise<void> {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKmsAws],
    kms: {
      keys: {
        deployer: {
          provider: "aws",
          keyId,
          endpoint: localstack.endpoint,
          ...(region === undefined ? {} : { region }),
        },
      },
    },
  });
  const key = hre.config.kms.keys.deployer;
  assert.ok(key);
  const adapter = await hre.hooks.runHandlerChain(
    "kms",
    "createKeyAdapter",
    [key],
    async (_context, rest: KmsKeyConfig) =>
      await Promise.reject(new Error(`unclaimed ${rest.displayId}`)),
  );
  try {
    await use(adapter);
  } finally {
    await adapter.close?.();
  }
}

/** Checks a DER signature from KMS the way the plugin does: verify, fold high S, recover. */
function check(publicKey: Uint8Array, digest: Uint8Array, der: Uint8Array): { highS: boolean } {
  const signature = secp256k1.Signature.fromBytes(der, "der");
  const highS = signature.s > HALF_ORDER;
  const low = highS
    ? new secp256k1.Signature(signature.r, secp256k1.Point.CURVE().n - signature.s)
    : signature;
  assert.ok(
    secp256k1.verify(low.toBytes("compact"), digest, publicKey, { prehash: false }),
    "the signature does not verify against the key's public key",
  );
  const recovered = [0, 1].map((bit) =>
    low.addRecoveryBit(bit).recoverPublicKey(digest).toBytes(false),
  );
  assert.ok(
    recovered.some((candidate) => Buffer.from(candidate).equals(Buffer.from(publicKey))),
    "no recovery id recovers the key's public key",
  );
  return { highS };
}

async function signWith(adapter: KmsKeyAdapter, digest: Uint8Array): Promise<Uint8Array> {
  const signature = await adapter.signDigest?.({ digest }, signContext());
  assert.ok(signature !== undefined && "format" in signature && signature.format === "der");
  return signature.bytes;
}

describe("AWS adapter on LocalStack KMS", { timeout: 300_000 }, () => {
  before(async () => {
    restoreEnvironment = isolateAwsEnvironment();
    localstack = await startLocalStack();
    kms = new KMSClient({ region: REGION, endpoint: localstack.endpoint });
  });

  after(() => {
    kms?.destroy();
    localstack?.stop();
    restoreEnvironment();
  });

  it("signs digests that verify and recover to the key, high-S or not", async () => {
    const keyId = await createKey("ECC_SECG_P256K1", "SIGN_VERIFY");
    const seen = new Set<boolean>();
    await withAdapter(keyId, async (adapter) => {
      const publicKey = await adapter.getPublicKey?.(signContext());
      assert.ok(publicKey !== undefined && publicKey.length === 65);
      for (let index = 0; index < 32; index++) {
        const digest = secp256k1.utils.randomSecretKey();
        seen.add(check(publicKey, digest, await signWith(adapter, digest)).highS);
      }
    });
    // LocalStack returns high-S signatures about half the time; both kinds must have been checked.
    assert.ok(seen.has(true) && seen.has(false), "only one kind of S was seen");
  });

  it("keeps signing with the key an alias named first, after the alias moves", async () => {
    const first = await createKey("ECC_SECG_P256K1", "SIGN_VERIFY");
    const second = await createKey("ECC_SECG_P256K1", "SIGN_VERIFY");
    await kms.send(new CreateAliasCommand({ AliasName: "alias/hhkms-moving", TargetKeyId: first }));
    await withAdapter("alias/hhkms-moving", async (adapter) => {
      const publicKey = await adapter.getPublicKey?.(signContext());
      assert.ok(publicKey !== undefined);

      await kms.send(
        new UpdateAliasCommand({ AliasName: "alias/hhkms-moving", TargetKeyId: second }),
      );
      const digest = new Uint8Array(32).fill(3);
      check(publicKey, digest, await signWith(adapter, digest));
    });
  });

  it("takes the region from a key ARN when none is configured", async () => {
    const keyId = await createKey("ECC_SECG_P256K1", "SIGN_VERIFY");
    const arn = `arn:aws:kms:${REGION}:000000000000:key/${keyId}`;
    await withAdapter(
      arn,
      async (adapter) => {
        const publicKey = await adapter.getPublicKey?.(signContext());
        assert.ok(publicKey !== undefined);
        const digest = new Uint8Array(32).fill(4);
        check(publicKey, digest, await signWith(adapter, digest));
      },
      undefined,
    );
  });

  it("refuses keys that cannot sign Ethereum digests", async () => {
    for (const [spec, usage, message] of [
      ["ECC_NIST_P256", "SIGN_VERIFY", "the key spec is ECC_NIST_P256, not ECC_SECG_P256K1"],
      ["SYMMETRIC_DEFAULT", "ENCRYPT_DECRYPT", "the key spec is SYMMETRIC_DEFAULT"],
    ] as const) {
      await withAdapter(await createKey(spec, usage), async (adapter) => {
        await assert.rejects(
          adapter.getPublicKey?.(signContext()) ?? Promise.resolve(),
          (error) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes(message), error.message);
            return true;
          },
        );
      });
    }
  });
});
