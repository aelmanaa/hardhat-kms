// Runs the AWS adapter against real AWS KMS: `pnpm run test:live:aws`. It is skipped unless
// HARDHAT_KMS_LIVE_AWS_KEY_ID names an ECC_SECG_P256K1 SIGN_VERIFY key with an alias, and it uses
// the developer's own credentials and region (profile, SSO or environment). It creates nothing.
// The key id, ARNs and account ids are redacted from every failure it reports.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { DescribeKeyCommand, KMSClient, ListAliasesCommand } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { KmsKeyAdapter } from "hardhat-kms/types";

import { checkSignature, signContext, signDigest, withAdapter } from "../helpers/plugin-adapter.ts";

const keyId = process.env.HARDHAT_KMS_LIVE_AWS_KEY_ID?.trim() ?? "";

/** Removes the key id, ARNs and account ids from a message. */
function redact(message: string): string {
  // ARNs first: they contain the key id.
  return message
    .replaceAll(/arn:aws[^\s'"]*/g, "<arn>")
    .replaceAll(keyId, "<key id>")
    .replaceAll(/\b\d{12}\b/g, "<account>");
}

/**
 * Runs `step` and rethrows any failure with the key id, ARNs and account ids removed. SDK errors
 * name the key ARN and, for AccessDenied, the caller; the plugin's errors name the key id. The
 * original error is not kept as `cause`, since node:test would print it.
 */
async function redacted<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    // oxlint-disable-next-line eslint/preserve-caught-error -- the cause would be printed unredacted
    throw new Error(redact(`${name}: ${message}`));
  }
}

/** Signs a random digest and checks the signature against the key's public key. */
async function signAndCheck(adapter: KmsKeyAdapter, publicKey: Uint8Array): Promise<void> {
  const digest = secp256k1.utils.randomSecretKey();
  checkSignature(publicKey, digest, await signDigest(adapter, digest));
}

async function publicKeyOf(adapter: KmsKeyAdapter): Promise<Uint8Array> {
  const publicKey = await adapter.getPublicKey?.(signContext());
  assert.ok(publicKey?.length === 65, "the adapter returned no 65-byte public key");
  return publicKey;
}

/** Runs `step` with AWS_REGION set, then restores it. */
async function withRegion<T>(region: string, step: () => Promise<T>): Promise<T> {
  const saved = process.env.AWS_REGION;
  process.env.AWS_REGION = region;
  try {
    return await step();
  } finally {
    if (saved === undefined) {
      Reflect.deleteProperty(process.env, "AWS_REGION");
    } else {
      process.env.AWS_REGION = saved;
    }
  }
}

describe("AWS adapter on real AWS KMS", { skip: keyId === "", timeout: 300_000 }, () => {
  let kms: KMSClient;
  let arn: string;
  let alias: string;

  before(async () => {
    kms = new KMSClient({});
    await redacted(async () => {
      const metadata = (await kms.send(new DescribeKeyCommand({ KeyId: keyId }))).KeyMetadata;
      assert.ok(metadata?.Arn !== undefined, "the key has no ARN");
      assert.ok(metadata.KeySpec === "ECC_SECG_P256K1", "the key is not ECC_SECG_P256K1");
      assert.ok(metadata.KeyUsage === "SIGN_VERIFY", "the key is not a SIGN_VERIFY key");
      arn = metadata.Arn;
      const aliases = await kms.send(new ListAliasesCommand({ KeyId: metadata.KeyId }));
      const name = aliases.Aliases?.[0]?.AliasName;
      assert.ok(name !== undefined, "the key has no alias; create one for this test");
      alias = name;
    });
  });

  after(() => {
    kms?.destroy();
  });

  it("signs digests with a key id that verify and recover to the key", async () => {
    await redacted(async () => {
      await withAdapter({ provider: "aws", keyId }, async (adapter) => {
        const publicKey = await publicKeyOf(adapter);
        for (let index = 0; index < 16; index++) {
          await signAndCheck(adapter, publicKey);
        }
      });
    });
  });

  it("signs with an alias of the key, and gets the same public key", async () => {
    await redacted(async () => {
      const keys: Uint8Array[] = [];
      for (const id of [keyId, alias]) {
        await withAdapter({ provider: "aws", keyId: id }, async (adapter) => {
          const publicKey = await publicKeyOf(adapter);
          keys.push(publicKey);
          await signAndCheck(adapter, publicKey);
        });
      }
      assert.ok(
        Buffer.from(keys[0] ?? []).equals(Buffer.from(keys[1] ?? [])),
        "the alias resolves to another public key",
      );
    });
  });

  it("takes the region from a key ARN over AWS_REGION", async () => {
    // A region the key is not in. The bare key id must then fail, which shows AWS_REGION is used;
    // the ARN must still work, because its own region wins.
    const other = arn.includes(":eu-west-3:") ? "eu-west-1" : "eu-west-3";
    await withRegion(other, async () => {
      let bareError = "none";
      try {
        await withAdapter({ provider: "aws", keyId }, async (adapter) => {
          await publicKeyOf(adapter);
        });
      } catch (error) {
        // Keep only the class name: the message names the key ARN.
        bareError = error instanceof Error ? error.name : typeof error;
      }
      assert.equal(bareError, "NotFoundException", "the bare key id did not use AWS_REGION");

      await redacted(async () => {
        await withAdapter({ provider: "aws", keyId: arn }, async (adapter) => {
          await signAndCheck(adapter, await publicKeyOf(adapter));
        });
      });
    });
  });
});
