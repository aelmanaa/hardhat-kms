// Runs the real Hardhat CLI, to cover what the programmatic API does not: the HARDHAT_KMS
// environment form and help output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let project: string;

function hardhat(
  args: string[],
  env: Record<string, string>,
): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    [path.join(repo, "node_modules/hardhat/dist/src/cli.js"), ...args],
    {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        // A black-box run: Hardhat loads the plugin through its own TypeScript loader, and that
        // coverage data would clash with the native runs of the same files.
        NODE_V8_COVERAGE: "",
        AWS_KMS_KEY_ID: "",
        AWS_KMS_KEY_IDS: "",
        HARDHAT_KMS: "",
        ...env,
      },
      timeout: 60_000,
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("--kms from the Hardhat CLI", () => {
  before(() => {
    project = mkdtempSync(path.join(tmpdir(), "hardhat-kms-cli-"));
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
    symlinkSync(path.join(repo, "node_modules"), path.join(project, "node_modules"), "junction");
  });

  after(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("reads --kms and its HARDHAT_KMS form", () => {
    const flag = hardhat(["--kms", "aws", "run", "show.ts"], { AWS_KMS_KEY_ID: "alias/a" });
    assert.equal(flag.status, 0, flag.output);
    assert.match(flag.output, /keys: aws:<AWS_KMS_KEY_ID>/);

    const env = hardhat(["run", "show.ts"], {
      HARDHAT_KMS: "aws",
      AWS_KMS_KEY_IDS: "alias/a,alias/b",
    });
    assert.equal(env.status, 0, env.output);
    assert.match(env.output, /keys: aws:<AWS_KMS_KEY_IDS\[0\]> aws:<AWS_KMS_KEY_IDS\[1\]>/);
  });

  it("fails before the task with a clear error, but still shows help", () => {
    const failed = hardhat(["run", "show.ts"], { HARDHAT_KMS: "aws" });
    assert.notEqual(failed.status, 0);
    assert.match(
      failed.output,
      /--kms aws: set AWS_KMS_KEY_ID, or AWS_KMS_KEY_IDS for several keys/,
    );
    assert.doesNotMatch(failed.output, /keys:/);

    const help = hardhat(["--help"], { HARDHAT_KMS: "aws" });
    assert.equal(help.status, 0, help.output);
    assert.match(help.output, /--kms/);
  });
});
