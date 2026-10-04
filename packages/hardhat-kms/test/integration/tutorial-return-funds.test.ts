// Runs `scripts/return-funds.ts` from step 8 of the first-deploy tutorials the way a reader runs it,
// with `hardhat run`, against a `hardhat node` in place of Sepolia. The deployer is a KMS account
// whose fake adapter signs with a local key, so nothing reaches a cloud or a live network. The node
// runs with `throwOnTransactionFailures: false`, so a reverted transfer is mined and returns its
// hash, as it does on Sepolia.
//
// The script imports `hardhat-kms`, which resolves to the built package: run `pnpm run build` first
// (`pnpm test` does). The tests share the node's state and run in order: the refusals, then the
// reverted transfer, then the transfer that is not mined in time, then the transfer that empties
// the deployer, then the second run.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  endWithTestProcess,
  HARDHAT_CLI,
  type HardhatRun,
  hardhatEnv,
  RUN_LIMIT_MS,
  runHardhat,
} from "../helpers/hardhat-cli.ts";
import { COW_ACCOUNT } from "../helpers/vectors.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TUTORIALS = ["aws", "gcp", "azure"].map((provider) =>
  path.resolve(repo, `../../docs/user/tutorials/first-deploy-${provider}.md`),
);
const ONE_ETH = 10n ** 18n;
/** An ordinary account with no code. */
const EOA = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
/** Given code that reverts on every call: PUSH0 PUSH0 REVERT. */
const CONTRACT = "0x00000000000000000000000000000000000c0de1";
/** Given an EIP-7702 delegation indicator, `0xef0100` followed by the delegate's address. */
const DELEGATED = "0x00000000000000000000000000000000000c0de2";
/** An ordinary account's address with one letter's case flipped, which breaks its checksum. */
const BAD_CHECKSUM = "0x70997970c51812dc3A010C7d01b50e0d17dc79C8";
const ZERO = "0x0000000000000000000000000000000000000000";
/** The receipt wait, as the tutorials print it, with viem's default timeout. */
const RECEIPT_WAIT = /\.waitForTransactionReceipt\(\{ hash \}\)/;
const CODE_REFUSAL = /has code, so it is a contract or a smart account \(EIP-7702\)/;
/** The comment and the check that refuse an address with code, as the tutorials print them. */
const CODE_CHECK =
  /\n {2}\/\/ A plain transfer with 21,000 gas runs out of gas at an address with code[^\n]*\n {2}if \(\(await publicClient\.getCode\(\{ address: to \}\)\) !== undefined\) \{\n[^\n]*\n {2}\}\n/;

const CONFIG = (
  plugin: string,
  adapter: string,
) => `import hardhatViem from "@nomicfoundation/hardhat-viem";
import kms from ${JSON.stringify(plugin)};
import { fakeAdapter } from ${JSON.stringify(adapter)};

const secretKey = new Uint8Array(Buffer.from(${JSON.stringify(COW_ACCOUNT.secretKey)}, "hex"));

const vault = {
  id: "hardhat-kms-tutorial-return-funds-test",
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
  kms: {
    keys: {
      deployer: { provider: "myvault", name: "deployer", address: ${JSON.stringify(COW_ACCOUNT.address)} },
    },
  },
  networks: {
    node: { type: "edr-simulated", throwOnTransactionFailures: false },
    sepolia: {
      type: "http",
      url: process.env.RETURN_FUNDS_NODE_URL ?? "http://127.0.0.1:1",
      kmsAccounts: ["deployer"],
    },
  },
};
`;

let project: string;
/** The signal of the running test. */
let signal: AbortSignal | undefined;
let node: ChildProcess | undefined;
let nodeUrl: string;

/** The RETURN_TO values the script refuses before it sends, and its message for each. */
const refusals: [name: string, returnTo: string | undefined, message: RegExp][] = [
  ["a missing RETURN_TO", undefined, /^set RETURN_TO to the address that gets the funds$/],
  [
    "a malformed RETURN_TO",
    "0x123",
    /^RETURN_TO is not a valid address, or its checksum is wrong: 0x123$/,
  ],
  [
    "a RETURN_TO with a wrong checksum",
    BAD_CHECKSUM,
    /^RETURN_TO is not a valid address, or its checksum is wrong: 0x70997970c5/,
  ],
  ["the zero address", ZERO, /^RETURN_TO is the zero address, and funds sent there are lost$/],
  [
    "the deployer address",
    COW_ACCOUNT.address,
    /^RETURN_TO is the deployer address 0x[0-9a-fA-F]{40}; set it to the address that gets/,
  ],
  ["a contract", CONTRACT, CODE_REFUSAL],
  ["an EIP-7702 delegated account", DELEGATED, CODE_REFUSAL],
];

/** How long `hardhat node` may take to start. */
const NODE_START_LIMIT_MS = 60_000;
/** The script runs in the suite: one per refusal, then the four that reach a transfer. */
const SCRIPT_RUNS = refusals.length + 4;
/**
 * The tests share the node and run one after another. Under load a run takes over 50 s, so the
 * suite's limit gives the node's start and every run its whole limit: 1160 s. That applies to local
 * runs only. In CI the job's 15-minute timeout, and on Node 22 the 600 s budget `--test-timeout`
 * puts on the whole file, come first; a hang there ends at the test's or the run's own limit. Each
 * test keeps its own limit.
 */
const SUITE_LIMIT_MS = NODE_START_LIMIT_MS + SCRIPT_RUNS * RUN_LIMIT_MS;

/** The `scripts/return-funds.ts` code block of a tutorial. */
function returnFundsScript(tutorial: string): string {
  const text = readFileSync(tutorial, "utf8");
  const start = text.indexOf("Save this script as `scripts/return-funds.ts`.");
  assert.notEqual(start, -1, `${tutorial} has no return-funds script`);
  const match = /```ts\n([\s\S]*?)\n```\n/.exec(text.slice(start));
  assert.ok(match?.[1] !== undefined, `${tutorial}: no TypeScript block after the script's intro`);
  return `${match[1]}\n`;
}

/**
 * Posts a JSON-RPC request to the node, and sends it again, up to three times in all, when fetch
 * rejects. The node closes idle keep-alive connections while a script runs, and a request that races
 * the close fails with ECONNRESET. Any other rejection is retried too, the 10-second timeout
 * included; a JSON-RPC error is an answer and is not retried. Every request this test sends is safe
 * to repeat.
 */
async function post(body: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(nodeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (attempt === 3) {
        throw error;
      }
    }
  }
}

/** Sends one JSON-RPC request to the node and returns its result. */
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  const body: unknown = await response.json();
  const error: unknown = Reflect.get(Object(body), "error");
  if (error !== undefined) {
    throw new Error(`${method} failed: ${JSON.stringify(error)}`);
  }
  return Reflect.get(Object(body), "result");
}

async function balanceOf(address: string): Promise<bigint> {
  const result = await rpc("eth_getBalance", [address, "latest"]);
  assert.equal(typeof result, "string");
  return BigInt(String(result));
}

async function nonceOf(address: string): Promise<bigint> {
  const result = await rpc("eth_getTransactionCount", [address, "latest"]);
  assert.equal(typeof result, "string");
  return BigInt(String(result));
}

async function receiptStatus(hash: string): Promise<unknown> {
  return Reflect.get(Object(await rpc("eth_getTransactionReceipt", [hash])), "status");
}

/** Starts `hardhat node` on a free port in the project, and resolves with its URL. */
async function startNode(): Promise<string> {
  // Node runs Hardhat's CLI directly, without pnpm in between, so that kill() stops the server.
  const started = spawn(process.execPath, [HARDHAT_CLI, "node", "--port", "0"], {
    cwd: project,
    env: hardhatEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  node = started;
  endWithTestProcess(started);
  let output = "";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`hardhat node did not start:\n${output}`));
    }, NODE_START_LIMIT_MS);
    const read = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      const match = /JSON-RPC server at (http:\/\/[^/\s]+)\//.exec(output);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    started.stdout.on("data", read);
    started.stderr.on("data", read);
    started.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`hardhat node exited with ${String(code)}:\n${output}`));
    });
  });
}

/**
 * Runs a script of the project with `hardhat run`, as the tutorial does. A script from the docs
 * prints no READY marker, so the run gets the helper's one limit for startup and work.
 */
async function runScript(script: string, returnTo: string | undefined): Promise<HardhatRun> {
  return await runHardhat(["run", script], {
    cwd: project,
    env: { RETURN_FUNDS_NODE_URL: nodeUrl, RETURN_TO: returnTo ?? "" },
    signal,
  });
}

/** Asserts that a run stopped with exit code 1 and the one line `message`, without a stack trace. */
function assertStopped(run: HardhatRun, message: RegExp): void {
  const output = run.output;
  assert.equal(run.status, 1, run.report);
  assert.match(run.stderr.trim(), message);
  assert.equal(run.stderr.trim().split("\n").length, 1, `more than one line:\n${run.stderr}`);
  assert.doesNotMatch(output, /sent in/);
  assert.doesNotMatch(output, /^\s+at /m, "a stack trace");
  assert.doesNotMatch(output, /bug in Hardhat/);
}

describe("the tutorials' return-funds script", { timeout: SUITE_LIMIT_MS }, () => {
  // Stops a run when its test ends or times out.
  beforeEach((t) => {
    signal = t.signal;
  });

  before(async () => {
    // Inside the package, as in library-send-cli.test.ts, so the project resolves its modules.
    mkdirSync(path.join(repo, ".tmp"), { recursive: true });
    project = mkdtempSync(path.join(repo, ".tmp", "tutorial-return-funds-"));
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
    const script = returnFundsScript(TUTORIALS[0] ?? "");
    assert.match(script, CODE_CHECK, "the code check is not where the test expects it");
    mkdirSync(path.join(project, "scripts"));
    writeFileSync(path.join(project, "scripts", "return-funds.ts"), script);
    // The reverted branch is unreachable with the code check, so a copy without it reaches it.
    writeFileSync(
      path.join(project, "scripts", "return-funds-unchecked.ts"),
      script.replace(CODE_CHECK, "\n"),
    );
    // A copy that waits 2 seconds for the receipt instead of viem's default of 3 minutes.
    assert.match(script, RECEIPT_WAIT, "the receipt wait is not where the test expects it");
    writeFileSync(
      path.join(project, "scripts", "return-funds-short-wait.ts"),
      script.replace(RECEIPT_WAIT, ".waitForTransactionReceipt({ hash, timeout: 2_000 })"),
    );

    nodeUrl = await startNode();
    await rpc("hardhat_setBalance", [COW_ACCOUNT.address, `0x${ONE_ETH.toString(16)}`]);
    await rpc("hardhat_setCode", [CONTRACT, "0x5f5ffd"]);
    await rpc("hardhat_setCode", [DELEGATED, `0xef0100${EOA.slice(2).toLowerCase()}`]);
  });

  after(() => {
    node?.kill();
    rmSync(project, { recursive: true, force: true });
  });

  it("is the same in the three tutorials", () => {
    const [aws, ...others] = TUTORIALS.map(returnFundsScript);
    for (const [index, other] of others.entries()) {
      assert.equal(other, aws, `${TUTORIALS[index + 1] ?? ""} differs from ${TUTORIALS[0] ?? ""}`);
    }
  });

  for (const [name, returnTo, message] of refusals) {
    it(`refuses ${name} and sends nothing`, async () => {
      const balance = await balanceOf(COW_ACCOUNT.address);
      const nonce = await nonceOf(COW_ACCOUNT.address);
      const run = await runScript("scripts/return-funds.ts", returnTo);
      assertStopped(run, message);
      assert.doesNotMatch(run.stdout, /sending/);
      assert.equal(await balanceOf(COW_ACCOUNT.address), balance);
      assert.equal(await nonceOf(COW_ACCOUNT.address), nonce);
    });
  }

  it("reports a reverted transfer with its hash, and exits 1", async () => {
    const balance = await balanceOf(COW_ACCOUNT.address);
    const run = await runScript("scripts/return-funds-unchecked.ts", CONTRACT);
    assertStopped(
      run,
      /^the transfer reverted in 0x[0-9a-f]{64}; only the fee was spent, and the rest is still at 0x/,
    );
    const hash = /0x[0-9a-f]{64}/.exec(run.stderr)?.[0];
    assert.ok(hash !== undefined);
    assert.equal(await receiptStatus(hash), "0x0", "the transfer was mined and reverted");
    const left = await balanceOf(COW_ACCOUNT.address);
    assert.ok(left < balance && left > balance / 2n, "only the fee was spent");
  });

  it("reports a transfer that is not mined in time with its hash, and exits 1", async () => {
    const balance = await balanceOf(COW_ACCOUNT.address);
    const nonce = await nonceOf(COW_ACCOUNT.address);
    // The node keeps the transfer pending, as a congested network can.
    await rpc("evm_setAutomine", [false]);
    let hash: string | undefined;
    try {
      const run = await runScript("scripts/return-funds-short-wait.ts", EOA);
      // Read first, so that a failed assertion still drops the transfer.
      hash = /0x[0-9a-f]{64}/.exec(`${run.stdout}${run.stderr}`)?.[0];
      assertStopped(
        run,
        /^the transfer 0x[0-9a-f]{64} is not confirmed yet and may still go through; look it up on a Sepolia explorer before you run the script again$/,
      );
      assert.match(run.stdout, /^sending [\d.]+ ETH from 0x[0-9a-fA-F]{40} to 0x[0-9a-fA-F]{40}$/m);
      assert.ok(hash !== undefined);
      const pending = await rpc("eth_getTransactionByHash", [hash]);
      assert.equal(Reflect.get(Object(pending), "blockNumber"), null, "the transfer is pending");
    } finally {
      // Drops the pending transfer, so the next tests start from the same balance and nonce.
      if (hash !== undefined) {
        await rpc("hardhat_dropTransaction", [hash]);
      }
      await rpc("evm_setAutomine", [true]);
    }
    assert.equal(await balanceOf(COW_ACCOUNT.address), balance);
    assert.equal(await nonceOf(COW_ACCOUNT.address), nonce);
  });

  it("sends the balance to an address with no code", async () => {
    const received = await balanceOf(EOA);
    const run = await runScript("scripts/return-funds.ts", EOA);
    assert.equal(run.status, 0, run.report);
    assert.match(run.stdout, /^sending [\d.]+ ETH from 0x[0-9a-fA-F]{40} to 0x[0-9a-fA-F]{40}$/m);
    const hash = /^sent in (0x[0-9a-f]{64})$/m.exec(run.stdout)?.[1];
    assert.ok(hash !== undefined, run.stdout);
    assert.equal(await receiptStatus(hash), "0x1");
    assert.ok((await balanceOf(EOA)) > received + ONE_ETH / 2n, "the recipient got the funds");
    const left = await balanceOf(COW_ACCOUNT.address);
    assert.ok(left < 10n ** 15n, `the deployer still holds ${left} wei`);
  });

  it("stops on a second run, when the balance does not cover the fee", async () => {
    assertStopped(
      await runScript("scripts/return-funds.ts", EOA),
      /^the balance of 0x[0-9a-fA-F]{40}, [\d.e-]+ ETH, does not cover the fee$/,
    );
  });
});
