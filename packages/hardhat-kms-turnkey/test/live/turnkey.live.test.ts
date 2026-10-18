// The Turnkey smoke test against Turnkey's API: `pnpm run test:live:turnkey`, or the Turnkey live
// workflow (.github/workflows/turnkey-live.yml). Turnkey has no sandbox, and the Free plan includes
// 25 signatures a month, so this file sends at most 11 sign requests (SIGNATURE_CAP): the recorder
// refuses the 12th before it leaves the process. A used-up quota (429 SIGNING_QUOTA_EXCEEDED) ends
// the run as "quota used up": the remaining cases are skipped, not failed.
//
// Skipped unless all five variables are set:
// - TURNKEY_API_PRIVATE_KEY and TURNKEY_ORGANIZATION_ID: a non-root API user's P-256 key and the
//   test organization (docs/user/guides/turnkey-setup.md).
// - HARDHAT_KMS_LIVE_TURNKEY_ADDRESS: the account the guide's policies cover.
// - HARDHAT_KMS_LIVE_TURNKEY_DENIED_ADDRESS: an account no policy covers.
// - HARDHAT_KMS_LIVE_TURNKEY_CONSENSUS_ADDRESS: an account under a policy that needs 2 approvers.
// HARDHAT_KMS_LIVE_TURNKEY_SEPOLIA=1 adds one EIP-1559 self-send of 0 wei on Sepolia, through
// HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL or a public RPC, when the allowed account holds the ETH.
//
// Every failure goes through `liveRedactor`. A passing run writes test/live/turnkey-smoke.json at
// the repository root: the date, the commit, the signature count and the findings (statuses,
// codes, the form of r, s, v and of the signed transactions, high s, latency, scrubbed answer
// shapes), with no value. `pnpm run docs:live-proof` puts its date and commit in
// docs/live-proof.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { apiKeyFromPrivateKey } from "../../src/internal/stamp.ts";
import { openSmoke, type Smoke, SMOKE_CASES } from "./cases.ts";
import { type CaseOutcome, LiveRecorder, liveRedactor, runCase, VARIABLES } from "./smoke.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(here, "../../../..");
/** Where a passing run writes its record. */
const SMOKE_FILE = path.join(REPOSITORY, "test/live/turnkey-smoke.json");
const DEFAULT_SEPOLIA_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";

const env = (name: string): string => process.env[name]?.trim() ?? "";
const missing = Object.values(VARIABLES).filter((name) => env(name) === "");
const publicKey = apiKeyFromPrivateKey(env(VARIABLES.apiPrivateKey))?.publicKey;
const redact = liveRedactor(process.env, publicKey === undefined ? [] : [publicKey]);
const recorder = new LiveRecorder(globalThis.fetch);
const outcomes: Array<{ name: string; outcome: CaseOutcome["kind"] }> = [];
const CASE_COUNT = SMOKE_CASES.length;

describe(
  "@hardhat-kms/turnkey against Turnkey (smoke test)",
  {
    skip: missing.length === 0 ? false : `not set: ${missing.join(", ")}`,
    timeout: 900_000,
  },
  () => {
    let smoke: Smoke | undefined;

    before(async () => {
      const sepolia = env("HARDHAT_KMS_LIVE_TURNKEY_SEPOLIA") === "1";
      smoke = await openSmoke({
        address: env(VARIABLES.address),
        denied: env(VARIABLES.denied),
        consensus: env(VARIABLES.consensus),
        variables: {
          organizationId: VARIABLES.organizationId,
          apiPrivateKey: VARIABLES.apiPrivateKey,
        },
        transport: { fetch: recorder.fetch },
        recorder,
        sepoliaUrl: sepolia
          ? env("HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL") || DEFAULT_SEPOLIA_RPC_URL
          : undefined,
      });
    });

    after(() => {
      smoke?.close();
      const passed =
        outcomes.length === CASE_COUNT &&
        outcomes.every(({ outcome }) => outcome === "passed" || outcome === "skipped");
      const record = {
        date: new Date().toISOString().slice(0, 10),
        commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], {
          cwd: here,
          encoding: "utf8",
        }).trim(),
        signatures: recorder.signatures,
        result: recorder.quotaUsedUp ? "quota used up" : passed ? "passed" : "failed",
        cases: outcomes,
        exchanges: recorder.exchanges,
        shapes: Object.fromEntries(recorder.shapes),
      };
      const report = redact(JSON.stringify(record, undefined, 2));
      process.stdout.write(
        `Turnkey smoke test: ${record.result}, ${recorder.signatures} of ${recorder.cap} sign requests\n${report}\n`,
      );
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary !== undefined && summary !== "") {
        appendFileSync(
          summary,
          `### Turnkey smoke test: ${record.result}\n\n${recorder.signatures} of ${recorder.cap} sign requests.\n\n\`\`\`json\n${report}\n\`\`\`\n`,
        );
      }
      if (passed && !recorder.quotaUsedUp) {
        writeFileSync(SMOKE_FILE, `${report}\n`);
      }
    });

    for (const item of SMOKE_CASES) {
      it(item.name, async (t) => {
        const shared = smoke;
        assert.ok(shared !== undefined, "the runtime did not open");
        const outcome = await runCase(
          recorder,
          item.name,
          redact,
          async () => await item.run(shared),
        );
        outcomes.push({ name: item.name, outcome: outcome.kind });
        t.diagnostic(`sign requests so far: ${recorder.signatures} of ${recorder.cap}`);
        switch (outcome.kind) {
          case "passed":
            if (outcome.note !== undefined) {
              t.diagnostic(outcome.note);
            }
            return;
          case "skipped":
            t.skip(outcome.reason);
            return;
          case "quota":
            t.skip("quota used up: Turnkey refused a signature for the monthly quota");
            return;
          case "failed":
            assert.fail(outcome.message);
        }
      });
    }
  },
);
