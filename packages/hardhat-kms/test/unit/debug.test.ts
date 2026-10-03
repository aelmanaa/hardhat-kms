import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import { CORE_NAMESPACES, coreDebug, kmsDebug } from "../../src/internal/debug.ts";

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

  it("accepts provider ids and other lowercase names of letters, digits and -", () => {
    for (const name of [
      "aws",
      "gcp",
      "azure",
      "myvault",
      "my-provider",
      "p2",
      "test",
      `a${"b".repeat(63)}`,
    ]) {
      assert.doesNotThrow(() => kmsDebug(name), name);
    }
  });

  it("refuses a name in another form with an error that names it and the rule", () => {
    for (const name of [
      "",
      "Signer",
      "2fa",
      "-x",
      "a:b",
      "a,b",
      "*",
      "a b",
      "a\nb",
      "a_b",
      `a${"b".repeat(64)}`,
    ]) {
      assert.throws(
        () => kmsDebug(name),
        (error: unknown) => {
          assert.ok(error instanceof HardhatPluginError, JSON.stringify(name));
          assert.equal(
            error.message,
            `kmsDebug namespace ${JSON.stringify(name)} is not valid: use 1 to 64 lowercase letters, digits and -, starting with a letter`,
          );
          assert.ok(!error.message.includes("\n"), "the message stays on one line");
          return true;
        },
        JSON.stringify(name),
      );
    }
  });

  it("refuses each of the core's namespaces, including those of the core's own loggers", () => {
    assert.deepEqual(
      [...CORE_NAMESPACES],
      ["account", "config", "history", "providers", "rpc", "signer"],
    );
    process.env.DEBUG = "hardhat:kms:*";
    for (const name of CORE_NAMESPACES) {
      assert.throws(
        () => kmsDebug(name),
        (error: unknown) => {
          assert.ok(error instanceof HardhatPluginError, name);
          assert.equal(
            error.message,
            `kmsDebug namespace "${name}" belongs to hardhat-kms (account, config, history, providers, rpc, signer); log under the provider id instead`,
          );
          return true;
        },
        name,
      );
      assert.ok(coreDebug(name).enabled, name);
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

describe("the core's loggers", () => {
  it("come from coreDebug: no core file but debug.ts calls kmsDebug", async () => {
    const source = path.join(import.meta.dirname, "../../src");
    const entries = await readdir(source, { recursive: true, withFileTypes: true });
    const callers: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        continue;
      }
      const file = path.join(entry.parentPath, entry.name);
      const relative = path.relative(source, file);
      if (relative === path.join("internal", "debug.ts")) {
        continue;
      }
      if (/\bkmsDebug\s*\(/.test(await readFile(file, "utf8"))) {
        callers.push(relative);
      }
    }
    assert.deepEqual(callers, []);
  });
});
