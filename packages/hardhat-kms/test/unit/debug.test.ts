import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { kmsDebug } from "../../src/internal/debug.ts";

let written: string[] = [];
let restore: (() => void) | undefined;

function captureStderr(): void {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  restore = () => {
    process.stderr.write = original;
  };
}

describe("kmsDebug", () => {
  const previous = { debug: process.env.DEBUG, colors: process.env.DEBUG_COLORS };

  beforeEach(() => {
    written = [];
    process.env.DEBUG_COLORS = "no";
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
    process.env.DEBUG = previous.debug ?? "";
    process.env.DEBUG_COLORS = previous.colors ?? "";
  });

  it("logs plain values under hardhat:kms:<namespace>", () => {
    process.env.DEBUG = "hardhat:kms:*";
    const log = kmsDebug("test");
    captureStderr();
    log("key %s took %d ms", "aws:<AWS_KMS_KEY_ID>", 12);

    assert.ok(log.enabled);
    assert.match(written.join(""), /hardhat:kms:test key aws:<AWS_KMS_KEY_ID> took 12 ms/);
  });

  it("accepts only lowercase names of letters, digits and -", () => {
    for (const name of ["signer", "azure", "my-provider", "p2"]) {
      assert.doesNotThrow(() => kmsDebug(name), name);
    }
    for (const name of ["", "Signer", "2fa", "-x", "a:b", "a,b", "*", "a b", "a\nb", "a_b"]) {
      assert.throws(
        () => kmsDebug(name),
        {
          message:
            "a debug namespace may hold only lowercase letters, digits and -, and must start with a letter",
        },
        JSON.stringify(name),
      );
    }
  });

  it("replaces objects and errors, which would print whole", () => {
    process.env.DEBUG = "hardhat:kms:*";
    const log = kmsDebug("test");
    captureStderr();
    // What a careless caller might pass; the type forbids it, so go around the type.
    const values: unknown[] = [
      { token: "hhkms-secret-object" },
      new Error("hhkms-secret-error"),
      null,
    ];
    Reflect.apply(log, undefined, ["values %s %s %s", ...values]);
    const output = written.join("");

    assert.match(output, /\[redacted object\] \[redacted object\] \[redacted null\]/);
    assert.ok(!output.includes("hhkms-secret"), output);
  });

  it("escapes control characters, so a name cannot forge extra lines", () => {
    process.env.DEBUG = "hardhat:kms:*";
    const log = kmsDebug("test");
    captureStderr();
    log("network %s", "sepolia\nhardhat:kms:signer forged line\u001b[31m");
    const output = written.join("");

    assert.equal(output.trim().split("\n").length, 1, output);
    assert.ok(
      output.includes(String.raw`sepolia\nhardhat:kms:signer forged line\u001b[31m`),
      output,
    );
  });

  it("writes nothing when DEBUG does not match", () => {
    process.env.DEBUG = "hardhat:core:*";
    const log = kmsDebug("test");
    captureStderr();
    log("key %s", "aws:x");

    assert.equal(log.enabled, false);
    assert.deepEqual(written, []);
  });
});
