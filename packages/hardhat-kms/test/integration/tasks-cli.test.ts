// Runs the kms tasks through the real Hardhat CLI. The fake adapter holds a timer that keeps the
// process alive, as an SDK client's sockets do, until the adapter is closed; so a task that does
// not close its signers never exits, and the run times out.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TIMEOUT_MS = 30_000;
let project: string;

function hardhat(
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string; output: string } {
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
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    output: `${result.stdout}${result.stderr}`,
  };
}

const CONFIG = (plugin: string, adapter: string) => `import kms from ${JSON.stringify(plugin)};
import { fakeAdapter } from ${JSON.stringify(adapter)};

const secretKey = new Uint8Array(Buffer.from(${JSON.stringify(HARDHAT_ACCOUNT_0.secretKey)}, "hex"));

// Serves "myvault" keys and the --kms key AWS_KMS_KEY_ID with a fake adapter whose open handle
// keeps the process running until the adapter is closed.
const vault = {
  id: "hardhat-kms-tasks-cli-test",
  hookHandlers: {
    kms: async () => ({
      default: async () => ({
        createKeyAdapter: async (context, key, next) => {
          if (key.provider !== "myvault" && key.name !== "AWS_KMS_KEY_ID") {
            return await next(context, key);
          }
          const adapter = fakeAdapter({ secretKey });
          const handle = setInterval(() => {}, 1000);
          adapter.close = async () => clearInterval(handle);
          return adapter;
        },
      }),
    }),
  },
};

export default {
  plugins: [kms, vault],
  kms: { keys: { deployer: { provider: "myvault", name: "deployer" } } },
};
`;

describe("kms tasks from the Hardhat CLI", () => {
  before(() => {
    project = mkdtempSync(path.join(tmpdir(), "hardhat-kms-tasks-cli-"));
    writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "p", type: "module" }),
    );
    writeFileSync(
      path.join(project, "hardhat.config.ts"),
      CONFIG(
        pathToFileURL(path.join(repo, "src/index.ts")).href,
        pathToFileURL(path.join(repo, "test/helpers/fake-adapter.ts")).href,
      ),
    );
    symlinkSync(path.join(repo, "node_modules"), path.join(project, "node_modules"), "junction");
  });

  after(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("prints the address and exits on its own", () => {
    const run = hardhat(["kms", "address", "deployer"]);

    assert.equal(run.status, 0, `the task failed or did not exit:\n${run.output}`);
    assert.equal(run.stdout, `${HARDHAT_ACCOUNT_0.address}\n`);
  });

  it("prints the public key and exits on its own", () => {
    const run = hardhat(["kms", "public-key", "deployer"]);

    assert.equal(run.status, 0, `the task failed or did not exit:\n${run.output}`);
    assert.match(run.stdout, /^0x04[0-9a-f]{128}\n$/);
  });

  it("names a --kms key by its variable", () => {
    const run = hardhat(["--kms", "aws", "kms", "address", "AWS_KMS_KEY_ID"], {
      AWS_KMS_KEY_ID: "alias/from-env",
    });

    assert.equal(run.status, 0, run.output);
    assert.equal(run.stdout, `${HARDHAT_ACCOUNT_0.address}\n`);
  });

  it("fails on an unknown key with the known names", () => {
    const run = hardhat(["kms", "address", "nobody"]);

    assert.notEqual(run.status, 0);
    assert.notEqual(run.status, null, "the task did not exit");
    assert.match(run.output, /unknown key "nobody"\. Known keys: deployer\./);
  });

  it("lists the tasks under kms", () => {
    const run = hardhat(["kms"]);

    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /address\s+Print a KMS key's address/);
    assert.match(run.output, /public-key\s+Print a KMS key's uncompressed public key/);
  });
});
