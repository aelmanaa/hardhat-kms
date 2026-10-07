// A `hardhat run` script with top-level await that uses a library account next to the plugin's
// own sends, in a child process. Node ends a process whose event loop empties while a top-level
// await is still pending, with exit code 13; node:test keeps its own loop alive and cannot show
// that. So the script runs as a user runs it, and must exit 0.
//
// The script prints READY once its connection exists. Starting Hardhat, viem and the simulated node
// takes 3 s on an idle machine and can take over 40 s on a busy one, so the run gets
// STARTUP_LIMIT_MS for that. Startup is not timed beyond that limit.
//
// After READY, no send should wait on a timer, so the script times its reads and sends from READY
// to the third send, and they must take under SENDS_BOUND_MS. They take under 2 s even with 32
// runs in parallel, so the bound fails a wait of a few seconds but not a loaded machine. The test
// also stops the script at the plugin's first warning, such as the one printed when a send has
// waited 5 s behind a library send's hold, and SENDS_LIMIT_MS after READY, below the 60 s hold
// limit and the 120 s stall limit, so a stuck send fails before either limit. Each failure shows
// the output.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runHardhat } from "../helpers/hardhat-cli.ts";
import { createTempProject, removeTempProject } from "../helpers/temp-project.ts";
import { COW_ACCOUNT } from "../helpers/vectors.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let project: string;

/** How long the script may take to start Hardhat, viem and its connection. */
const STARTUP_LIMIT_MS = 100_000;
/** How long the sends may take after the connection exists before the test stops the script. */
const SENDS_LIMIT_MS = 30_000;
/** How long the reads and sends from READY to the third send may take in a passing run. */
const SENDS_BOUND_MS = 5000;
/** The start of a plugin warning on stderr. */
const WARNING = /^hardhat-kms: /m;

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
const ready = Date.now();
console.log("READY");
const account = await connection.kms.getAccount(COW);
const pending = await connection.provider.request({
  method: "eth_getTransactionCount",
  params: [COW, "pending"],
});
const plugin = await connection.viem.getWalletClient(COW);
const publicClient = await connection.viem.getPublicClient();
const first = await plugin.sendTransaction({ to: TO, value: 1n });
const library = createWalletClient({ account, chain: hardhat, transport: custom(connection.provider) });
const second = await library.sendTransaction({ to: TO, value: 2n });
const third = await plugin.sendTransaction({ to: TO, value: 3n });
const sendsMs = Date.now() - ready;
const nonces = [];
for (const hash of [first, second, third]) {
  await publicClient.waitForTransactionReceipt({ hash });
  nonces.push((await publicClient.getTransaction({ hash })).nonce);
}
console.log(JSON.stringify({ pending, nonces, sendsMs }));
await connection.close();
`;

describe("a library account in a hardhat run script", () => {
  before(() => {
    project = createTempProject("library-send-cli-");
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

  after(async () => {
    await removeTempProject(project);
  });

  it(
    "reads the pending count, sends through the plugin and the account, and exits 0",
    {
      timeout: STARTUP_LIMIT_MS + SENDS_LIMIT_MS + 10_000,
    },
    async (t) => {
      // Stops the script when it starts too slowly, when its sends take too long, or at the
      // plugin's first warning.
      const run = await runHardhat(["run", "scripts/send.ts"], {
        cwd: project,
        limits: {
          ready: /^READY$/m,
          startupLimitMs: STARTUP_LIMIT_MS,
          workLimitMs: SENDS_LIMIT_MS,
        },
        stopOn: { pattern: WARNING, reason: "the plugin printed a warning" },
        signal: t.signal,
      });
      const output = run.report;
      assert.equal(run.stopped, undefined, `the test stopped the script\n${output}`);
      assert.equal(run.status, 0, `the script did not exit 0\n${output}`);
      assert.doesNotMatch(run.stderr, WARNING, `no send should wait\n${output}`);
      const line = run.stdout.trim().split("\n").at(-1) ?? "";
      const result: unknown = JSON.parse(line);
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(Reflect.get(result, "pending"), "0x0", "the node's count, unchanged");
      assert.deepEqual(Reflect.get(result, "nonces"), [0, 1, 2]);
      const sendsMs = Reflect.get(result, "sendsMs");
      assert.ok(
        typeof sendsMs === "number" && sendsMs < SENDS_BOUND_MS,
        `the reads and sends after READY took ${sendsMs} ms; no send should wait on a timer\n${output}`,
      );
    },
  );
});
