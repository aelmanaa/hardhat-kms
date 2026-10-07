// The differential test of decision 0002: Hardhat fills and signs a request for a local account,
// the plugin fills the same request, and both must give the same unsigned transaction.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { NetworkConnection } from "hardhat/types/network";
import { authorization, Transaction } from "micro-eth-signer";

import { ConnectionChain } from "../../src/internal/rpc/chain-id.ts";
import {
  buildUnsignedTransaction,
  createTransactionFiller,
  fillSettings,
  signingHash,
  type TransactionFiller,
  type UnsignedTransaction,
} from "../../src/internal/rpc/transaction-filler.ts";
import { type RecordingNode, startRecordingNode } from "../helpers/recording-node.ts";
import { HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const FROM = HARDHAT_ACCOUNT_0.address;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
// One address with one storage key, another with none.
const ACCESS_LIST = [
  { address: TO, storageKeys: [`0x${"00".repeat(31)}01`] },
  { address: FROM, storageKeys: [] },
];
// Creation code that deploys a contract returning 42.
const INIT_CODE = "0x600a600c600039600a6000f3602a60005260206000f3";

/** A transaction's raw fields, without `type`. */
function fields(raw: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([name]) => name !== "type"));
}

/** The plugin's filler for a connection. */
function fillerFor(connection: NetworkConnection<string>): TransactionFiller {
  const chain = new ConnectionChain(async () => {
    const chainId: unknown = await connection.provider.request({ method: "eth_chainId" });
    return chainId;
  }, connection.networkConfig.chainId);
  return createTransactionFiller(connection, chain);
}

/** An http network on a node, with the test key as a local account. */
function on(node: RecordingNode) {
  return {
    type: "http" as const,
    url: node.url,
    chainId: 31337,
    accounts: [`0x${HARDHAT_ACCOUNT_0.secretKey}`],
  };
}

/** An error's message, for comparing failures. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe("transaction filling matches Hardhat's local accounts", () => {
  let main: RecordingNode;
  let berlin: RecordingNode;
  let lowLimit: RecordingNode;
  let hre: HardhatRuntimeEnvironment;

  before(async () => {
    main = await startRecordingNode();
    berlin = await startRecordingNode({ hardfork: "berlin" });
    lowLimit = await startRecordingNode({ blockGasLimit: 40_000n });
    hre = await createHardhatRuntimeEnvironment({
      networks: {
        local: on(main),
        multiplied: { ...on(main), gasMultiplier: 1.5 },
        multiplied11: { ...on(main), gasMultiplier: 1.1 },
        fixedGasPrice: { ...on(main), gasPrice: 2_000_000_000n, gas: 100_000n },
        berlin: on(berlin),
        lowLimit: { ...on(lowLimit), gasMultiplier: 2 },
      },
    });
  });

  after(async () => {
    await main.server.close();
    await berlin.server.close();
    await lowLimit.server.close();
  });

  /** The node a network of the client runtime points at. */
  function nodeOf(network: string): RecordingNode {
    return network === "berlin" ? berlin : network === "lowLimit" ? lowLimit : main;
  }

  /**
   * Signs the request as a local account and fills it with the plugin on the same connection,
   * then compares them.
   */
  async function compareOn(
    network: string,
    connection: NetworkConnection<string>,
    filler: TransactionFiller,
    request: Record<string, unknown>,
  ): Promise<UnsignedTransaction> {
    const node = nodeOf(network);
    const sent = node.raw.length;
    await connection.provider.request({
      method: "eth_sendTransaction",
      params: [structuredClone(request)],
    });
    const signed = Transaction.fromHex(node.raw[sent] ?? "", false);
    assert.equal(signed.sender, FROM);

    const filled = await filler.fill("eth_sendTransaction", [structuredClone(request)]);
    const unsigned = buildUnsignedTransaction(filled);

    const expected = signed.removeSignature();
    assert.equal(unsigned.type, expected.type);
    // A prepared transaction's raw fields name its type; a decoded one's do not.
    assert.deepEqual(fields(unsigned.raw), fields(expected.raw));
    assert.equal(unsigned.toHex(false), expected.toHex(false));
    assert.deepEqual(signingHash(unsigned), keccak_256(expected.toBytes(false)));
    return unsigned;
  }

  /** Compares one request on a fresh connection; returns the transaction type. */
  async function compare(network: string, request: Record<string, unknown>): Promise<string> {
    const connection: NetworkConnection<string> = await hre.network.create(network);
    try {
      return (await compareOn(network, connection, fillerFor(connection), request)).type;
    } finally {
      await connection.close();
    }
  }

  /** Requires Hardhat and the plugin to refuse the request with the same message. */
  async function compareFailure(
    network: string,
    request: Record<string, unknown>,
  ): Promise<string> {
    const connection: NetworkConnection<string> = await hre.network.create(network);
    try {
      const hardhat = await connection.provider
        .request({ method: "eth_sendTransaction", params: [structuredClone(request)] })
        .then(
          () => assert.fail("Hardhat sent the transaction"),
          (error: unknown) => messageOf(error),
        );
      const plugin = await fillerFor(connection)
        .fill("eth_sendTransaction", [structuredClone(request)])
        .then(
          () => assert.fail("the plugin filled the transaction"),
          (error: unknown) => messageOf(error),
        );
      assert.equal(plugin, hardhat);
      return plugin;
    } finally {
      await connection.close();
    }
  }

  /** Runs `body` while the main node fails `method` with `message`. */
  async function withFault<T>(
    method: string,
    fault: string | { message: string; code: number },
    body: () => Promise<T>,
  ): Promise<T> {
    main.faults.set(method, fault);
    try {
      return await body();
    } finally {
      main.faults.delete(method);
    }
  }

  it("fills an EIP-1559 transaction with automatic fees", async () => {
    assert.equal(await compare("local", { from: FROM, to: TO, value: "0x1" }), "eip1559");
  });

  it("fills a legacy transaction with a gas price", async () => {
    assert.equal(await compare("local", { from: FROM, to: TO, gasPrice: "0x3b9aca00" }), "legacy");
  });

  it("fills an EIP-2930 transaction with an access list and a gas price", async () => {
    const accessList = [{ address: TO, storageKeys: [`0x${"00".repeat(31)}01`] }];
    assert.equal(
      await compare("local", { from: FROM, to: TO, gasPrice: "0x3b9aca00", accessList }),
      "eip2930",
    );
  });

  it("fills a contract creation, with or without `to: null`", async () => {
    assert.equal(await compare("local", { from: FROM, data: INIT_CODE }), "eip1559");
    assert.equal(await compare("local", { from: FROM, to: null, data: INIT_CODE }), "eip1559");
  });

  it("fills an EIP-7702 transaction", async () => {
    const signedAuthorization = authorization.sign(
      { chainId: 31337n, address: TO, nonce: 1n },
      `0x${HARDHAT_ACCOUNT_0.secretKey}`,
    );
    const authorizationList = [
      {
        chainId: "0x7a69",
        address: signedAuthorization.address,
        nonce: "0x1",
        yParity: `0x${signedAuthorization.yParity.toString(16)}`,
        r: `0x${signedAuthorization.r.toString(16).padStart(64, "0")}`,
        s: `0x${signedAuthorization.s.toString(16).padStart(64, "0")}`,
      },
    ];
    assert.equal(await compare("local", { from: FROM, to: FROM, authorizationList }), "eip7702");
    assert.equal(
      await compare("local", { from: FROM, to: FROM, authorizationList, accessList: ACCESS_LIST }),
      "eip7702",
    );
  });

  it("fills an EIP-1559 transaction with an access list", async () => {
    assert.equal(
      await compare("local", { from: FROM, to: TO, accessList: ACCESS_LIST }),
      "eip1559",
    );
  });

  it("keeps the caller's nonce, value and chain id", async () => {
    assert.equal(
      await compare("local", { from: FROM, to: TO, nonce: "0x5", value: "0x10" }),
      "eip1559",
    );
    assert.equal(await compare("local", { from: FROM, to: TO, chainId: "0x7a69" }), "eip1559");
  });

  it("completes a single EIP-1559 field", async () => {
    // A priority fee above the suggested maxFeePerGas raises it.
    assert.equal(
      await compare("local", { from: FROM, to: TO, maxPriorityFeePerGas: "0x174876e800" }),
      "eip1559",
    );
    assert.equal(await compare("local", { from: FROM, to: TO, maxFeePerGas: "0x1" }), "eip1559");
  });

  it("applies the network's gas multiplier", async () => {
    assert.equal(await compare("multiplied", { from: FROM, to: TO, data: "0x" }), "eip1559");
    assert.equal(await compare("multiplied11", { from: FROM, to: TO, data: "0x1234" }), "eip1559");
  });

  it("caps the multiplied estimate below the block gas limit", async () => {
    const connection: NetworkConnection<string> = await hre.network.create("lowLimit");
    try {
      const unsigned = await compareOn("lowLimit", connection, fillerFor(connection), {
        from: FROM,
        to: TO,
      });
      // floor(40_000 * 0.95) - 1
      assert.equal(fields(unsigned.raw).gasLimit, 37_999n);
    } finally {
      await connection.close();
    }
  });

  it("applies the network's fixed gas and gas price", async () => {
    assert.equal(await compare("fixedGasPrice", { from: FROM, to: TO }), "legacy");
  });

  it("sends a legacy gas price to a node without a base fee", async () => {
    assert.equal(await compare("berlin", { from: FROM, to: TO }), "legacy");
    const message = await compareFailure("berlin", {
      from: FROM,
      to: TO,
      maxPriorityFeePerGas: "0x1",
    });
    assert.ok(message.includes("EIP-1559"), message);
  });

  it("falls back when eth_feeHistory fails", async () => {
    await withFault("eth_feeHistory", "upstream request failed", async () => {
      assert.equal(await compare("local", { from: FROM, to: TO }), "legacy");
      assert.equal(
        await compare("local", { from: FROM, to: TO, maxPriorityFeePerGas: "0x1" }),
        "eip1559",
      );
    });
  });

  it("asks eth_feeHistory again after a failure, where Hardhat stays legacy", async () => {
    // A deliberate difference: Hardhat remembers a failed eth_feeHistory for the connection.
    const connection: NetworkConnection<string> = await hre.network.create("local");
    try {
      const filler = fillerFor(connection);
      await withFault("eth_feeHistory", "upstream request failed", async () => {
        const unsigned = await compareOn("local", connection, filler, { from: FROM, to: TO });
        assert.equal(unsigned.type, "legacy");
      });
      const sent = main.raw.length;
      await connection.provider.request({
        method: "eth_sendTransaction",
        params: [{ from: FROM, to: TO }],
      });
      assert.equal(Transaction.fromHex(main.raw[sent] ?? "", false).type, "legacy");
      const filled = await filler.fill("eth_sendTransaction", [{ from: FROM, to: TO }]);
      assert.equal(buildUnsignedTransaction(filled).type, "eip1559");
    } finally {
      await connection.close();
    }
  });

  it("stays legacy after eth_feeHistory answers method not found (-32601), as Hardhat does", async () => {
    const connection: NetworkConnection<string> = await hre.network.create("local");
    try {
      const filler = fillerFor(connection);
      const missing = { code: -32601, message: "the method eth_feeHistory does not exist" };
      await withFault("eth_feeHistory", missing, async () => {
        const unsigned = await compareOn("local", connection, filler, { from: FROM, to: TO });
        assert.equal(unsigned.type, "legacy");
      });
      const unsigned = await compareOn("local", connection, filler, { from: FROM, to: TO });
      assert.equal(unsigned.type, "legacy");
    } finally {
      await connection.close();
    }
  });

  it("uses the capped block gas limit when the estimate has an execution error", async () => {
    const connection: NetworkConnection<string> = await hre.network.create("local");
    try {
      const block = await connection.provider.request({
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      });
      const blockGasLimit = BigInt(String(Reflect.get(Object(block), "gasLimit")));
      const unsigned = await withFault(
        "eth_estimateGas",
        "execution error: forced by the test",
        async () =>
          await compareOn("local", connection, fillerFor(connection), { from: FROM, to: TO }),
      );
      assert.equal(fields(unsigned.raw).gasLimit, (blockGasLimit * 95n) / 100n);
    } finally {
      await connection.close();
    }
  });

  it("fails like Hardhat when a contract creation reverts", async () => {
    // Creation code that reverts: PUSH1 0, PUSH1 0, REVERT.
    const message = await compareFailure("local", { from: FROM, data: "0x60006000fd" });
    assert.ok(message.includes("reverted"), message);
  });

  it("stays consistent over two sends on one connection", async () => {
    const connection: NetworkConnection<string> = await hre.network.create("multiplied");
    try {
      const filler = fillerFor(connection);
      await compareOn("multiplied", connection, filler, { from: FROM, to: TO });
      await compareOn("multiplied", connection, filler, { from: FROM, to: TO, value: "0x2" });
    } finally {
      await connection.close();
    }
  });
});

describe("fillSettings", () => {
  it("reads an in-process simulated network's default gas limit and enforcement", async () => {
    const hre = await createHardhatRuntimeEnvironment({
      networks: {
        enforced: { type: "edr-simulated" },
        unenforced: { type: "edr-simulated", blockGasLimit: false },
        remote: { type: "http", url: "http://127.0.0.1:1" },
      },
    });
    const enforced = await hre.network.create("enforced");
    const unenforced = await hre.network.create("unenforced");
    const remote = await hre.network.create("remote");
    try {
      const settings = fillSettings(enforced);
      assert.equal(typeof settings.fallbackGas, "bigint");
      assert.equal(settings.isBlockGasLimitEnforced(), true);
      assert.equal(settings.gas, "auto");
      assert.equal(settings.gasPrice, "auto");
      assert.equal(settings.gasMultiplier, 1);
      assert.equal(fillSettings(unenforced).isBlockGasLimitEnforced(), false);
      assert.equal(fillSettings(remote).fallbackGas, undefined);
      assert.equal(fillSettings(remote).isBlockGasLimitEnforced(), true);
    } finally {
      await enforced.close();
      await unenforced.close();
      await remote.close();
    }
  });

  it("fills a transaction on an in-process simulated network", async () => {
    const hre = await createHardhatRuntimeEnvironment({
      networks: { sim: { type: "edr-simulated" } },
    });
    const connection = await hre.network.create("sim");
    try {
      const filled = await fillerFor(connection).fill("eth_sendTransaction", [
        { from: FROM, to: TO },
      ]);
      assert.equal(filled.chainId, 31337n);
      const estimate = await connection.provider.request({
        method: "eth_estimateGas",
        params: [{ from: FROM, to: TO }],
      });
      assert.equal(filled.gas, BigInt(String(estimate)));
      assert.equal(filled.nonce, 0n);
      assert.ok(filled.maxFeePerGas !== undefined && filled.maxFeePerGas > 0n);
    } finally {
      await connection.close();
    }
  });
});
