// Runs the plugin through the real Hardhat CLI with GOOGLE_APPLICATION_CREDENTIALS naming a file
// that does not exist. The Cloud KMS client starts its initialization from every method, and
// rethrows a failure there into a promise that nothing awaits: unless the adapter handles that
// failure first, the process ends with an unhandled rejection after the task has reported.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type HardhatRun, runHardhat } from "../../../hardhat-kms/test/helpers/hardhat-cli.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Hardhat's first default account, pinned so that personal_sign reaches the key without
// eth_accounts.
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CREDENTIALS_ERROR =
  "the credentials file GOOGLE_APPLICATION_CREDENTIALS names could not be read";
let project: string;
/** The signal of the running test. */
let signal: AbortSignal | undefined;

const CONFIG = (plugin: string) => `import gcp from ${JSON.stringify(plugin)};

export default {
  plugins: [gcp],
  kms: {
    keys: {
      deployer: {
        provider: "gcp",
        keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
        address: ${JSON.stringify(ADDRESS)},
      },
    },
  },
  networks: {
    remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["deployer"] },
  },
};
`;

// Signs once through the network connection, as a script run with \`hardhat run\` does.
const SIGN_SCRIPT = `import { network } from "hardhat";

const { provider } = await network.create();
await provider.request({ method: "personal_sign", params: ["0x00", ${JSON.stringify(ADDRESS)}] });
`;

/** Runs the Hardhat CLI in the project, under the helper's one limit for startup and task. */
async function hardhat(args: string[]): Promise<HardhatRun> {
  return await runHardhat(args, {
    cwd: project,
    env: { GOOGLE_APPLICATION_CREDENTIALS: path.join(project, "missing-credentials.json") },
    signal,
  });
}

/** Checks that the run failed with the catalogue's credentials error, and with nothing else. */
function assertCredentialsError({ status, output, report }: HardhatRun) {
  assert.equal(status, 1, report);
  assert.ok(output.includes(CREDENTIALS_ERROR), report);
  assert.doesNotMatch(output, /unhandled/i);
  assert.doesNotMatch(output, /ENOENT/);
  // google-auth-library's own message names the file's path.
  assert.doesNotMatch(output, /Unable to read the credential file/);
  assert.doesNotMatch(output, /missing-credentials\.json/);
}

describe("a Google Cloud credentials file that does not exist", () => {
  // Stops a run when its test ends or times out.
  beforeEach((t) => {
    signal = t.signal;
  });

  before(() => {
    // Inside the package, as in hardhat-kms's CLI tests: a project in os.tmpdir() needs a link to
    // node_modules, which fails on the Windows runner.
    mkdirSync(path.join(repo, ".tmp"), { recursive: true });
    project = mkdtempSync(path.join(repo, ".tmp", "credentials-cli-"));
    writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "p", type: "module" }),
    );
    writeFileSync(
      path.join(project, "hardhat.config.ts"),
      CONFIG(pathToFileURL(path.join(repo, "src/index.ts")).href),
    );
    writeFileSync(path.join(project, "sign.ts"), SIGN_SCRIPT);
  });

  after(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("fails kms address with the credentials error, and nothing crashes after it", async () => {
    assertCredentialsError(await hardhat(["kms", "address", "deployer"]));
  });

  it("fails a personal_sign request with the credentials error, and nothing crashes after it", async () => {
    assertCredentialsError(await hardhat(["run", "sign.ts", "--network", "remote"]));
  });

  it("fails kms history with the credentials error, and nothing crashes after it", async () => {
    assertCredentialsError(await hardhat(["kms", "history", "deployer"]));
  });
});
