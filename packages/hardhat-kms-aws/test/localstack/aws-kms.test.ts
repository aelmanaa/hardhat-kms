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
import type { KmsKeyAdapter } from "hardhat-kms/types";

import { isolateAwsEnvironment } from "../helpers/aws-env.ts";
import { type LocalStack, startLocalStack } from "../helpers/localstack.ts";
import { checkSignature, signContext, signDigest, withAdapter } from "../helpers/plugin-adapter.ts";

const REGION = "eu-west-1";

let localstack: LocalStack;
let restoreEnvironment: () => void;
let kms: KMSClient;

/** Creates a KMS key and returns its id. */
async function createKey(keySpec: KeySpec, keyUsage: KeyUsageType): Promise<string> {
  const created = await kms.send(new CreateKeyCommand({ KeySpec: keySpec, KeyUsage: keyUsage }));
  const keyId = created.KeyMetadata?.KeyId;
  assert.ok(keyId !== undefined);
  return keyId;
}

/** Builds the adapter for a key on LocalStack, with the region unless `region` is undefined. */
async function withLocalAdapter(
  keyId: string,
  use: (adapter: KmsKeyAdapter) => Promise<void>,
  region: string | undefined = REGION,
): Promise<void> {
  await withAdapter(
    {
      provider: "aws",
      keyId,
      endpoint: localstack.endpoint,
      ...(region === undefined ? {} : { region }),
    },
    use,
  );
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
    await withLocalAdapter(keyId, async (adapter) => {
      const publicKey = await adapter.getPublicKey?.(signContext());
      assert.ok(publicKey !== undefined && publicKey.length === 65);
      for (let index = 0; index < 32; index++) {
        const digest = secp256k1.utils.randomSecretKey();
        seen.add(checkSignature(publicKey, digest, await signDigest(adapter, digest)).highS);
      }
    });
    // LocalStack returns high-S signatures about half the time; both kinds must have been checked.
    assert.ok(seen.has(true) && seen.has(false), "only one kind of S was seen");
  });

  it("keeps signing with the key an alias named first, after the alias moves", async () => {
    const first = await createKey("ECC_SECG_P256K1", "SIGN_VERIFY");
    const second = await createKey("ECC_SECG_P256K1", "SIGN_VERIFY");
    await kms.send(new CreateAliasCommand({ AliasName: "alias/hhkms-moving", TargetKeyId: first }));
    await withLocalAdapter("alias/hhkms-moving", async (adapter) => {
      const publicKey = await adapter.getPublicKey?.(signContext());
      assert.ok(publicKey !== undefined);

      await kms.send(
        new UpdateAliasCommand({ AliasName: "alias/hhkms-moving", TargetKeyId: second }),
      );
      const digest = new Uint8Array(32).fill(3);
      checkSignature(publicKey, digest, await signDigest(adapter, digest));
    });
  });

  it("takes the region from a key ARN when none is configured", async () => {
    const keyId = await createKey("ECC_SECG_P256K1", "SIGN_VERIFY");
    const arn = `arn:aws:kms:${REGION}:000000000000:key/${keyId}`;
    await withLocalAdapter(
      arn,
      async (adapter) => {
        const publicKey = await adapter.getPublicKey?.(signContext());
        assert.ok(publicKey !== undefined);
        const digest = new Uint8Array(32).fill(4);
        checkSignature(publicKey, digest, await signDigest(adapter, digest));
      },
      undefined,
    );
  });

  it("refuses keys that cannot sign Ethereum digests", async () => {
    for (const [spec, usage, message] of [
      ["ECC_NIST_P256", "SIGN_VERIFY", "the key spec is ECC_NIST_P256, not ECC_SECG_P256K1"],
      ["SYMMETRIC_DEFAULT", "ENCRYPT_DECRYPT", "the key spec is SYMMETRIC_DEFAULT"],
    ] as const) {
      await withLocalAdapter(await createKey(spec, usage), async (adapter) => {
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
