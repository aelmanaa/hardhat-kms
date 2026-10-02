// Runs the plugin through the real Hardhat CLI with GOOGLE_APPLICATION_CREDENTIALS naming a file
// that does not exist. The Cloud KMS client starts its initialization from every method, and
// rethrows a failure there into a promise that nothing awaits: unless the adapter handles that
// failure first, the process ends with an unhandled rejection after the task has reported.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Hardhat's first default account, pinned so that personal_sign reaches the key without
// eth_accounts.
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CREDENTIALS_ERROR =
  "the credentials file GOOGLE_APPLICATION_CREDENTIALS names could not be read";
let project: string;

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

function hardhat(args: string[]): { status: number | null; output: string } {
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
        // CI adds --import tsx on Node 22.13 for the test runner; the CLI registers tsx itself.
        NODE_OPTIONS: "",
        GOOGLE_APPLICATION_CREDENTIALS: path.join(project, "missing-credentials.json"),
        HARDHAT_KMS: "",
      },
      timeout: 60_000,
      killSignal: "SIGKILL",
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Checks that the run failed with the catalogue's credentials error, and with nothing else. */
function assertCredentialsError({ status, output }: { status: number | null; output: string }) {
  assert.equal(status, 1, output);
  assert.ok(output.includes(CREDENTIALS_ERROR), output);
  assert.doesNotMatch(output, /unhandled/i);
  assert.doesNotMatch(output, /ENOENT/);
  // google-auth-library's own message names the file's path.
  assert.doesNotMatch(output, /Unable to read the credential file/);
  assert.doesNotMatch(output, /missing-credentials\.json/);
}

describe("a Google Cloud credentials file that does not exist", () => {
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

  it("fails kms address with the credentials error, and nothing crashes after it", () => {
    assertCredentialsError(hardhat(["kms", "address", "deployer"]));
  });

  it("fails a personal_sign request with the credentials error, and nothing crashes after it", () => {
    assertCredentialsError(hardhat(["run", "sign.ts", "--network", "remote"]));
  });

  it("fails kms history with the credentials error, and nothing crashes after it", () => {
    assertCredentialsError(hardhat(["kms", "history", "deployer"]));
  });
});
