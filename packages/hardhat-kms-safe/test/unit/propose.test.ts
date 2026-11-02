// proposeSafeTransaction against a scripted node, for the checks a real Safe never fails: a node
// that answers eth_chainId badly, a Safe whose getTransactionHash differs, and signatures that are
// malformed, have another v, recover to someone else or that checkNSignatures refuses.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeFunctionData,
  getAddress,
  isHex,
  encodeFunctionResult,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { proposeSafeTransaction } from "../../src/internal/propose.ts";
import { safeTxTypedData, type SafeTransaction } from "../../src/internal/safe-tx.ts";
import { TransactionServiceClient } from "../../src/internal/tx-service.ts";

const ABI = parseAbi([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function checkNSignatures(bytes32 dataHash, bytes data, bytes signatures, uint256 requiredSignatures) view",
]);

const SAFE: Address = "0x2B0b9cBDA3D7b0F760187c52A8FFB18C48E5d96A";
const TO: Address = "0x79613FD49472C3C7a32188e45ff00e7bdC8a897d";
const OWNER = privateKeyToAccount(`0x${"07".repeat(32)}`);
const STRANGER = privateKeyToAccount(`0x${"09".repeat(32)}`);

function hexOf(value: unknown): Hex {
  assert.ok(isHex(value));
  return value;
}

interface Script {
  chainId?: unknown;
  wrongHash?: boolean;
  /** Replaces the signature the node returns. */
  signature?: (good: Hex) => unknown;
  refuseSignature?: boolean;
}

/** A node that serves one 1.4.1 Safe owned by OWNER, and counts sign requests. */
function scriptedNode(script: Script): {
  provider: { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
  signs: () => number;
} {
  let signs = 0;
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
      switch (method) {
        case "eth_chainId":
          return script.chainId ?? "0xaa36a7";
        case "eth_getCode":
          return "0x6080";
        case "eth_call": {
          const call: unknown = params?.[0];
          const data: unknown =
            typeof call === "object" && call !== null ? Reflect.get(call, "data") : undefined;
          assert.ok(typeof data === "string" && data.startsWith("0x"));
          const decoded = decodeFunctionData({ abi: ABI, data: `0x${data.slice(2)}` });
          switch (decoded.functionName) {
            case "VERSION":
              return encodeFunctionResult({ abi: ABI, functionName: "VERSION", result: "1.4.1" });
            case "getOwners":
              return encodeFunctionResult({
                abi: ABI,
                functionName: "getOwners",
                result: [OWNER.address],
              });
            case "getThreshold":
              return encodeFunctionResult({ abi: ABI, functionName: "getThreshold", result: 2n });
            case "nonce":
              return encodeFunctionResult({ abi: ABI, functionName: "nonce", result: 4n });
            case "getTransactionHash": {
              const [
                to,
                value,
                txData,
                operation,
                safeTxGas,
                baseGas,
                gasPrice,
                gasToken,
                refundReceiver,
                nonce,
              ] = decoded.args;
              const tx: SafeTransaction = {
                to,
                value,
                data: txData,
                operation: operation === 1 ? 1 : 0,
                safeTxGas,
                baseGas,
                gasPrice,
                gasToken,
                refundReceiver,
                nonce,
              };
              const { hashTypedData } = await import("viem");
              const typed = safeTxTypedData(11155111n, SAFE, tx);
              const hash = hashTypedData({
                domain: { chainId: 11155111n, verifyingContract: SAFE },
                types: { SafeTx: typed.types.SafeTx },
                primaryType: "SafeTx",
                message: tx,
              });
              return script.wrongHash === true ? `0x${"00".repeat(32)}` : hash;
            }
            case "checkNSignatures":
              if (script.refuseSignature === true) {
                throw new Error("execution reverted: GS026");
              }
              return "0x";
          }
          throw new Error("unexpected call");
        }
        case "eth_signTypedData_v4": {
          signs++;
          const json: unknown = params?.[1];
          assert.equal(typeof json, "string");
          const typed: unknown = JSON.parse(String(json));
          const message: unknown =
            typeof typed === "object" && typed !== null ? Reflect.get(typed, "message") : undefined;
          assert.ok(typeof message === "object" && message !== null);
          const good = await OWNER.signTypedData({
            domain: { chainId: 11155111, verifyingContract: SAFE },
            types: {
              SafeTx: safeTxTypedData(1n, SAFE, {
                to: TO,
                value: 0n,
                data: "0x",
                operation: 0,
                safeTxGas: 0n,
                baseGas: 0n,
                gasPrice: 0n,
                gasToken: TO,
                refundReceiver: TO,
                nonce: 0n,
              }).types.SafeTx,
            },
            primaryType: "SafeTx",
            message: {
              to: getAddress(String(Reflect.get(message, "to"))),
              value: BigInt(String(Reflect.get(message, "value"))),
              data: hexOf(Reflect.get(message, "data")),
              operation: Number(Reflect.get(message, "operation")),
              safeTxGas: 0n,
              baseGas: 0n,
              gasPrice: 0n,
              gasToken: "0x0000000000000000000000000000000000000000",
              refundReceiver: "0x0000000000000000000000000000000000000000",
              nonce: BigInt(String(Reflect.get(message, "nonce"))),
            },
          });
          return script.signature === undefined ? good : script.signature(good);
        }
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { provider, signs: () => signs };
}

/** A service that answers the list with nothing queued and records proposals. */
function service(): { client: TransactionServiceClient; posts: () => number } {
  let posts = 0;
  const client = new TransactionServiceClient({
    url: "https://service.test",
    fetch: async (_input, init) => {
      if (init?.method === "POST") {
        posts++;
        return new Response(null, { status: 201 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    },
  });
  return { client, posts: () => posts };
}

async function run(
  script: Script,
  extra: { sender?: string; approve?: () => Promise<boolean> } = {},
) {
  const node = scriptedNode(script);
  const target = service();
  const result = proposeSafeTransaction({
    provider: node.provider,
    sender: extra.sender ?? OWNER.address,
    safe: SAFE,
    call: { to: TO, value: 1n },
    service: target.client,
    ...(extra.approve === undefined ? {} : { approve: extra.approve }),
  });
  return { result, node, target };
}

describe("proposeSafeTransaction", () => {
  it("proposes when every check passes, at the Safe's nonce", async () => {
    const { result, node, target } = await run({});
    const proposal = await result;
    assert.equal(proposal.transaction.nonce, 4n);
    assert.equal(proposal.version, "1.4.1");
    assert.equal(proposal.threshold, 2n);
    assert.match(proposal.link ?? "", /^https:\/\/app\.safe\.global\/transactions\/tx\?safe=sep:/);
    assert.equal(node.signs(), 1);
    assert.equal(target.posts(), 1);
  });

  const before: [string, Script, RegExp][] = [
    [
      "a chain id that is not hex",
      { chainId: 11155111 },
      /eth_chainId with something other than a hex quantity/,
    ],
    [
      "an empty chain id",
      { chainId: "0x" },
      /eth_chainId with something other than a hex quantity/,
    ],
    [
      "a Safe whose own hash differs",
      { wrongHash: true },
      /the Safe computes the SafeTx hash 0x0{64}, but the plugin computed 0x/,
    ],
  ];
  for (const [name, script, message] of before) {
    it(`refuses ${name} before signing`, async () => {
      const { result, node, target } = await run(script);
      await assert.rejects(result, message);
      assert.equal(node.signs(), 0);
      assert.equal(target.posts(), 0);
    });
  }

  it("refuses a sender that is not an address, and stops when approve says no", async () => {
    const bad = await run({}, { sender: "deployer" });
    await assert.rejects(bad.result, /the sender is not an address/);
    const declined = await run({}, { approve: async () => await Promise.resolve(false) });
    await assert.rejects(declined.result, /not proposed: the answer was not yes/);
    assert.equal(declined.node.signs(), 0);
  });

  const after: [string, Script, RegExp][] = [
    [
      "a signature that is not 65 bytes",
      { signature: () => "0x1234" },
      /not 65 bytes, or whose v is not 27 or 28/,
    ],
    ["a signature that is not hex", { signature: () => 7 }, /not 65 bytes/],
    [
      "v 31 (eth_sign)",
      { signature: (good) => `${good.slice(0, 130)}1f` },
      /whose v is not 27 or 28/,
    ],
    ["v 0", { signature: (good) => `${good.slice(0, 130)}00` }, /whose v is not 27 or 28/],
    [
      "a signature by another key",
      {
        signature: (good) =>
          good === "0x" ? good : `${good.slice(0, 2)}${"00".repeat(32)}${good.slice(66)}`,
      },
      /the signature recovers to (no address|0x[0-9a-fA-F]{40}), not to 0x/,
    ],
    [
      "a signature checkNSignatures refuses",
      { refuseSignature: true },
      /the Safe's checkNSignatures refused the signature\. Nothing was posted/,
    ],
  ];
  for (const [name, script, message] of after) {
    it(`posts nothing after ${name}`, async () => {
      const { result, node, target } = await run(script);
      await assert.rejects(result, message);
      assert.equal(node.signs(), 1);
      assert.equal(target.posts(), 0);
    });
  }

  it("posts nothing when the signature recovers to another account", async () => {
    const other = await STRANGER.signMessage({ message: "x" });
    const { result, target } = await run({ signature: () => other });
    await assert.rejects(result, /the signature recovers to 0x[0-9a-fA-F]{40}, not to 0x/);
    assert.equal(target.posts(), 0);
  });
});
