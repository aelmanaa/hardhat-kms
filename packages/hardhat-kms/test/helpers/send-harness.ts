// The network hook's handlers with a fake node, fake KMS adapters and fake timers, shared by the
// unit tests of the send lock, the nonce high-water mark, the retry cache and raw transactions.
import assert from "node:assert/strict";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { NetworkConnection } from "hardhat/types/network";
import type { JsonRpcRequest, JsonRpcResponse } from "hardhat/types/providers";
import { Transaction } from "micro-eth-signer";

import hardhatKms from "../../src/index.ts";
import { createNetworkHandlers } from "../../src/internal/hook-handlers/network.ts";
import { SendOutcomeUnknownError } from "../../src/internal/rpc/send-guard.ts";
import { fakeAdapter } from "./fake-adapter.ts";
import { type FakeTimers, fakeTimers } from "./fake-timers.ts";
import { vaultKey } from "./vault-key.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "./vectors.ts";

export const COW: string = COW_ACCOUNT.address;
export const ZERO: string = HARDHAT_ACCOUNT_0.address;
export const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
/** The hash the fake node answers `wallet_sendTransaction` with; no transaction has it. */
export const WALLET_SEND_HASH: string = `0x${"ee".repeat(32)}`;
/** The call batch id the fake node answers `wallet_sendCalls` with (EIP-5792). */
export const CALLS_ID: string = `0x${"cc".repeat(32)}`;
const SECRETS: Record<string, string> = {
  cow: COW_ACCOUNT.secretKey,
  zero: HARDHAT_ACCOUNT_0.secretKey,
};

/** A promise and the function that resolves it. */
export function gate(): { promise: Promise<void>; open: () => void } {
  const control: { open: () => void } = { open: () => {} };
  const promise = new Promise<void>((resolve) => {
    control.open = resolve;
  });
  return { promise, open: () => control.open() };
}

/** Lets pending promise callbacks and I/O callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export const nonceOf = (raw: string): bigint => Transaction.fromHex(raw, false).raw.nonce;
export const hashOf = (raw: string): string =>
  `0x${Buffer.from(keccak_256(Buffer.from(raw.slice(2), "hex"))).toString("hex")}`;

/** A successful receipt for a transfer mined in block 1, as the fake node answers it. */
export function receiptOf(hash: unknown): Record<string, unknown> {
  return {
    transactionHash: hash,
    transactionIndex: "0x0",
    blockHash: `0x${"bb".repeat(32)}`,
    blockNumber: "0x1",
    from: COW.toLowerCase(),
    to: TO.toLowerCase(),
    contractAddress: null,
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status: "0x1",
    type: "0x0",
  };
}

/** What the fake node does with a raw transaction, after recording it. */
export type RawHandler = (raw: string, request: JsonRpcRequest) => Promise<JsonRpcResponse>;

/** The fake node of {@link setUp}. */
export interface FakeNode {
  /** The pending count the node reports for every address. */
  pending: bigint;
  /** The raw transactions it received, in order. */
  raw: string[];
  /** What it does with a raw transaction, after recording it; by default it accepts it. */
  onRaw: RawHandler | undefined;
  /** The methods it was asked, in order. */
  methods: string[];
  /** The node's answer to eth_getTransactionByHash; it throws when this throws. */
  lookUp: (hash: unknown) => unknown;
}

/** The fake KMS adapters' shared state. */
export interface SignState {
  /** Awaited before each signature, by key name. */
  beforeSign: ((name: string) => Promise<void>) | undefined;
  /** The signatures made. */
  signatures: number;
  /** The adapters closed. */
  closed: number;
}

/** What {@link setUp} gives a test. */
export interface SendHarness {
  node: FakeNode;
  state: SignState;
  timers: FakeTimers;
  /**
   * Opens a connection through the hook: to `remote`, which has the KMS keys, or to `plain`, a
   * network with no KMS keys on the same chain and node.
   */
  open: (network?: "remote" | "plain") => Promise<NetworkConnection<string>>;
  /** Closes a connection through the hook. */
  close: (connection: NetworkConnection<string>) => Promise<void>;
  /** Sends `eth_sendTransaction` with one transaction. */
  send: (
    connection: NetworkConnection<string>,
    tx: Record<string, unknown>,
  ) => Promise<JsonRpcResponse>;
  /** Sends a request whose params are one transaction. */
  request: (
    connection: NetworkConnection<string>,
    method: string,
    tx: Record<string, unknown>,
  ) => Promise<JsonRpcResponse>;
  /** Sends a request with any params, and returns what reached the node too. */
  call: (
    connection: NetworkConnection<string>,
    method: string,
    params: unknown[],
  ) => Promise<{ response: JsonRpcResponse; forwarded: JsonRpcRequest[] }>;
}

/**
 * The network hook's handlers with fake timers, a runtime with two third-party keys (cow, zero),
 * and a fake node. The network sets a fixed gas and gas price, so a fill only reads the chain id
 * and the pending count.
 *
 * @param type - The network type.
 * @param chainId - The chain id of the network and its node. The send locks are process-global
 * and keyed by chain id and address, so a test with a chain id of its own cannot wait behind, or
 * leave waiters for, the sends of another test.
 */
export async function setUp(
  type: "http" | "edr-simulated" = "http",
  chainId = 31337,
): Promise<SendHarness> {
  const keys = Object.fromEntries(Object.keys(SECRETS).map((name) => [name, vaultKey(name)]));
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms],
    kms: { keys },
    networks: {
      remote: {
        type: "http",
        url: "http://127.0.0.1:1",
        chainId,
        gas: 21_000,
        gasPrice: 1,
        kmsAccounts: ["cow", "zero"],
      },
      plain: { type: "http", url: "http://127.0.0.1:1", chainId, gas: 21_000, gasPrice: 1 },
    },
  });
  const state: SignState = { beforeSign: undefined, signatures: 0, closed: 0 };
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (_context, key) => {
      const secret = SECRETS[key.name];
      assert.ok(secret !== undefined);
      const adapter = fakeAdapter({
        secretKey: new Uint8Array(Buffer.from(secret, "hex")),
        beforeSign: async () => {
          state.signatures++;
          await state.beforeSign?.(key.name);
        },
      });
      return {
        ...adapter,
        close: async () => {
          state.closed++;
          await Promise.resolve();
        },
      };
    },
  });

  const node: FakeNode = {
    pending: 0n,
    raw: [],
    onRaw: undefined,
    methods: [],
    lookUp: () => null,
  };
  const answer = async (request: JsonRpcRequest): Promise<JsonRpcResponse> => {
    node.methods.push(request.method);
    const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: request.id, result });
    switch (request.method) {
      case "eth_chainId":
        return ok(`0x${chainId.toString(16)}`);
      case "eth_getTransactionCount":
        return ok(`0x${node.pending.toString(16)}`);
      case "eth_fillTransaction":
        return ok({ raw: "0x", tx: { nonce: `0x${node.pending.toString(16)}` } });
      case "eth_getTransactionByHash":
        return ok(node.lookUp(Array.isArray(request.params) ? request.params[0] : undefined));
      case "eth_sendRawTransaction":
      case "eth_sendRawTransactionSync": {
        const [raw]: unknown[] = Array.isArray(request.params) ? request.params : [];
        assert.ok(typeof raw === "string");
        node.raw.push(raw);
        if (node.onRaw !== undefined) {
          return await node.onRaw(raw, request);
        }
        // EIP-7966: the sync form answers with the receipt.
        return request.method === "eth_sendRawTransaction"
          ? ok(hashOf(raw))
          : ok({ transactionHash: hashOf(raw), status: "0x1" });
      }
      case "eth_blockNumber":
        return ok("0x1");
      case "eth_getTransactionReceipt": {
        // A receipt for each raw transaction the node got, as if mined at once.
        const [hash]: unknown[] = Array.isArray(request.params) ? request.params : [];
        const mined = node.raw.some((raw) => hashOf(raw) === hash);
        return ok(mined ? receiptOf(hash) : null);
      }
      case "wallet_sendTransaction":
        // An endpoint that answers the wallet_sendTransaction viem sends after a failed send.
        return ok(WALLET_SEND_HASH);
      case "wallet_sendCalls":
        // An endpoint that implements EIP-5792 and answers with a call batch id.
        return ok({ id: CALLS_ID });
      default:
        throw new Error(`the fake node does not answer ${request.method}`);
    }
  };

  const timers = fakeTimers();
  const handlers = createNetworkHandlers(timers);
  const { remote, plain } = hre.config.networks;
  assert.ok(remote);
  assert.ok(plain);
  const configs = { remote: type === "http" ? remote : { ...remote, type }, plain };

  const open = async (
    network: "remote" | "plain" = "remote",
  ): Promise<NetworkConnection<string>> => {
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        const response = await answer({ jsonrpc: "2.0", id: 0, method, params: params ?? [] });
        if ("error" in response) {
          throw new Error(response.error.message);
        }
        return response.result;
      },
    };
    const connection = {
      networkName: network,
      networkConfig: configs[network],
      provider,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the fields the hook reads
    } as NetworkConnection<string>;
    assert.ok(handlers.newConnection);
    return await handlers.newConnection(hre, async () => await Promise.resolve(connection));
  };
  const close = async (connection: NetworkConnection<string>): Promise<void> => {
    assert.ok(handlers.closeConnection);
    await handlers.closeConnection(hre, connection, async () => {});
  };
  let id = 1;
  const request = async (
    connection: NetworkConnection<string>,
    method: string,
    tx: Record<string, unknown>,
  ): Promise<JsonRpcResponse> => {
    assert.ok(handlers.onRequest);
    return await handlers.onRequest(
      hre,
      connection,
      { jsonrpc: "2.0", id: id++, method, params: [tx] },
      async (_context, _connection, next) => await answer(next),
    );
  };
  const send = async (connection: NetworkConnection<string>, tx: Record<string, unknown>) =>
    await request(connection, "eth_sendTransaction", tx);
  /** Sends a request with any params through the hook; returns what reached the node, too. */
  const call = async (
    connection: NetworkConnection<string>,
    method: string,
    params: unknown[],
  ): Promise<{ response: JsonRpcResponse; forwarded: JsonRpcRequest[] }> => {
    assert.ok(handlers.onRequest);
    const forwarded: JsonRpcRequest[] = [];
    const response = await handlers.onRequest(
      hre,
      connection,
      { jsonrpc: "2.0", id: id++, method, params },
      async (_context, _connection, next) => {
        forwarded.push(next);
        return await answer(next);
      },
    );
    return { response, forwarded };
  };
  return { node, state, timers, open, close, send, request, call };
}

/** The result of a successful response. */
export function resultOf(response: JsonRpcResponse): unknown {
  assert.ok("result" in response, JSON.stringify(response));
  return response.result;
}

/** The error of a failed response. */
export function errorOf(response: JsonRpcResponse): { code: number; message: string } {
  assert.ok("error" in response, JSON.stringify(response));
  return response.error;
}

/** Waits for a send whose outcome is unknown, and returns its error. */
export async function unknownOutcome(sending: Promise<unknown>): Promise<SendOutcomeUnknownError> {
  const outcome = await sending.then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(outcome instanceof SendOutcomeUnknownError, String(outcome));
  return outcome;
}

/** A transfer from cow with the caller's nonce. */
export function withNonce(nonce: number): Record<string, unknown> {
  return { from: COW, to: TO, nonce: `0x${nonce.toString(16)}` };
}

/** Makes the next broadcast get no answer after the node got the bytes, like a timeout. */
export function failOnce(node: { onRaw: RawHandler | undefined }): void {
  node.onRaw = async () => {
    node.onRaw = undefined;
    await Promise.resolve();
    throw new Error("socket hang up");
  };
}

/** Makes every broadcast get this error answer from the node. */
export function refuse(
  node: { onRaw: RawHandler | undefined },
  message: string,
  code = -32000,
): void {
  node.onRaw = async () =>
    await Promise.resolve({ jsonrpc: "2.0" as const, id: 1, error: { code, message } });
}
