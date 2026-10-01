// `kms sign-tx`: fills and signs on --network, prints the raw transaction and its hash, and never
// broadcasts. Its bytes must equal those of eth_signTransaction for the same request on the same
// chain state.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { rpcTransactionRequest } from "@nomicfoundation/hardhat-zod-utils/rpc";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import type { NetworkUserConfig } from "hardhat/types/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { authorization, Transaction } from "micro-eth-signer";

import hardhatKms from "../../src/index.ts";
import { KNOWN_FIELDS } from "../../src/internal/tasks/sign-tx.ts";
import { type FakeAdapter, fakeAdapter } from "../helpers/fake-adapter.ts";
import { type RecordingNode, startRecordingNode } from "../helpers/recording-node.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const FROM = HARDHAT_ACCOUNT_0.address;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
// Creation code that deploys a contract returning 42.
const INIT_CODE = "0x600a600c600039600a6000f3602a60005260206000f3";
/** The fake adapter's key id, which no error may print. */
const FAKE_KEY_ID = "fake-key-1";

const AUTHORIZATION = authorization.sign(
  { chainId: 31337n, address: TO, nonce: 1n },
  `0x${HARDHAT_ACCOUNT_0.secretKey}`,
);
const RPC_AUTHORIZATION = {
  chainId: "0x7a69",
  address: TO,
  nonce: "0x1",
  yParity: `0x${AUTHORIZATION.yParity.toString(16)}`,
  r: `0x${AUTHORIZATION.r.toString(16).padStart(64, "0")}`,
  s: `0x${AUTHORIZATION.s.toString(16).padStart(64, "0")}`,
};

/** The secret key behind each key name. */
const SECRET_KEYS: Record<string, string> = {
  zero: HARDHAT_ACCOUNT_0.secretKey,
  cow: COW_ACCOUNT.secretKey,
  AWS_KMS_KEY_ID: HARDHAT_ACCOUNT_0.secretKey,
};

const hashOf = (raw: string): string =>
  `0x${Buffer.from(keccak_256(hex(raw.slice(2)))).toString("hex")}`;

let scratch: string;
let files = 0;

/** Writes a transaction file and returns its path. */
function txFile(content: unknown): string {
  const file = path.join(scratch, `tx-${files++}.json`);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

/**
 * A runtime with the given networks, `--network` and `--kms`, whose `kms` hook serves every key
 * in `SECRET_KEYS` with a fake adapter. The adapters it creates are listed in `created`.
 */
async function runtime(
  networks: Record<string, NetworkUserConfig>,
  options: { network?: string; kms?: string; simulatedBalance?: bigint } = {},
): Promise<{ hre: HardhatRuntimeEnvironment; created: FakeAdapter[] }> {
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms],
      kms: {
        keys: { zero: vaultKey("zero"), cow: vaultKey("cow") },
        ...(options.simulatedBalance === undefined
          ? {}
          : { simulatedBalance: options.simulatedBalance }),
      },
      networks,
    },
    {
      ...(options.network === undefined ? {} : { network: options.network }),
      ...(options.kms === undefined ? {} : { kms: options.kms }),
    },
  );
  const created: FakeAdapter[] = [];
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      const secretKey = SECRET_KEYS[key.name];
      if (secretKey === undefined) {
        return await next(context, key);
      }
      const adapter = fakeAdapter({ secretKey: hex(secretKey) });
      created.push(adapter);
      return adapter;
    },
  });
  return { hre, created };
}

const signatures = (created: readonly FakeAdapter[]): number =>
  created.reduce((total, adapter) => total + adapter.calls.signDigest, 0);

/** Runs `kms sign-tx` and returns its result and what it printed on each stream. */
async function signTx(
  hre: HardhatRuntimeEnvironment,
  key: string,
  tx: string,
): Promise<{ result: unknown; printed: string; stderr: string }> {
  let printed = "";
  let stderr = "";
  const write = mock.method(process.stdout, "write", (chunk: unknown) => {
    printed += String(chunk);
    return true;
  });
  const writeError = mock.method(process.stderr, "write", (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const result: unknown = await hre.tasks.getTask(["kms", "sign-tx"]).run({ key, tx });
    return { result, printed, stderr };
  } finally {
    write.mock.restore();
    writeError.mock.restore();
  }
}

/** Signs a request with eth_signTransaction on a fresh connection to a network. */
async function rpcSign(
  hre: HardhatRuntimeEnvironment,
  network: string,
  request: Record<string, unknown>,
): Promise<string> {
  const connection = await hre.network.create(network);
  try {
    const raw = await connection.provider.request({
      method: "eth_signTransaction",
      params: [structuredClone(request)],
    });
    assert.ok(typeof raw === "string");
    return raw;
  } finally {
    await connection.close();
  }
}

async function assertKmsError(promise: Promise<unknown>, includes: string[]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    for (const part of includes) {
      assert.ok(error.message.includes(part), `"${error.message}" should include "${part}"`);
    }
    assert.ok(!error.message.includes(FAKE_KEY_ID), `"${error.message}" names a key id`);
    return true;
  });
}

before(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "hardhat-kms-sign-tx-"));
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("kms sign-tx over HTTP", () => {
  let node: RecordingNode;
  let networks: Record<string, NetworkUserConfig>;

  before(async () => {
    node = await startRecordingNode();
    const on = { type: "http" as const, url: node.url, chainId: 31337 };
    networks = {
      kms: { ...on, kmsAccounts: ["zero"] },
      plain: on,
      otherChain: { ...on, chainId: 1 },
    };
  });

  after(async () => {
    await node.server.close();
  });

  /** Runs the task on a network and checks that it reached the node without broadcasting. */
  async function signOn(network: string, key: string, request: unknown) {
    const { hre, created } = await runtime(networks, { network });
    const start = node.methods.length;
    const run = await signTx(hre, key, txFile(request));
    const methods = node.methods.slice(start);
    assert.ok(methods.includes("eth_chainId"), "the task read the node");
    assert.ok(!methods.includes("eth_sendRawTransaction"), "nothing was broadcast");
    assert.ok(!methods.includes("eth_sendTransaction"), "nothing was sent");
    return { ...run, created };
  }

  /** Runs the task, expects a refusal, and checks that the KMS signed nothing. */
  async function refused(
    request: unknown,
    includes: string[],
    options: { network?: string; key?: string } = {},
  ): Promise<string[]> {
    const { hre, created } = await runtime(networks, { network: options.network ?? "kms" });
    const start = node.methods.length;
    await assertKmsError(
      signTx(hre, options.key ?? "zero", typeof request === "string" ? request : txFile(request)),
      includes,
    );
    assert.equal(signatures(created), 0, "the KMS signed nothing");
    return node.methods.slice(start);
  }

  const CASES: [string, Record<string, unknown>][] = [
    ["legacy", { from: FROM, to: TO, value: "0x1", gasPrice: "0x3b9aca00" }],
    [
      "eip2930",
      {
        from: FROM,
        to: TO,
        gasPrice: "0x3b9aca00",
        accessList: [{ address: TO, storageKeys: [`0x${"00".repeat(31)}01`] }],
      },
    ],
    ["eip1559", { from: FROM, to: TO, value: "0x1" }],
    ["eip1559", { from: FROM, data: INIT_CODE }],
    ["eip7702", { from: FROM, to: FROM, authorizationList: [RPC_AUTHORIZATION] }],
  ];

  for (const [type, request] of CASES) {
    const name = request.data === undefined ? type : `${type} contract creation`;
    it(`prints ${name} byte for byte like eth_signTransaction, and its hash on stderr`, async () => {
      const { hre } = await runtime(networks);
      const expected = await rpcSign(hre, "kms", request);
      assert.equal(Transaction.fromHex(expected, false).type, type);

      const { result, printed, stderr, created } = await signOn("kms", "zero", request);

      // Only the raw transaction on standard output, as with cast mktx.
      assert.equal(printed, `${expected}\n`);
      assert.ok(stderr.includes(`[hardhat-kms] hash ${hashOf(expected)}\n`), stderr);
      assert.deepEqual(result, { raw: expected, hash: hashOf(expected) });
      assert.equal(signatures(created), 1);
    });
  }

  it("signs for a key that is not an account of the network", async () => {
    const request = { to: TO, value: "0x1" };
    const { hre } = await runtime(networks);
    const expected = await rpcSign(hre, "kms", { ...request, from: FROM });

    const { printed } = await signOn("plain", "zero", request);

    assert.equal(printed, `${expected}\n`);
  });

  it("fills `from` with the key's address, in any case", async () => {
    const { hre } = await runtime(networks);
    const expected = await rpcSign(hre, "kms", { from: FROM, to: TO });

    assert.equal((await signOn("kms", "zero", { to: TO })).printed, `${expected}\n`);
    assert.equal(
      (await signOn("kms", "zero", { from: FROM.toLowerCase(), to: TO })).printed,
      `${expected}\n`,
    );
  });

  it("accepts a `type` that matches the fields", async () => {
    const { hre } = await runtime(networks);
    const expected = await rpcSign(hre, "kms", { from: FROM, to: TO, value: "0x1" });

    const { printed } = await signOn("kms", "zero", { to: TO, value: "0x1", type: "0x2" });

    assert.equal(printed, `${expected}\n`);
  });

  it("signs a chainId and a nonce from the file as given", async () => {
    const request = { to: TO, value: "0x1", chainId: "0x7a69", nonce: "0x2a" };
    const { hre } = await runtime(networks);
    const expected = await rpcSign(hre, "kms", { ...request, from: FROM });

    const { printed } = await signOn("kms", "zero", request);

    assert.equal(printed, `${expected}\n`);
    const signed = Transaction.fromHex(expected, false);
    assert.equal(signed.raw.nonce, 42n);
    assert.equal(signed.raw.chainId, 31337n);
  });

  it("accepts lowercase, uppercase and checksummed addresses", async () => {
    const { hre } = await runtime(networks);
    const expected = await rpcSign(hre, "kms", { from: FROM, to: TO });
    const upper = `0x${TO.slice(2).toUpperCase()}`;

    for (const to of [TO, TO.toLowerCase(), upper]) {
      assert.equal((await signOn("kms", "zero", { from: FROM, to })).printed, `${expected}\n`);
    }
  });

  it("notes a contract creation on standard error", async () => {
    const { stderr } = await signOn("kms", "zero", { data: INIT_CODE });

    assert.ok(
      stderr.includes("[hardhat-kms] the transaction has no `to`: it creates a contract\n"),
      stderr,
    );
    const { stderr: call } = await signOn("kms", "zero", { to: TO });
    assert.ok(!call.includes("creates a contract"), call);
  });

  it("never sends eth_sendRawTransaction or eth_sendTransaction to the node", () => {
    assert.ok(node.methods.includes("eth_estimateGas"), "the tests above filled transactions");
    assert.ok(!node.methods.includes("eth_sendRawTransaction"));
    assert.ok(!node.methods.includes("eth_sendTransaction"));
  });

  describe("refusals", () => {
    it("refuses to run without --network, before it reads the key", async () => {
      const { hre, created } = await runtime(networks);

      await assertKmsError(signTx(hre, "zero", txFile({ to: TO })), [
        "kms sign-tx: --network is required",
      ]);
      assert.equal(created.length, 0);
    });

    it("refuses a transaction for another chain", async () => {
      await refused({ to: TO, chainId: "0x1" }, [
        "the transaction is for chain 1, but this network is chain 31337",
      ]);
    });

    it("refuses a network whose node is on another chain than its config", async () => {
      const { hre, created } = await runtime(networks, { network: "otherChain" });
      // Hardhat's chain-id validator answers first on an http network; the plugin's check
      // behind it refuses the same mismatch.
      await assert.rejects(signTx(hre, "zero", txFile({ to: TO })), /chain id "1".*"31337"/);
      assert.equal(signatures(created), 0, "the KMS signed nothing");
    });

    it("refuses a `from` that is not the key's address, before it reaches the node", async () => {
      const methods = await refused({ from: COW_ACCOUNT.address, to: TO }, [
        `the transaction's from is ${COW_ACCOUNT.address}, but key zero has the address ${FROM}`,
      ]);
      assert.deepEqual(methods, []);
      await refused({ from: 5, to: TO }, ["the transaction's from is number"]);
    });

    it("names a --kms key by its variable, never by its key id", async () => {
      const saved = process.env.AWS_KMS_KEY_ID;
      process.env.AWS_KMS_KEY_ID = "alias/kept-out-of-errors";
      try {
        const { hre, created } = await runtime(networks, { network: "kms", kms: "aws" });
        await assert.rejects(
          signTx(hre, "AWS_KMS_KEY_ID", txFile({ from: COW_ACCOUNT.address, to: TO })),
          (error: unknown) => {
            assert.ok(error instanceof HardhatPluginError, String(error));
            assert.match(error.message, /but key AWS_KMS_KEY_ID has the address/);
            assert.ok(!error.message.includes("kept-out-of-errors"), error.message);
            return true;
          },
        );
        assert.equal(signatures(created), 0);
      } finally {
        if (saved === undefined) {
          Reflect.deleteProperty(process.env, "AWS_KMS_KEY_ID");
        } else {
          process.env.AWS_KMS_KEY_ID = saved;
        }
      }
    });

    it("refuses blob transactions (EIP-4844), as for KMS accounts over RPC", async () => {
      const blob = "blob transactions (EIP-4844) cannot be signed with KMS accounts";
      await refused({ to: TO, blobVersionedHashes: [`0x01${"00".repeat(31)}`] }, [blob]);
      await refused({ to: TO, type: "0x3" }, [blob]);
      await refused({ to: TO, maxFeePerBlobGas: "0x1" }, [blob]);
    });

    it("refuses a `type` that the fields do not give, before the KMS signs", async () => {
      await refused({ to: TO, type: "0x0" }, [
        "the transaction asks for type 0x0 (legacy), but its fields make it type 0x2 (eip1559); nothing was signed",
      ]);
    });

    it("refuses an unknown or malformed `type`", async () => {
      await refused({ to: TO, type: "0x5" }, [
        "transaction type 0x5 is not supported; KMS accounts sign types 0x0, 0x1, 0x2 and 0x4",
      ]);
      await refused({ to: TO, type: 2 }, ['type must be a hex quantity, such as "0x2"']);
    });

    it("refuses fields eth_sendTransaction does not have, with the right name", async () => {
      await refused({ to: TO, gasLimit: "0x5208", input: "0x" }, [
        "unknown transaction fields gasLimit, input (use gas instead of gasLimit; use data instead of input)",
        "The fields are those of eth_sendTransaction: from, to, gas, gasPrice, maxFeePerGas, maxPriorityFeePerGas, value, data, nonce, chainId, accessList, authorizationList, type.",
      ]);
      await refused({ to: TO, color: "blue" }, ["unknown transaction field color."]);
    });

    it("refuses a mixed-case address whose EIP-55 checksum is wrong, before the key is read", async () => {
      // TO with one letter's case flipped.
      const typo = `${TO.slice(0, 10)}${TO.slice(10, 11).toLowerCase()}${TO.slice(11)}`;
      assert.notEqual(typo, TO);
      const wrong = "has a wrong EIP-55 checksum, which usually means a typo";
      const cases: [string, Record<string, unknown>][] = [
        ["to", { to: typo }],
        ["from", { from: typo, to: TO }],
        ["accessList[0].address", { to: TO, accessList: [{ address: typo, storageKeys: [] }] }],
        [
          "authorizationList[0].address",
          { to: FROM, authorizationList: [{ ...RPC_AUTHORIZATION, address: typo }] },
        ],
      ];
      for (const [where, request] of cases) {
        const { hre, created } = await runtime(networks, { network: "kms" });
        const start = node.methods.length;
        await assertKmsError(signTx(hre, "zero", txFile(request)), [`${where} ${typo} ${wrong}`]);
        assert.equal(created.length, 0, "the key was not opened");
        assert.deepEqual(node.methods.slice(start), [], "nothing reached the node");
      }
    });

    it("refuses a quantity that is not 0x hex, before the node is read", async () => {
      const methods = await refused({ to: TO, value: 1 }, [
        'value must be a hex quantity, such as "0x1", got 1',
      ]);
      assert.deepEqual(methods, []);
      await refused({ to: TO, nonce: "12" }, [
        'nonce must be a hex quantity, such as "0x1", got "12"',
      ]);
      for (const field of ["gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "chainId"]) {
        await refused({ to: TO, [field]: "0x" }, [`${field} must be a hex quantity`]);
      }
    });

    it("refuses a file that is not a JSON object, or cannot be read", async () => {
      await refused(txFile("{ to: "), ["is not valid JSON"]);
      await refused(txFile([]), ["must hold one JSON object with eth_sendTransaction fields"]);
      await refused(txFile("null"), ["must hold one JSON object"]);
      await refused(path.join(scratch, "missing.json"), [
        `cannot read the transaction file ${path.join(scratch, "missing.json")} (ENOENT)`,
      ]);
    });
  });
});

describe("kms sign-tx on a simulated network", () => {
  it("signs like eth_signTransaction, and the node accepts the result", async () => {
    const { hre } = await runtime(
      { local: { type: "edr-simulated", kmsAccounts: ["cow"] } },
      { network: "local", simulatedBalance: 10n ** 18n },
    );
    const request = { to: TO, value: "0x1" };
    const expected = await rpcSign(hre, "local", { ...request, from: COW_ACCOUNT.address });

    const { printed } = await signTx(hre, "cow", txFile(request));

    assert.equal(printed, `${expected}\n`);
    // Each connection to a simulated network is a new chain, funded by kms.simulatedBalance.
    const connection = await hre.network.create("local");
    try {
      const { provider } = connection;
      const hash = await provider.request({ method: "eth_sendRawTransaction", params: [expected] });
      assert.equal(hash, hashOf(expected));
      const receipt = await provider.request({
        method: "eth_getTransactionReceipt",
        params: [hash],
      });
      assert.ok(typeof receipt === "object" && receipt !== null);
      assert.equal(Reflect.get(receipt, "status"), "0x1");
    } finally {
      await connection.close();
    }
  });
});

describe("the kms namespace", () => {
  it("lists sign-tx", async () => {
    const { hre } = await runtime({});

    assert.ok(hre.tasks.getTask("kms").subtasks.has("sign-tx"));
  });
});

describe("kms sign-tx's fields", () => {
  it("are the fields of Hardhat's request schema, plus type", () => {
    const shape: unknown = Reflect.get(rpcTransactionRequest, "shape");
    assert.ok(typeof shape === "object" && shape !== null);

    assert.deepEqual([...KNOWN_FIELDS].toSorted(), [...Object.keys(shape), "type"].toSorted());
  });
});
