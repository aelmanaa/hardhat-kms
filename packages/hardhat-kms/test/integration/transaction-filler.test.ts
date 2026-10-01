// The differential test of decision 0002: Hardhat fills and signs a request for a local account,
// the plugin fills the same request, and both must give the same unsigned transaction.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { JsonRpcServer, NetworkConnection } from "hardhat/types/network";
import { authorization, Transaction } from "micro-eth-signer";

import { ConnectionChain } from "../../src/internal/rpc/chain-id.ts";
import {
  buildUnsignedTransaction,
  createTransactionFiller,
  fillSettings,
  signingHash,
} from "../../src/internal/rpc/transaction-filler.ts";
import { HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const FROM = HARDHAT_ACCOUNT_0.address;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
// Creation code that deploys a contract returning 42.
const INIT_CODE = "0x600a600c600039600a6000f3602a60005260206000f3";

/**
 * A simulated node behind a JSON-RPC server. It records raw transactions instead of running
 * them, so the chain state is the same for both fills.
 */
async function startNode(): Promise<{ server: JsonRpcServer; url: string; raw: string[] }> {
  const raw: string[] = [];
  const hre = await createHardhatRuntimeEnvironment({
    networks: { node: { type: "edr-simulated", chainId: 31337 } },
  });
  hre.hooks.registerHandlers("network", {
    onRequest: async (context, connection, request, next) => {
      if (request.method !== "eth_sendRawTransaction" || !Array.isArray(request.params)) {
        return await next(context, connection, request);
      }
      const [bytes]: unknown[] = request.params;
      assert.ok(typeof bytes === "string");
      raw.push(bytes);
      const hash = `0x${Buffer.from(keccak_256(Buffer.from(bytes.slice(2), "hex"))).toString("hex")}`;
      return { jsonrpc: "2.0", id: request.id, result: hash };
    },
  });
  const server = await hre.network.createServer("node", "127.0.0.1", 0);
  const { address, port } = await server.listen();
  return { server, url: `http://${address}:${port}`, raw };
}

/** A transaction's raw fields, without `type`. */
function fields(raw: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([name]) => name !== "type"));
}

describe("transaction filling matches Hardhat's local accounts", () => {
  let node: Awaited<ReturnType<typeof startNode>>;
  let hre: HardhatRuntimeEnvironment;

  before(async () => {
    node = await startNode();
    const local = {
      type: "http" as const,
      url: node.url,
      chainId: 31337,
      accounts: [`0x${HARDHAT_ACCOUNT_0.secretKey}`],
    };
    hre = await createHardhatRuntimeEnvironment({
      networks: {
        local,
        multiplied: { ...local, gasMultiplier: 1.5 },
        fixedGasPrice: { ...local, gasPrice: 2_000_000_000n, gas: 100_000n },
      },
    });
  });

  after(async () => {
    await node.server.close();
  });

  /** Signs the request as a local account, fills it with the plugin, and compares them. */
  async function compare(network: string, request: Record<string, unknown>): Promise<string> {
    const connection: NetworkConnection<string> = await hre.network.create(network);
    try {
      const sent = node.raw.length;
      await connection.provider.request({
        method: "eth_sendTransaction",
        params: [structuredClone(request)],
      });
      const signed = Transaction.fromHex(node.raw[sent] ?? "", false);
      assert.equal(signed.sender, FROM);

      const chain = new ConnectionChain(async () => {
        const chainId: unknown = await connection.provider.request({ method: "eth_chainId" });
        return chainId;
      }, connection.networkConfig.chainId);
      const filler = createTransactionFiller(connection, chain);
      const filled = await filler.fill("eth_sendTransaction", [structuredClone(request)]);
      const unsigned = buildUnsignedTransaction(filled);

      const expected = signed.removeSignature();
      assert.equal(unsigned.type, expected.type);
      // A prepared transaction's raw fields name its type; a decoded one's do not.
      assert.deepEqual(fields(unsigned.raw), fields(expected.raw));
      assert.equal(unsigned.toHex(false), expected.toHex(false));
      assert.deepEqual(signingHash(unsigned), keccak_256(expected.toBytes(false)));
      return unsigned.type;
    } finally {
      await connection.close();
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

  it("fills a contract creation", async () => {
    assert.equal(await compare("local", { from: FROM, data: INIT_CODE }), "eip1559");
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
  });

  it("applies the network's gas multiplier", async () => {
    assert.equal(await compare("multiplied", { from: FROM, to: TO, data: "0x" }), "eip1559");
  });

  it("applies the network's fixed gas and gas price", async () => {
    assert.equal(await compare("fixedGasPrice", { from: FROM, to: TO }), "legacy");
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
      const chain = new ConnectionChain(async () => {
        const chainId: unknown = await connection.provider.request({ method: "eth_chainId" });
        return chainId;
      }, connection.networkConfig.chainId);
      const filled = await createTransactionFiller(connection, chain).fill("eth_sendTransaction", [
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
