import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { GcpKmsKeyConfig } from "hardhat-kms/types";

import { fakeGcpKmsSdk, KEY_VERSION_NAME } from "../helpers/fake-gcp-kms.ts";

// A logger reads DEBUG when it is created, and the adapter module creates its own when it loads,
// so DEBUG is set before it is imported. Each test file runs in its own process.
process.env.DEBUG = "hardhat:kms:gcp";
process.env.DEBUG_COLORS = "no";
const { createGcpKeyAdapter } = await import("../../src/internal/adapter.ts");

const secretKey = secp256k1.utils.randomSecretKey();
const context = {
  signal: new AbortController().signal,
  displayMessage: async () => {},
  requestId: "r1",
};

/** A key whose version name comes from a variable, so only its display form may be printed. */
const key: GcpKmsKeyConfig = {
  provider: "gcp",
  name: "deployer",
  keyVersionName: {
    get: async () => await Promise.resolve(KEY_VERSION_NAME),
    display: "<GCP_KEY>",
  },
  timeoutMs: 1000,
  displayId: "gcp:<GCP_KEY>",
};

let written: string[] = [];
let restore: (() => void) | undefined;

/** The adapter's debug lines written so far, without the namespace and the time since the last. */
function lines(): string[] {
  return written
    .join("")
    .split("\n")
    .flatMap((line) => {
      const match = /hardhat:kms:gcp (.*) \+\d+m?s$/.exec(line.trim());
      return match?.[1] === undefined ? [] : [match[1]];
    });
}

describe("Google Cloud adapter debug lines (#637)", () => {
  beforeEach(() => {
    written = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    restore = () => {
      process.stderr.write = original;
    };
  });

  afterEach(() => {
    restore?.();
  });

  it("logs the protection level of each public key response, by the key's display id", async () => {
    for (const protectionLevel of ["HSM", null] as const) {
      const adapter = await createGcpKeyAdapter(
        key,
        fakeGcpKmsSdk({ secretKey, protectionLevel }).sdk,
        "hardhat-kms/1.2.3",
      );
      await adapter.getPublicKey?.(context);
    }

    assert.deepEqual(lines(), [
      "gcp:<GCP_KEY>: protection level HSM",
      "gcp:<GCP_KEY>: protection level not reported",
    ]);
    assert.ok(!written.join("").includes(KEY_VERSION_NAME));
  });
});
