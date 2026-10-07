// Runs `scripts/fill-nonce.ts` from the uncertain-sends guide the way a reader runs it, with
// `hardhat run --network`, against a `hardhat node`. The sender is a KMS account whose fake adapter
// signs with a local key and appends a line to a file before each signature, so the test can tell
// that a refused run made no sign request. Nothing reaches a cloud or a live network.
//
// The script imports `hardhat-kms`, which resolves to the built package: run `pnpm run build` first
// (`pnpm test` does). The tests share the node's state and run in order.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

import {
  endChild,
  endWithTestProcess,
  HARDHAT_CLI,
  type HardhatRun,
  hardhatEnv,
  RUN_LIMIT_MS,
  runHardhat,
} from "../helpers/hardhat-cli.ts";
import { createTempProject, removeTempProject } from "../helpers/temp-project.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GUIDE = path.resolve(repo, "../../docs/user/guides/uncertain-sends.md");
const ONE_ETH = 10n ** 18n;
/** An ordinary account with no code. */
const EOA = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
/** Given code that reverts on every call: PUSH0 PUSH0 REVERT. */
const REVERTER = "0x00000000000000000000000000000000000c0de1";
/** Given an EIP-7702 delegation indicator to REVERTER. */
const DELEGATED = "0x00000000000000000000000000000000000c0de2";
/** An EIP-7702 delegation indicator, `0xef0100` followed by the delegate's address. */
const INDICATOR = `0xef0100${REVERTER.slice(2)}`;
const SELF_REFUSAL =
  /^0x[0-9a-fA-F]{40} has code, such as an EIP-7702 delegation, so a transfer to itself runs that code; set TO to an address with no code$/;
const TO_REFUSAL = (to: string): RegExp =>
  new RegExp(`^TO ${getAddress(to)} has code; set TO to an address with no code$`);
const SENT = /^sent (0x[0-9a-f]{64}) with nonce (\d+)$/m;

const CONFIG = (plugin: string, adapter: string) => `import { appendFileSync } from "node:fs";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import kms from ${JSON.stringify(plugin)};
import { fakeAdapter } from ${JSON.stringify(adapter)};

const secretKey = new Uint8Array(Buffer.from(${JSON.stringify(COW_ACCOUNT.secretKey)}, "hex"));

const vault = {
  id: "hardhat-kms-guide-fill-nonce-test",
  hookHandlers: {
    kms: async () => ({
      default: async () => ({
        createKeyAdapter: async (context, key, next) =>
          key.provider === "myvault"
            ? fakeAdapter({
                secretKey,
                randomK: process.env.FILL_NONCE_RANDOM_K === "1",
                beforeSign: async () => {
                  appendFileSync(process.env.FILL_NONCE_SIGN_LOG, "sign\\n");
                },
              })
            : await next(context, key),
      }),
    }),
  },
};

export default {
  plugins: [kms, hardhatViem, vault],
  kms: {
    keys: {
      sender: { provider: "myvault", name: "sender", address: ${JSON.stringify(COW_ACCOUNT.address)} },
    },
  },
  networks: {
    local: {
      type: "http",
      url: process.env.FILL_NONCE_NODE_URL ?? "http://127.0.0.1:1",
      kmsAccounts: ["sender"],
    },
  },
};
`;

let project: string;
let signLog: string;
/** The signal of the running test. */
let signal: AbortSignal | undefined;
let node: ChildProcess | undefined;
let nodeUrl: string;

/** How long `hardhat node` may take to start. */
const NODE_START_LIMIT_MS = 60_000;
/** The script runs in the suite. */
const SCRIPT_RUNS = 11;
/** As in tutorial-return-funds.test.ts: the node's start and every run get their whole limit. */
const SUITE_LIMIT_MS = NODE_START_LIMIT_MS + SCRIPT_RUNS * RUN_LIMIT_MS;

/** The `scripts/fill-nonce.ts` code block of the guide. */
function fillNonceScript(): string {
  const text = readFileSync(GUIDE, "utf8");
  const start = text.indexOf("Save this as `scripts/fill-nonce.ts`:");
  assert.notEqual(start, -1, `${GUIDE}: no fill-nonce script`);
  const match = /```ts\n([\s\S]*?)\n```\n/.exec(text.slice(start));
  assert.ok(match?.[1] !== undefined, `${GUIDE}: no TypeScript block after the script's intro`);
  return `${match[1]}\n`;
}

/** Posts a JSON-RPC request, up to three times when fetch rejects, as tutorial-return-funds does. */
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

async function nonceOf(address: string, blockTag: "latest" | "pending"): Promise<bigint> {
  const result = await rpc("eth_getTransactionCount", [address, blockTag]);
  assert.equal(typeof result, "string");
  return BigInt(String(result));
}

async function receiptOf(hash: string): Promise<unknown> {
  return await rpc("eth_getTransactionReceipt", [hash]);
}

/** The number of sign requests the adapter got so far. */
function signRequests(): number {
  return existsSync(signLog) ? readFileSync(signLog, "utf8").split("\n").length - 1 : 0;
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

/** Runs the guide's script with `hardhat run --network local`, as the guide does. */
async function fillNonce(vars: {
  nonce: bigint;
  to?: string;
  randomK?: boolean;
}): Promise<HardhatRun> {
  const env: Record<string, string> = {
    FILL_NONCE_NODE_URL: nodeUrl,
    FILL_NONCE_SIGN_LOG: signLog,
    FILL_NONCE_RANDOM_K: vars.randomK === true ? "1" : "",
    KMS_ADDRESS: COW_ACCOUNT.address,
    NONCE: vars.nonce.toString(),
  };
  if (vars.to !== undefined) {
    env["TO"] = vars.to;
  }
  return await runHardhat(["run", "--network", "local", "scripts/fill-nonce.ts"], {
    cwd: project,
    env,
    signal,
  });
}

/** The hash a run sent, after checking that it exited 0 with the guide's line. */
function sentHash(run: HardhatRun, nonce: bigint): string {
  assert.equal(run.status, 0, run.report);
  const match = SENT.exec(run.stdout);
  assert.ok(match?.[1] !== undefined, run.report);
  assert.equal(match[2], nonce.toString());
  return match[1];
}

/** Asserts that a run stopped with exit code 1 and the one line `message`, without a stack trace. */
function assertRefused(run: HardhatRun, message: RegExp): void {
  assert.equal(run.status, 1, run.report);
  assert.match(run.stderr.trim(), message);
  assert.equal(run.stderr.trim().split("\n").length, 1, `more than one line:\n${run.stderr}`);
  assert.doesNotMatch(run.stdout, /^sent /m);
  assert.doesNotMatch(run.output, /^\s+at /m, "a stack trace");
}

/** Runs `refused`, and asserts that it made no sign request and that the account's nonces held. */
async function assertNothingSent(refused: () => Promise<void>): Promise<void> {
  const signs = signRequests();
  const latest = await nonceOf(COW_ACCOUNT.address, "latest");
  const pending = await nonceOf(COW_ACCOUNT.address, "pending");
  await refused();
  assert.equal(signRequests(), signs, "a sign request");
  assert.equal(await nonceOf(COW_ACCOUNT.address, "latest"), latest);
  assert.equal(await nonceOf(COW_ACCOUNT.address, "pending"), pending);
}

/** Runs `body` with automine off, then drops the pool and turns automine back on. */
async function withoutAutomine(body: () => Promise<void>): Promise<void> {
  await rpc("evm_setAutomine", [false]);
  try {
    await body();
  } finally {
    const pool = await rpc("eth_getBlockByNumber", ["pending", false]);
    const hashes: unknown = Reflect.get(Object(pool), "transactions");
    for (const hash of Array.isArray(hashes) ? hashes : []) {
      await rpc("hardhat_dropTransaction", [hash]);
    }
    await rpc("evm_setAutomine", [true]);
  }
}

/** The node's own words, from viem's `Details:` line. */
function details(run: HardhatRun): string {
  return /^Details: (.*)$/m.exec(run.output)?.[1] ?? run.output;
}

describe("the uncertain-sends guide's fill-nonce script", { timeout: SUITE_LIMIT_MS }, () => {
  beforeEach((t) => {
    signal = t.signal;
  });

  before(async () => {
    project = createTempProject("guide-fill-nonce-");
    signLog = path.join(project, "signs.log");
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
    writeFileSync(path.join(project, "scripts", "fill-nonce.ts"), fillNonceScript());

    nodeUrl = await startNode();
    await rpc("hardhat_setBalance", [COW_ACCOUNT.address, `0x${ONE_ETH.toString(16)}`]);
    await rpc("hardhat_setCode", [REVERTER, "0x5f5ffd"]);
    await rpc("hardhat_setCode", [DELEGATED, INDICATOR]);
  });

  after(async () => {
    if (node !== undefined) {
      await endChild(node);
    }
    await removeTempProject(project);
  });

  it("fills a gap for an account with no code", async () => {
    const latest = await nonceOf(COW_ACCOUNT.address, "latest");
    await withoutAutomine(async () => {
      // The transaction that waits behind the gap, then the one that fills it.
      const waiting = sentHash(await fillNonce({ nonce: latest + 1n }), latest + 1n);
      assert.equal(
        await nonceOf(COW_ACCOUNT.address, "pending"),
        latest,
        "a gap at the latest count",
      );
      const filler = sentHash(await fillNonce({ nonce: latest }), latest);
      await rpc("evm_mine", []);
      for (const hash of [filler, waiting]) {
        assert.equal(Reflect.get(Object(await receiptOf(hash)), "status"), "0x1");
      }
    });
    assert.equal(await nonceOf(COW_ACCOUNT.address, "latest"), latest + 2n);
  });

  // The guide's step 4 quotes these answers of Hardhat's node, which runs EDR.
  it("gets Known transaction for the same bytes, and underpriced for a new signature", async () => {
    const nonce = await nonceOf(COW_ACCOUNT.address, "latest");
    await withoutAutomine(async () => {
      const first = sentHash(await fillNonce({ nonce }), nonce);
      // RFC 6979: the same transaction gets the same signature, so the same hash.
      const same = await fillNonce({ nonce });
      assert.equal(same.status, 1, same.report);
      assert.equal(details(same), `Known transaction: ${first}`);
      // A random k, as AWS KMS uses: the same transaction gets a new signature and a new hash.
      const signs = signRequests();
      const resigned = await fillNonce({ nonce, randomK: true });
      assert.equal(signRequests(), signs + 1, "the re-run signs again");
      assert.equal(resigned.status, 1, resigned.report);
      assert.match(
        details(resigned),
        /^Replacement transaction underpriced\. A gasPrice\/maxFeePerGas of at least \d+ is necessary to replace the existing transaction with nonce \d+\.$/,
      );
      // The first transaction is still the one in the pool.
      const pool = await rpc("eth_getBlockByNumber", ["pending", false]);
      assert.deepEqual(Reflect.get(Object(pool), "transactions"), [first]);
    });
  });

  it("refuses when a delegation of the account is in the pool, not mined", async () => {
    const nonce = await nonceOf(COW_ACCOUNT.address, "latest");
    await withoutAutomine(async () => {
      // Another account sends a type-4 transaction that carries the account's authorization.
      const authority = privateKeyToAccount(`0x${COW_ACCOUNT.secretKey}`);
      const authorization = await authority.signAuthorization({
        address: REVERTER,
        chainId: hardhat.id,
        nonce: Number(nonce),
      });
      const sponsor = createWalletClient({
        account: privateKeyToAccount(`0x${HARDHAT_ACCOUNT_0.secretKey}`),
        chain: hardhat,
        transport: http(nodeUrl),
      });
      const delegation = await sponsor.sendTransaction({
        to: sponsor.account.address,
        authorizationList: [authorization],
      });
      const pool = await rpc("eth_getBlockByNumber", ["pending", false]);
      assert.deepEqual(Reflect.get(Object(pool), "transactions"), [delegation]);
      assert.equal(await rpc("eth_getCode", [COW_ACCOUNT.address, "latest"]), "0x");
      assert.equal(await rpc("eth_getCode", [COW_ACCOUNT.address, "pending"]), INDICATOR);
      await assertNothingSent(async () => {
        assertRefused(await fillNonce({ nonce: nonce + 1n }), SELF_REFUSAL);
      });
    });
    assert.equal(await rpc("eth_getCode", [COW_ACCOUNT.address, "latest"]), "0x");
  });

  describe("an account with an EIP-7702 delegation to code that reverts", () => {
    before(async () => {
      await rpc("hardhat_setCode", [COW_ACCOUNT.address, INDICATOR]);
    });

    after(async () => {
      await rpc("hardhat_setCode", [COW_ACCOUNT.address, "0x"]);
    });

    it("refuses the transfer to itself, and makes no sign request", async () => {
      const nonce = await nonceOf(COW_ACCOUNT.address, "latest");
      await assertNothingSent(async () => {
        assertRefused(await fillNonce({ nonce }), SELF_REFUSAL);
      });
    });

    for (const [name, to] of [
      ["a contract", REVERTER],
      ["another delegated account", DELEGATED],
    ] as const) {
      it(`refuses TO set to ${name}`, async () => {
        const nonce = await nonceOf(COW_ACCOUNT.address, "latest");
        await assertNothingSent(async () => {
          assertRefused(await fillNonce({ nonce, to }), TO_REFUSAL(to));
        });
      });
    }

    it("refuses a TO that is not an address", async () => {
      const nonce = await nonceOf(COW_ACCOUNT.address, "latest");
      await assertNothingSent(async () => {
        assertRefused(
          await fillNonce({ nonce, to: "0x123" }),
          /^TO is not a valid address, or its checksum is wrong: 0x123$/,
        );
      });
    });

    it("fills the nonce with TO set to an address with no code", async () => {
      const nonce = await nonceOf(COW_ACCOUNT.address, "latest");
      const signs = signRequests();
      const hash = sentHash(await fillNonce({ nonce, to: EOA }), nonce);
      assert.equal(signRequests(), signs + 1);
      const receipt = await receiptOf(hash);
      assert.equal(Reflect.get(Object(receipt), "status"), "0x1");
      assert.equal(String(Reflect.get(Object(receipt), "to")).toLowerCase(), EOA.toLowerCase());
      assert.equal(await nonceOf(COW_ACCOUNT.address, "latest"), nonce + 1n);
    });
  });
});
