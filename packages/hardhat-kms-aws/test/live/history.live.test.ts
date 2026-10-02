// Runs `kms history` against real CloudTrail event history: `pnpm run test:live:aws`. It is
// skipped unless HARDHAT_KMS_LIVE_AWS_KEY_ID names an ECC_SECG_P256K1 SIGN_VERIFY key with an
// alias and HARDHAT_KMS_LIVE_AWS_HISTORY=1, since it waits up to 15 minutes for CloudTrail. It
// uses the developer's own credentials and Region, which need cloudtrail:LookupEvents on top of
// the smoke test's permissions, and creates nothing.
//
// It signs once through the plugin, which signs with the key ARN, and once with the AWS SDK and
// the alias, then polls `kms history --json` for the bare key id until both events appear. That
// shows the reader finds Sign calls whatever key id the caller passed, that CloudTrail logs the
// plugin's user agent, and whether CloudTrail's requestID is the SDK's $metadata.requestId. It
// prints only the facts it found: no key id, ARN, account id, principal or IP address.
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  DescribeKeyCommand,
  KMSClient,
  ListAliasesCommand,
  SignCommand,
} from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { KmsHistoryReport } from "hardhat-kms/types";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsAws from "../../src/index.ts";
import { signDigest, withAdapter } from "../helpers/plugin-adapter.ts";

const keyId = process.env.HARDHAT_KMS_LIVE_AWS_KEY_ID?.trim() ?? "";
const enabled = keyId !== "" && process.env.HARDHAT_KMS_LIVE_AWS_HISTORY === "1";

const POLL_MS = 30_000;
const DEADLINE_MS = 15 * 60_000;

/** Removes the key id, ARNs and account ids from a message. */
function redact(message: string): string {
  return message
    .replaceAll(/arn:aws[^\s'"]*/g, "<arn>")
    .replaceAll(keyId, "<key id>")
    .replaceAll(/\b\d{12}\b/g, "<account>");
}

/** Runs `step`, rethrowing any failure with ids removed and without its cause. */
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

function isReport(value: unknown): value is KmsHistoryReport {
  return typeof value === "object" && value !== null && Reflect.get(value, "version") === 1;
}

/** Runs `kms history --json` on the bare key id, keeping its output off the terminal. */
async function readHistory(since: string): Promise<KmsHistoryReport> {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKmsAws],
    kms: { keys: { deployer: { provider: "aws", keyId } } },
  });
  const write = mock.method(process.stdout, "write", () => true);
  const writeError = mock.method(process.stderr, "write", () => true);
  try {
    const result: unknown = await hre.tasks
      .getTask(["kms", "history"])
      .run({ key: "deployer", since, limit: 1000, json: true, showIds: true });
    assert.ok(isReport(result), "kms history returned no report");
    return result;
  } finally {
    write.mock.restore();
    writeError.mock.restore();
  }
}

describe("kms history on real CloudTrail", { skip: !enabled }, () => {
  let kms: KMSClient;
  let alias: string;

  before(async () => {
    kms = new KMSClient({});
    await redacted(async () => {
      const metadata = (await kms.send(new DescribeKeyCommand({ KeyId: keyId }))).KeyMetadata;
      assert.ok(metadata?.KeyId !== undefined, "the key has no id");
      const name = (await kms.send(new ListAliasesCommand({ KeyId: metadata.KeyId }))).Aliases?.[0]
        ?.AliasName;
      assert.ok(name !== undefined, "the key has no alias; create one for this test");
      alias = name;
    });
  });

  after(() => {
    kms?.destroy();
  });

  it(
    "lists a new plugin Sign event and an alias Sign event",
    { timeout: DEADLINE_MS + 120_000 },
    async (t) => {
      // CloudTrail times are whole seconds.
      const since = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000).toISOString();
      const signedAt = Date.now();
      await redacted(async () => {
        await withAdapter({ provider: "aws", keyId }, async (adapter) => {
          await signDigest(adapter, secp256k1.utils.randomSecretKey());
        });
      });
      const sdkRequestId = await redacted(async () => {
        const output = await kms.send(
          new SignCommand({
            KeyId: alias,
            Message: secp256k1.utils.randomSecretKey(),
            MessageType: "DIGEST",
            SigningAlgorithm: "ECDSA_SHA_256",
          }),
        );
        return output.$metadata.requestId;
      });
      assert.ok(sdkRequestId !== undefined, "the SDK reported no request id");

      let report: KmsHistoryReport | undefined;
      let pluginSeen = false;
      let aliasSeen = false;
      let polls = 0;
      while (Date.now() - signedAt < DEADLINE_MS) {
        await delay(POLL_MS);
        polls += 1;
        report = await redacted(async () => await readHistory(since));
        const events = report.events;
        pluginSeen = events.some((event) => event.userAgent?.includes("hardhat-kms/") === true);
        aliasSeen = events.some((event) => event.requestId === sdkRequestId);
        if (pluginSeen && aliasSeen) {
          break;
        }
      }
      const minutes = ((Date.now() - signedAt) / 60_000).toFixed(1);
      t.diagnostic(`polls: ${polls}; both events seen after at most ${minutes} minutes`);
      assert.ok(report !== undefined, "kms history never ran");
      assert.ok(
        pluginSeen,
        "no Sign event with the hardhat-kms/ user agent appeared in 15 minutes",
      );
      assert.ok(
        aliasSeen,
        "no Sign event with the SDK's $metadata.requestId as requestID appeared in 15 minutes",
      );
      t.diagnostic("CloudTrail requestID equals the SDK's $metadata.requestId: confirmed");
      t.diagnostic(
        "a Sign call made with the alias is found by a read of the bare key id: confirmed",
      );

      assert.equal(report.source, "cloudtrail-event-history");
      assert.deepEqual(report.notLogged, ["keyVersion", "digest"]);
      assert.ok(
        !report.notes.some((note) => note.code === "other-account" || note.code === "other-region"),
        "the read did not cover the key's account and Region",
      );
      const aliasEvent = report.events.find((event) => event.requestId === sdkRequestId);
      assert.equal(aliasEvent?.operation, "Sign");
      assert.equal(aliasEvent.outcome, "success");
      assert.equal(aliasEvent.extra.requestKeyId, alias);
      assert.ok(
        aliasEvent.principal?.startsWith("arn:aws") === true,
        "the principal is not an ARN",
      );
    },
  );
});
