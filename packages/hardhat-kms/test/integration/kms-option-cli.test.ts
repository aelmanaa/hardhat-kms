// Runs the real Hardhat CLI, to cover what the programmatic API does not: the HARDHAT_KMS
// environment form and help output.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type HardhatRun, runHardhat } from "../helpers/hardhat-cli.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let project: string;
/** The signal of the running test. */
let signal: AbortSignal | undefined;

/** Runs the Hardhat CLI in the project, under the helper's one limit for startup and task. */
async function hardhat(args: string[], env: Record<string, string>): Promise<HardhatRun> {
  return await runHardhat(args, { cwd: project, env, signal });
}

describe("--kms from the Hardhat CLI", () => {
  // Stops a run when its test ends or times out.
  beforeEach((t) => {
    signal = t.signal;
  });

  before(() => {
    // The project sits inside the package, so Node and Hardhat find `hardhat` and `tsx` in the
    // package's node_modules by the normal upward lookup. A project in os.tmpdir() needs a link to
    // node_modules, and on the Windows runner (temp dir on C:, checkout on D:) lookups through that
    // junction failed: ERR_MODULE_NOT_FOUND for tsx, then HHE22 for hardhat.
    mkdirSync(path.join(repo, ".tmp"), { recursive: true });
    project = mkdtempSync(path.join(repo, ".tmp", "cli-"));
    const plugin = pathToFileURL(path.join(repo, "src/index.ts")).href;
    const keys = pathToFileURL(path.join(repo, "src/internal/hook-handlers/hre.ts")).href;
    writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "p", type: "module" }),
    );
    writeFileSync(
      path.join(project, "hardhat.config.ts"),
      `import kms from ${JSON.stringify(plugin)};\nexport default { plugins: [kms] };\n`,
    );
    writeFileSync(
      path.join(project, "show.ts"),
      `import hre from "hardhat";\nimport { commandLineKeys } from ${JSON.stringify(keys)};\nconsole.log("keys:", commandLineKeys(hre).map((k) => k.displayId).join(" "));\n`,
    );
  });

  after(() => {
    rmSync(project, { recursive: true, force: true });
  });

  // Each test starts its two runs in parallel, so it fits its timeout when each run takes the
  // helper's whole limit.
  it("reads --kms and its HARDHAT_KMS form", async () => {
    const [flag, env] = await Promise.all([
      hardhat(["--kms", "aws", "run", "--no-compile", "show.ts"], { AWS_KMS_KEY_ID: "alias/a" }),
      hardhat(["run", "--no-compile", "show.ts"], {
        HARDHAT_KMS: "aws",
        AWS_KMS_KEY_IDS: "alias/a,alias/b",
      }),
    ]);
    assert.equal(flag.status, 0, flag.report);
    assert.match(flag.output, /keys: aws:<AWS_KMS_KEY_ID>/);
    assert.equal(env.status, 0, env.report);
    assert.match(env.output, /keys: aws:<AWS_KMS_KEY_IDS\[0\]> aws:<AWS_KMS_KEY_IDS\[1\]>/);
  });

  it("fails before the task with a clear error, but still shows help", async () => {
    const [failed, help] = await Promise.all([
      hardhat(["run", "--no-compile", "show.ts"], { HARDHAT_KMS: "aws" }),
      hardhat(["--help"], { HARDHAT_KMS: "aws" }),
    ]);
    assert.notEqual(failed.status, 0, failed.report);
    assert.notEqual(failed.status, null, failed.report);
    assert.match(
      failed.output,
      /--kms aws: set AWS_KMS_KEY_ID, or AWS_KMS_KEY_IDS for several keys/,
    );
    assert.doesNotMatch(failed.output, /keys:/);
    assert.equal(help.status, 0, help.report);
    assert.match(help.output, /--kms/);
  });
});
