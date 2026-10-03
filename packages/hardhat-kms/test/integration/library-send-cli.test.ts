// A `hardhat run` script with top-level await that uses a library account next to the plugin's
// own sends, in a child process. Node ends a process whose event loop empties while a top-level
// await is still pending, with exit code 13; node:test keeps its own loop alive and cannot show
// that. So the script runs as a user runs it, and must exit 0.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { COW_ACCOUNT } from "../helpers/vectors.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let project: string;

const CONFIG = (
  plugin: string,
  adapter: string,
) => `import hardhatViem from "@nomicfoundation/hardhat-viem";
import kms from ${JSON.stringify(plugin)};
import { fakeAdapter } from ${JSON.stringify(adapter)};

const secretKey = new Uint8Array(Buffer.from(${JSON.stringify(COW_ACCOUNT.secretKey)}, "hex"));

const vault = {
  id: "hardhat-kms-library-send-cli-test",
  hookHandlers: {
    kms: async () => ({
      default: async () => ({
        createKeyAdapter: async (context, key, next) =>
          key.provider === "myvault" ? fakeAdapter({ secretKey }) : await next(context, key),
      }),
    }),
  },
};

export default {
  plugins: [kms, hardhatViem, vault],
  kms: { keys: { deployer: { provider: "myvault", name: "deployer" } }, simulatedBalance: 10n ** 18n },
  networks: { local: { type: "edr-simulated", kmsAccounts: ["deployer"] } },
};
`;

const SCRIPT = `import { network } from "hardhat";
import { createWalletClient, custom } from "viem";
import { hardhat } from "viem/chains";

const COW = ${JSON.stringify(COW_ACCOUNT.address)};
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const connection = await network.create("local");
const account = await connection.kms.getAccount(COW);
const pending = await connection.provider.request({
  method: "eth_getTransactionCount",
  params: [COW, "pending"],
});
const plugin = await connection.viem.getWalletClient(COW);
const publicClient = await connection.viem.getPublicClient();
const started = Date.now();
const first = await plugin.sendTransaction({ to: TO, value: 1n });
const elapsed = Date.now() - started;
const library = createWalletClient({ account, chain: hardhat, transport: custom(connection.provider) });
const second = await library.sendTransaction({ to: TO, value: 2n });
const third = await plugin.sendTransaction({ to: TO, value: 3n });
const nonces = [];
for (const hash of [first, second, third]) {
  await publicClient.waitForTransactionReceipt({ hash });
  nonces.push((await publicClient.getTransaction({ hash })).nonce);
}
console.log(JSON.stringify({ pending, elapsed, nonces }));
await connection.close();
`;

describe("a library account in a hardhat run script", () => {
  before(() => {
    // Inside the package, as in tasks-cli.test.ts, so the project resolves the package's modules.
    mkdirSync(path.join(repo, ".tmp"), { recursive: true });
    project = mkdtempSync(path.join(repo, ".tmp", "library-send-cli-"));
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
    mkdirSync(path.join(project, "scripts"));
    writeFileSync(path.join(project, "scripts", "send.ts"), SCRIPT);
  });

  after(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("reads the pending count, sends through the plugin and the account, and exits 0", () => {
    const run = spawnSync(
      process.execPath,
      [path.join(repo, "node_modules/hardhat/dist/src/cli.js"), "run", "scripts/send.ts"],
      {
        cwd: project,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_V8_COVERAGE: "",
          NODE_OPTIONS: "",
          HARDHAT_KMS: "",
          AWS_KMS_KEY_ID: "",
          AWS_KMS_KEY_IDS: "",
        },
        timeout: 60_000,
        killSignal: "SIGKILL",
      },
    );
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, `the script did not exit 0 (13 is an unsettled await):\n${output}`);
    const line = run.stdout.trim().split("\n").at(-1) ?? "";
    const result: unknown = JSON.parse(line);
    assert.ok(typeof result === "object" && result !== null);
    assert.equal(Reflect.get(result, "pending"), "0x0", "the node's count, unchanged");
    assert.deepEqual(Reflect.get(result, "nonces"), [0, 1, 2]);
    const elapsed = Reflect.get(result, "elapsed");
    assert.ok(typeof elapsed === "number" && elapsed < 1000, `the first send took ${elapsed} ms`);
  });
});
