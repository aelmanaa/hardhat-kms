// The planted-secret test with the real adapter: signs against the Turnkey stub with
// DEBUG=hardhat:kms:* and checks that no API key, stamp, organization id from a variable, activity
// id or Turnkey message reaches the debug output, and that only the approval error names the
// activity.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { API_PRIVATE_KEY, API_PUBLIC_KEY } from "../helpers/keys.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

const ORGANIZATION = "5d0c2b1a-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
const ACTIVITY_ID = "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918";
const TURNKEY_MESSAGE = 'request is targeting organization ("hhkms secret org name")';

describe("debug output with the Turnkey adapter", () => {
  it("logs requests and activities without any planted value", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "hardhat-kms-turnkey-debug-"));
    const stampsFile = path.join(scratch, "stamps.json");
    try {
      const result = spawnSync(process.execPath, [path.join(here, "../fixtures/debug-run.ts")], {
        encoding: "utf8",
        env: {
          ...process.env,
          HHKMS_DEBUG_TURNKEY_ORGANIZATION: ORGANIZATION,
          HHKMS_DEBUG_TURNKEY_API_PRIVATE_KEY: API_PRIVATE_KEY,
          HHKMS_DEBUG_TURNKEY_API_PUBLIC_KEY: API_PUBLIC_KEY,
          HHKMS_DEBUG_ACTIVITY_ID: ACTIVITY_ID,
          HHKMS_DEBUG_TURNKEY_MESSAGE: TURNKEY_MESSAGE,
          STAMPS_FILE: stampsFile,
          DEBUG: "hardhat:kms:*",
          DEBUG_COLORS: "no",
        },
        timeout: 90_000,
        killSignal: "SIGKILL",
      });
      assert.equal(result.status, 0, result.stderr);
      const debug = result.stderr;
      const printed = result.stdout;
      const stamps: unknown = JSON.parse(readFileSync(stampsFile, "utf8"));
      assert.ok(Array.isArray(stamps) && stamps.length > 10);

      for (const expected of [
        "hardhat:kms:turnkey ",
        "/public/v1/submit/sign_raw_payload: HTTP 200 in ",
        "/public/v1/query/get_activity: HTTP 200 in ",
        "activity ACTIVITY_STATUS_PENDING",
        "activity ACTIVITY_STATUS_COMPLETED",
        "activity ACTIVITY_STATUS_CONSENSUS_NEEDED",
        "HTTP 403 REQUEST_NOT_AUTHORIZED in ",
        "HTTP 429 RATE_LIMIT_EXCEEDED in ",
        "sign_raw_payload: HTTP 500 in ",
        "creating the adapter for turnkey:<HHKMS_DEBUG_TURNKEY_ORGANIZATION>/",
      ]) {
        assert.ok(debug.includes(expected), `expected "${expected}" in:\n${debug}`);
      }
      for (const expected of [
        "completed: signed",
        "pending: signed",
        "retried: signed",
        `consensus: `,
        "failed: ",
        "Turnkey's signing activity failed (POLICY_DENIED)",
        "Turnkey answered 403 REQUEST_NOT_AUTHORIZED",
        "Turnkey answered 401 UNAUTHENTICATED",
        "Turnkey answered for another organization",
        '"signCheck": "ok"',
      ]) {
        assert.ok(printed.includes(expected), `expected "${expected}" in:\n${printed}`);
      }

      const planted = [
        API_PRIVATE_KEY,
        API_PUBLIC_KEY,
        TURNKEY_MESSAGE,
        "hhkms secret org name",
        "X-Stamp",
        ...stamps.map(String),
      ];
      for (const value of [...planted, ORGANIZATION, ACTIVITY_ID]) {
        assert.ok(
          !debug.toLowerCase().includes(value.toLowerCase()),
          `${value} in the debug output`,
        );
      }
      // Standard output: the organization only from `kms accounts --show-ids`, and the activity id
      // only in the approval error.
      for (const value of planted) {
        assert.ok(!printed.toLowerCase().includes(value.toLowerCase()), `${value} in:\n${printed}`);
      }
      const withActivity = printed.split("\n").filter((line) => line.includes(ACTIVITY_ID));
      assert.equal(withActivity.length, 1, printed);
      assert.match(withActivity[0] ?? "", /^consensus: .*Turnkey holds activity 7f6e5d4c/);
      const withOrganization = printed
        .split("\n")
        .filter((line) => line.toLowerCase().includes(ORGANIZATION));
      assert.deepEqual(withOrganization, [
        `      "keyId": "turnkey:${ORGANIZATION}/0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",`,
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
