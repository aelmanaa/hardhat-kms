// The runtime deprecation check of the Node 26 CI test leg (`scripts/deprecation-hook.ts`, preloaded
// by `scripts/fail-on-deprecation.mjs`): a DeprecationWarning that the allowlist does not list fails
// the process, even one that later exits with code 0; an allowed one and other warnings do not.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ALLOWED_WARNINGS, failOnDeprecation } from "../../scripts/deprecation-hook.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** A stand-in for `process`: an emitter with an exit code. */
class FakeProcess extends EventEmitter {
  exitCode: number | string | null | undefined;
}

function deprecation(message: string, code?: string): Error {
  const warning = new Error(message);
  warning.name = "DeprecationWarning";
  return code === undefined ? warning : Object.assign(warning, { code });
}

function install(allowed: { warning: string; reason: string; link: string }[] = []): {
  target: FakeProcess;
  failed: () => boolean;
  output: string[];
} {
  const target = new FakeProcess();
  const output: string[] = [];
  const failed = failOnDeprecation(target, allowed, (text) => output.push(text));
  return { target, failed, output };
}

describe("failOnDeprecation", () => {
  it("fails on a DeprecationWarning whose code is not allowed, and prints it", () => {
    const { target, failed, output } = install();
    target.emit("warning", deprecation("old API", "DEP9999"));
    assert.equal(failed(), true);
    assert.equal(target.exitCode, 1);
    assert.match(output.join(""), /^fail-on-deprecation: DEP9999 is not in ALLOWED_WARNINGS/);
    assert.match(output.join(""), /DeprecationWarning: old API/);
  });

  it("passes a DeprecationWarning whose code is allowed", () => {
    const { target, failed, output } = install([{ warning: "DEP9999", reason: "r", link: "l" }]);
    target.emit("warning", deprecation("old API", "DEP9999"));
    target.emit("exit", 0);
    assert.equal(failed(), false);
    assert.equal(target.exitCode, undefined);
    assert.deepEqual(output, []);
  });

  it("matches a warning without a code by its message", () => {
    const { target, failed } = install([{ warning: "old API", reason: "r", link: "l" }]);
    target.emit("warning", deprecation("old API"));
    assert.equal(failed(), false);
    target.emit("warning", deprecation("another API"));
    assert.equal(failed(), true);
  });

  it("ignores warnings that are not deprecations", () => {
    const { target, failed } = install();
    const warning = new Error("too many listeners");
    warning.name = "MaxListenersExceededWarning";
    target.emit("warning", warning);
    assert.equal(failed(), false);
    assert.equal(target.exitCode, undefined);
  });

  it("keeps a failing exit code the process already set", () => {
    const { target } = install();
    target.exitCode = 3;
    target.emit("warning", deprecation("old API", "DEP9999"));
    target.emit("exit", 3);
    assert.equal(target.exitCode, 3);
  });

  it("keeps the exit code failing when the process later sets it to 0", () => {
    const { target } = install();
    target.emit("warning", deprecation("old API", "DEP9999"));
    target.exitCode = 0;
    target.emit("exit", 0);
    assert.equal(target.exitCode, 1);
  });

  it("starts with an allowlist whose entries have a reason and a link", () => {
    for (const entry of ALLOWED_WARNINGS) {
      assert.ok(entry.reason.length > 0, entry.warning);
      assert.match(entry.link, /^https:\/\//, entry.warning);
    }
  });
});

describe("scripts/fail-on-deprecation.mjs", () => {
  const preload = pathToFileURL(path.join(root, "scripts/fail-on-deprecation.mjs")).href;
  const run = (code: string): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", code], {
      cwd: root,
      encoding: "utf8",
    });

  it("makes a process that emits an unlisted DeprecationWarning exit with code 1", () => {
    const result = run(
      'process.emitWarning("old API", { type: "DeprecationWarning", code: "DEP_HOOK_TEST" }); setTimeout(() => process.exit(0), 10);',
    );
    assert.equal(result.status, 1, String(result.stderr));
    assert.match(String(result.stderr), /fail-on-deprecation: DEP_HOOK_TEST is not in/);
  });

  it("leaves a process with other warnings alone", () => {
    const result = run('process.emitWarning("a plain warning");');
    assert.equal(result.status, 0, String(result.stderr));
  });
});
