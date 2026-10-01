// The send lock, the nonce high-water mark and the retry cache, through the network hook's
// handlers with a fake node, fake KMS adapters and fake timers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { HardhatError } from "@nomicfoundation/hardhat-errors";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { NetworkConnection } from "hardhat/types/network";
import type { JsonRpcRequest, JsonRpcResponse } from "hardhat/types/providers";
import { Transaction } from "micro-eth-signer";

import hardhatKms from "../../../src/index.ts";
import { createNetworkHandlers } from "../../../src/internal/hook-handlers/network.ts";
import { isAlreadyKnown, isUncertainAnswer } from "../../../src/internal/rpc/dispatcher.ts";
import {
  MAX_RETRY_ENTRIES,
  RETRY_TTL_MS,
  SendOutcomeUnknownError,
  sendLocksInUse,
} from "../../../src/internal/rpc/send-guard.ts";
import { fakeAdapter } from "../../helpers/fake-adapter.ts";
import { fakeTimers } from "../../helpers/fake-timers.ts";
import { vaultKey } from "../../helpers/vault-key.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../../helpers/vectors.ts";

const COW = COW_ACCOUNT.address;
const ZERO = HARDHAT_ACCOUNT_0.address;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SECRETS: Record<string, string> = {
  cow: COW_ACCOUNT.secretKey,
  zero: HARDHAT_ACCOUNT_0.secretKey,
};

/** A promise and the function that resolves it. */
function gate(): { promise: Promise<void>; open: () => void } {
  const control: { open: () => void } = { open: () => {} };
  const promise = new Promise<void>((resolve) => {
    control.open = resolve;
  });
  return { promise, open: () => control.open() };
}

/** Lets pending promise callbacks and I/O callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const nonceOf = (raw: string): bigint => Transaction.fromHex(raw, false).raw.nonce;
const hashOf = (raw: string): string =>
  `0x${Buffer.from(keccak_256(Buffer.from(raw.slice(2), "hex"))).toString("hex")}`;

/** What the fake node does with a raw transaction, after recording it. */
type RawHandler = (raw: string, request: JsonRpcRequest) => Promise<JsonRpcResponse>;

/**
 * The network hook's handlers with fake timers, a runtime with two third-party keys (cow, zero),
 * and a fake node. The network sets a fixed gas and gas price, so a fill only reads the chain id
 * and the pending count.
 */
async function setUp(type: "http" | "edr-simulated" = "http") {
  const keys = Object.fromEntries(Object.keys(SECRETS).map((name) => [name, vaultKey(name)]));
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms],
    kms: { keys },
    networks: {
      remote: {
        type: "http",
        url: "http://127.0.0.1:1",
        chainId: 31337,
        gas: 21_000,
        gasPrice: 1,
        kmsAccounts: ["cow", "zero"],
      },
    },
  });
  const state = {
    /** Awaited before each signature, by key name. */
    beforeSign: undefined as ((name: string) => Promise<void>) | undefined,
    signatures: 0,
    closed: 0,
  };
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

  const node = {
    /** The pending count the node reports for every address. */
    pending: 0n,
    raw: [] as string[],
    onRaw: undefined as RawHandler | undefined,
    methods: [] as string[],
    /** The node's answer to eth_getTransactionByHash; it throws when this throws. */
    lookUp: (_hash: unknown): unknown => null,
  };
  const answer = async (request: JsonRpcRequest): Promise<JsonRpcResponse> => {
    node.methods.push(request.method);
    const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: request.id, result });
    switch (request.method) {
      case "eth_chainId":
        return ok("0x7a69");
      case "eth_getTransactionCount":
        return ok(`0x${node.pending.toString(16)}`);
      case "eth_getTransactionByHash":
        return ok(node.lookUp(Array.isArray(request.params) ? request.params[0] : undefined));
      case "eth_sendRawTransaction": {
        const [raw]: unknown[] = Array.isArray(request.params) ? request.params : [];
        assert.ok(typeof raw === "string");
        node.raw.push(raw);
        return node.onRaw === undefined ? ok(hashOf(raw)) : await node.onRaw(raw, request);
      }
      default:
        throw new Error(`the fake node does not answer ${request.method}`);
    }
  };

  const timers = fakeTimers();
  const handlers = createNetworkHandlers(timers);
  const { remote } = hre.config.networks;
  assert.ok(remote);
  const networkConfig = type === "http" ? remote : { ...remote, type };

  const open = async (): Promise<NetworkConnection<string>> => {
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
      networkName: "remote",
      networkConfig,
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
  return { node, state, timers, open, close, send, request };
}

/** The result of a successful response. */
function resultOf(response: JsonRpcResponse): unknown {
  assert.ok("result" in response, JSON.stringify(response));
  return response.result;
}

/** The error of a failed response. */
function errorOf(response: JsonRpcResponse) {
  assert.ok("error" in response, JSON.stringify(response));
  return response.error;
}

/** Waits for a send whose outcome is unknown, and returns its error. */
async function unknownOutcome(sending: Promise<unknown>): Promise<SendOutcomeUnknownError> {
  const outcome = await sending.then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(outcome instanceof SendOutcomeUnknownError, String(outcome));
  return outcome;
}

/** A transfer from cow with the caller's nonce. */
function withNonce(nonce: number): Record<string, unknown> {
  return { from: COW, to: TO, nonce: `0x${nonce.toString(16)}` };
}

/** Makes the next broadcast get no answer after the node got the bytes, like a timeout. */
function failOnce(node: { onRaw: RawHandler | undefined }): void {
  node.onRaw = async () => {
    node.onRaw = undefined;
    await Promise.resolve();
    throw new Error("socket hang up");
  };
}

/** Makes every broadcast get this error answer from the node. */
function refuse(node: { onRaw: RawHandler | undefined }, message: string, code = -32000): void {
  node.onRaw = async () =>
    await Promise.resolve({ jsonrpc: "2.0" as const, id: 1, error: { code, message } });
}

describe("the send lock", () => {
  it("gives N parallel sends from one account consecutive nonces", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    // The node never counts the sent transactions as pending, so only the lock and the
    // high-water mark keep the nonces apart.
    const hashes = await Promise.all(
      Array.from({ length: 10 }, async () =>
        resultOf(await send(connection, { from: COW, to: TO })),
      ),
    );
    assert.deepEqual(
      node.raw.map(nonceOf),
      Array.from({ length: 10 }, (_, i) => BigInt(i)),
    );
    assert.deepEqual(hashes, node.raw.map(hashOf));
    assert.equal(sendLocksInUse(), 0);
  });

  it("does not make another account wait", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    const held = gate();
    state.beforeSign = async (name) => {
      if (name === "cow") {
        await held.promise;
      }
    };
    const cow = send(connection, { from: COW, to: TO });
    await settle();
    // cow holds its lock while its KMS signature hangs; zero signs and sends meanwhile.
    resultOf(await send(connection, { from: ZERO, to: TO }));
    assert.equal(node.raw.length, 1);
    assert.equal(Transaction.fromHex(node.raw[0] ?? "", false).sender, ZERO);
    held.open();
    resultOf(await cow);
    assert.equal(node.raw.length, 2);
  });

  it("lets eth_signTransaction run while a send holds the lock, and leaves the mark alone", async () => {
    const { node, open, send, request } = await setUp();
    const connection = await open();
    resultOf(await send(connection, { from: COW, to: TO }));
    const held = gate();
    node.onRaw = async (raw) => {
      await held.promise;
      return { jsonrpc: "2.0", id: 1, result: hashOf(raw) };
    };
    const sending = send(connection, { from: COW, to: TO });
    await settle();
    assert.equal(node.raw.length, 2, "the second send is broadcasting, holding the lock");
    const signed = resultOf(
      await request(connection, "eth_signTransaction", { from: COW, to: TO }),
    );
    assert.ok(typeof signed === "string");
    assert.equal(nonceOf(signed), 0n, "the node's pending count, not the high-water mark");
    held.open();
    resultOf(await sending);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n]);
  });

  it("does not hold the signer while broadcasting, so the idle close can run", async () => {
    const { node, state, timers, open, close, send } = await setUp();
    const connection = await open();
    const held = gate();
    node.onRaw = async (raw) => {
      await held.promise;
      return { jsonrpc: "2.0", id: 1, result: hashOf(raw) };
    };
    const sending = send(connection, { from: COW, to: TO });
    await settle();
    assert.equal(node.raw.length, 1, "broadcasting");
    await close(connection);
    timers.fire();
    await settle();
    assert.equal(state.closed, 2, "the idle close did not wait for the node");
    held.open();
    assert.equal(resultOf(await sending), hashOf(node.raw[0] ?? ""));
  });
});

describe("the nonce high-water mark", () => {
  it("never reuses a nonce on a node whose pending count lags, and follows a node ahead", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    await send(connection, { from: COW, to: TO });
    await send(connection, { from: COW, to: TO });
    node.pending = 5n;
    await send(connection, { from: COW, to: TO });
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n, 5n]);
  });

  it("honours the caller's nonce, which also raises the mark", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    await send(connection, { from: COW, to: TO, nonce: "0x7" });
    await send(connection, { from: COW, to: TO });
    await send(connection, { from: COW, to: TO, nonce: "0x2" });
    await send(connection, { from: COW, to: TO });
    assert.deepEqual(node.raw.map(nonceOf), [7n, 8n, 2n, 9n]);
  });

  it("sends a replacement with the same nonce and higher fees, as Ignition's fee bumps do", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    const fees = ["0x1", "0x2", "0x3"];
    for (const gasPrice of fees) {
      resultOf(await send(connection, { from: COW, to: TO, nonce: "0x3", gasPrice }));
    }
    assert.deepEqual(node.raw.map(nonceOf), [3n, 3n, 3n], "the caller's nonce is kept");
    assert.deepEqual(
      node.raw.map((raw): unknown => Reflect.get(Transaction.fromHex(raw, false).raw, "gasPrice")),
      fees.map((fee) => BigInt(fee)),
    );
    assert.equal(state.signatures, 3, "each replacement is signed and sent");
  });

  it("sends a replacement after a failed broadcast of the same nonce", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    await unknownOutcome(send(connection, { from: COW, to: TO, nonce: "0x3", gasPrice: "0x1" }));
    resultOf(await send(connection, { from: COW, to: TO, nonce: "0x3", gasPrice: "0x2" }));
    assert.equal(state.signatures, 2, "other fees are another request: no retry entry");
    assert.deepEqual(node.raw.map(nonceOf), [3n, 3n]);
    assert.notEqual(node.raw[0], node.raw[1]);
  });

  it("is kept per connection", async () => {
    const { node, open, send } = await setUp();
    await send(await open(), { from: COW, to: TO });
    await send(await open(), { from: COW, to: TO });
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n]);
  });

  it("is off on a simulated network, whose pending count is authoritative", async () => {
    const { node, open, send } = await setUp("edr-simulated");
    const connection = await open();
    await send(connection, { from: COW, to: TO });
    await send(connection, { from: COW, to: TO });
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n]);
  });

  it("does not move when signing fails, so the next send gets the same nonce", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    await send(connection, { from: COW, to: TO });
    state.beforeSign = async () => {
      await Promise.resolve();
      throw new Error("KMS unavailable");
    };
    await assert.rejects(send(connection, { from: COW, to: TO }));
    assert.equal(node.raw.length, 1, "nothing was broadcast");
    state.beforeSign = undefined;
    await send(connection, { from: COW, to: TO });
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n]);
    assert.equal(sendLocksInUse(), 0);
  });
});

describe("failures after the broadcast", () => {
  it("pass a node's error answer through unchanged, with no retry entry and the mark kept", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    refuse(node, "insufficient funds for gas * price + value", -32003);
    const first = errorOf(await send(connection, { from: COW, to: TO }));
    assert.deepEqual(first, {
      code: -32003,
      message: "insufficient funds for gas * price + value",
    });
    // The same request again: no retry entry, so it is filled and signed again.
    errorOf(await send(connection, { from: COW, to: TO }));
    assert.equal(state.signatures, 2);
    node.onRaw = undefined;
    await send(connection, { from: COW, to: TO, value: "0x1" });
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n, 0n], "a refused nonce is not skipped");
  });

  it("rethrow a thrown node error unchanged, and count a mined transaction's nonce", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    // Like Hardhat's SolidityError for a transaction that was mined and reverted.
    const reverted = Object.assign(new Error("reverted with custom error"), {
      code: 3,
      data: "0xdeadbeef",
      transactionHash: "0x1234",
    });
    node.onRaw = async () => {
      await Promise.resolve();
      throw reverted;
    };
    await assert.rejects(send(connection, { from: COW, to: TO }), (error) => error === reverted);
    // A node error with the hash only in its data, as Hardhat's nodes send it over JSON-RPC.
    node.onRaw = async () =>
      await Promise.resolve({
        jsonrpc: "2.0" as const,
        id: 1,
        error: { code: 3, message: "reverted", data: { data: "0x", transactionHash: "0x56" } },
      });
    errorOf(await send(connection, { from: COW, to: TO }));
    node.onRaw = undefined;
    await send(connection, { from: COW, to: TO });
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n, 2n], "mined nonces count as used");
    assert.equal(state.signatures, 3);
  });

  it("throw -32000 with the hash when no answer came back, naming only the error's class", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    for (const thrown of [
      new TypeError("fetch failed: https://rpc.example/v2/SECRET-API-KEY"),
      // Hardhat's UnknownError, which wraps a failed HTTP request, has code -1.
      Object.assign(new Error("SECRET-API-KEY"), { name: "UnknownError", code: -1 }),
    ]) {
      node.onRaw = async () => {
        await Promise.resolve();
        throw thrown;
      };
      const error = await unknownOutcome(send(connection, { from: COW, to: TO, value: "0x1" }));
      const hash = hashOf(node.raw.at(-1) ?? "");
      assert.equal(error.code, -32000);
      assert.deepEqual(error.data, { hash });
      assert.equal(error.transactionHash, hash);
      assert.ok(error.message.includes(hash), error.message);
      assert.ok(error.message.includes(`(${thrown.name})`), error.message);
      assert.ok(!error.message.includes("SECRET"), error.message);
    }
  });
});

describe("a gateway's answer that it does not know the outcome", () => {
  it("is classified by code -32603 or a timeout message, and nothing else", () => {
    for (const [code, message] of [
      [-32603, "upstream request timeout"],
      [-32603, "internal error"],
      [-32000, "request timed out"],
      [-32000, "context deadline exceeded"],
      [-32000, "Timeout waiting for the upstream"],
    ] as const) {
      assert.ok(isUncertainAnswer(code, message), `${code} ${message}`);
    }
    for (const [code, message] of [
      [-32000, "nonce too low"],
      [-32003, "insufficient funds for gas * price + value"],
      [-32000, "replacement transaction underpriced"],
      [-32000, "max fee per gas less than block base fee"],
      [-32000, "timeouts are configured elsewhere"],
      [-32000, "execution reverted: Deadline exceeded"],
      [-32000, "Execution reverted: request timed out"],
      [-32603, "execution reverted"],
      [-32603, "revert: timeout"],
      [3, "reverted with reason string 'deadline exceeded'"],
    ] as const) {
      assert.ok(!isUncertainAnswer(code, message), `${code} ${message}`);
    }
  });

  for (const [code, message] of [
    [-32603, "upstream request timeout"],
    [-32000, "request timed out"],
  ] as const) {
    it(`passes ${code} "${message}" through, and keeps a retry entry and an uncertain record`, async () => {
      const { node, state, open, send } = await setUp();
      const connection = await open();
      refuse(node, message, code);
      assert.deepEqual(errorOf(await send(connection, { from: COW, to: TO })), { code, message });
      node.onRaw = undefined;
      // The retry sends the same bytes.
      resultOf(await send(connection, { from: COW, to: TO }));
      assert.equal(state.signatures, 1);
      assert.equal(node.raw[0], node.raw[1]);

      // A second gateway answer, then another request: the node is asked about the first.
      refuse(node, message, code);
      errorOf(await send(connection, { from: COW, to: TO, value: "0x1" }));
      node.onRaw = undefined;
      const looked: unknown[] = [];
      node.lookUp = (asked) => {
        looked.push(asked);
        return { hash: asked };
      };
      await send(connection, { from: COW, to: TO, value: "0x2" });
      assert.deepEqual(looked, [hashOf(node.raw[2] ?? "")]);
      assert.deepEqual(node.raw.map(nonceOf), [0n, 0n, 1n, 2n]);
    });
  }

  it("leaves a refusal, and a revert whose reason mentions a timeout, definite", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    refuse(node, "nonce too low");
    errorOf(await send(connection, { from: COW, to: TO }));
    refuse(node, "reverted with reason string 'deadline exceeded'", 3);
    errorOf(await send(connection, { from: COW, to: TO }));
    node.onRaw = undefined;
    let lookups = 0;
    node.lookUp = () => {
      lookups++;
      return null;
    };
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.equal(state.signatures, 3, "no retry entry: each request was signed");
    assert.equal(lookups, 0, "no uncertain record");
  });
});

/** Hardhat's error for a refused connection (HHE703). */
function refused(): HardhatError {
  return new HardhatError(HardhatError.ERRORS.CORE.NETWORK.CONNECTION_REFUSED, {
    network: "remote",
  });
}

describe("a refused connection", () => {
  it("rethrows Hardhat's error unchanged and keeps nothing: the transaction was not sent", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    const error = refused();
    node.onRaw = async () => {
      await Promise.resolve();
      throw error;
    };
    await assert.rejects(send(connection, { from: COW, to: TO }), (thrown) => thrown === error);
    assert.ok(!("transactionHash" in error));
    node.onRaw = undefined;
    let lookups = 0;
    node.lookUp = () => {
      lookups++;
      return null;
    };
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.equal(state.signatures, 2, "no retry entry");
    assert.equal(lookups, 0, "no uncertain record");
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n]);
  });

  it("keeps the retry entry when it refuses a retry's bytes", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    await unknownOutcome(send(connection, { from: COW, to: TO }));
    node.onRaw = async () => {
      await Promise.resolve();
      throw refused();
    };
    await assert.rejects(send(connection, { from: COW, to: TO }), HardhatError);
    node.onRaw = undefined;
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.equal(state.signatures, 1, "every attempt sent the first bytes");
    assert.equal(new Set(node.raw).size, 1);
  });
});

describe("a send whose outcome is unknown", () => {
  it("is also what a thrown value that is not an error gives", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    node.onRaw = async () => {
      await Promise.resolve();
      // oxlint-disable-next-line typescript/only-throw-error -- a downstream handler may throw anything
      throw "connection reset";
    };
    const error = await unknownOutcome(send(connection, { from: COW, to: TO }));
    assert.match(error.message, /\(string\)/);
  });

  it("raises the mark on the next send when the node has the transaction", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    await unknownOutcome(send(connection, { from: COW, to: TO, value: "0x1" }));
    const hash = hashOf(node.raw[0] ?? "");
    const looked: unknown[] = [];
    node.lookUp = (asked) => {
      looked.push(asked);
      return { hash: asked };
    };
    await send(connection, { from: COW, to: TO, value: "0x2" });
    await send(connection, { from: COW, to: TO, value: "0x3" });
    assert.deepEqual(looked, [hash], "looked up once");
    assert.deepEqual(node.raw.map(nonceOf), [0n, 1n, 2n], "the lost answer's nonce is not reused");
  });

  it("keeps the mark when the node does not have it, or the lookup fails", async () => {
    for (const lookUp of [
      () => null,
      () => {
        throw new Error("lookup failed");
      },
    ]) {
      const { node, open, send } = await setUp();
      const connection = await open();
      failOnce(node);
      await unknownOutcome(send(connection, { from: COW, to: TO, value: "0x1" }));
      node.lookUp = lookUp;
      await send(connection, { from: COW, to: TO, value: "0x2" });
      assert.deepEqual(node.raw.map(nonceOf), [0n, 0n]);
    }
  });

  it("is looked up only by a send without the caller's nonce", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    await unknownOutcome(send(connection, { from: COW, to: TO }));
    let lookups = 0;
    node.lookUp = (asked) => {
      lookups++;
      return { hash: asked };
    };
    await send(connection, { from: COW, to: TO, nonce: "0x0", gasPrice: "0x2" });
    assert.equal(lookups, 0);
    await send(connection, { from: COW, to: TO, value: "0x1" });
    assert.equal(lookups, 1);
  });

  it("is forgotten once a retry gets an answer", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    await unknownOutcome(send(connection, { from: COW, to: TO }));
    resultOf(await send(connection, { from: COW, to: TO }));
    let lookups = 0;
    node.lookUp = () => {
      lookups++;
      return null;
    };
    await send(connection, { from: COW, to: TO, value: "0x1" });
    assert.equal(lookups, 0);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n, 1n]);
  });

  it("is not kept on a simulated network", async () => {
    const { node, open, send } = await setUp("edr-simulated");
    const connection = await open();
    failOnce(node);
    await unknownOutcome(send(connection, { from: COW, to: TO }));
    let lookups = 0;
    node.lookUp = () => {
      lookups++;
      return null;
    };
    await send(connection, { from: COW, to: TO, value: "0x1" });
    assert.equal(lookups, 0);
  });
});

describe("isAlreadyKnown", () => {
  it("matches what clients say for a transaction they already have, and nothing else", () => {
    for (const message of [
      "already known",
      "AlreadyKnown",
      "Known transaction: 0x15872f37",
      "known transaction: 0x12",
      "  already known",
    ]) {
      assert.ok(isAlreadyKnown(message), message);
    }
    for (const message of [
      "unknown transaction type",
      "Unknown transaction",
      "transaction already known to the pool, but the fee is too low",
      "nonce too low",
      "",
    ]) {
      assert.ok(!isAlreadyKnown(message), message);
    }
  });
});

describe("the retry cache", () => {
  it("sends the same bytes again for a retry of the same request, and returns the same hash", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    const first = await unknownOutcome(send(connection, { from: COW, to: TO, value: "0x1" }));
    // The same params, with the keys in another order.
    const retried = resultOf(await send(connection, { value: "0x1", to: TO, from: COW }));
    assert.equal(first.transactionHash, retried);
    assert.equal(node.raw.length, 2);
    assert.equal(node.raw[0], node.raw[1], "the same bytes");
    assert.equal(state.signatures, 1, "nothing was filled or signed again");
    // The entry was consumed; the retry's success raised the mark.
    await send(connection, { from: COW, to: TO, value: "0x1" });
    assert.equal(state.signatures, 2);
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n, 1n]);
  });

  it("counts 'already known' as success when it sends the bytes again", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    const answers = [
      { kind: "answer", message: "already known" },
      { kind: "answer", message: "AlreadyKnown" },
      { kind: "thrown", message: "known transaction: 0x12" },
    ];
    for (const [index, answer] of answers.entries()) {
      const data = `0x0${index}`;
      failOnce(node);
      const { transactionHash } = await unknownOutcome(
        send(connection, { from: COW, to: TO, data }),
      );
      node.onRaw = async () => {
        await Promise.resolve();
        if (answer.kind === "thrown") {
          throw Object.assign(new Error(answer.message), { code: -32000 });
        }
        return { jsonrpc: "2.0", id: 1, error: { code: -32000, message: answer.message } };
      };
      const retried = await send(connection, { from: COW, to: TO, data });
      assert.equal(resultOf(retried), transactionHash, answer.message);
      node.onRaw = undefined;
    }
  });

  it("does not take 'unknown transaction type' or 'Unknown transaction' for 'already known'", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    for (const message of ["unknown transaction type", "Unknown transaction"]) {
      failOnce(node);
      await unknownOutcome(send(connection, { from: COW, to: TO, value: "0x1" }));
      refuse(node, message);
      assert.equal(
        errorOf(await send(connection, { from: COW, to: TO, value: "0x1" })).message,
        message,
      );
      node.onRaw = undefined;
    }
  });

  it("counts a refused retry as success when the node has the transaction", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    const { transactionHash } = await unknownOutcome(send(connection, { from: COW, to: TO }));
    refuse(node, "nonce too low");
    const looked: unknown[] = [];
    node.lookUp = (asked) => {
      looked.push(asked);
      return { hash: asked };
    };
    assert.equal(resultOf(await send(connection, { from: COW, to: TO })), transactionHash);
    assert.deepEqual(looked, [transactionHash]);
    node.onRaw = undefined;
    await send(connection, { from: COW, to: TO, value: "0x1" });
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n, 1n], "its nonce counts as used");
    assert.deepEqual(looked, [transactionHash], "and its uncertain record is gone");
  });

  it("signs afresh when the node does not have a retry's transaction and a later send took its nonce", async () => {
    // A gets no answer; B, another request, looks A up, gets nothing and takes nonce 0; the caller
    // then retries A. A's old bytes would replace B, so A is signed again with the next nonce.
    const { node, state, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    await unknownOutcome(send(connection, { from: COW, to: TO, value: "0x1" }));
    resultOf(await send(connection, { from: COW, to: TO, value: "0x2" }));
    resultOf(await send(connection, { from: COW, to: TO, value: "0x1" }));
    assert.equal(state.signatures, 3, "the retry of A was signed again");
    assert.deepEqual(node.raw.map(nonceOf), [0n, 0n, 1n]);
    assert.notEqual(node.raw[2], node.raw[0], "A's old bytes were not sent again");
  });

  it("drops a retry entry when the lookup finds nothing, also when the later send gets no answer", async () => {
    // A and then B get no answer, so no nonce is marked as used. B's send looked A up and found
    // nothing; B may hold A's nonce, so a retry of A must not send A's old bytes.
    const { node, state, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    await unknownOutcome(send(connection, { from: COW, to: TO, value: "0x1" }));
    failOnce(node);
    await unknownOutcome(send(connection, { from: COW, to: TO, value: "0x2" }));
    resultOf(await send(connection, { from: COW, to: TO, value: "0x1" }));
    // Filled again: here the node's pending count is still 0, so the new bytes happen to match.
    assert.equal(state.signatures, 3, "the retry of A was filled and signed again, not resent");
  });

  it("does not resend bytes whose nonce a later send used, unless the node has them", async () => {
    for (const has of [false, true]) {
      const { node, state, open, send } = await setUp();
      const connection = await open();
      failOnce(node);
      const first = await unknownOutcome(send(connection, { from: COW, to: TO, value: "0x1" }));
      // B chooses nonce 0 itself, so nothing looks A up, and its retry entry stays.
      resultOf(await send(connection, { from: COW, to: TO, nonce: "0x0", gasPrice: "0x2" }));
      const looked: unknown[] = [];
      node.lookUp = (asked) => {
        looked.push(asked);
        return has ? { hash: asked } : null;
      };
      const retried = resultOf(await send(connection, { from: COW, to: TO, value: "0x1" }));
      assert.ok(looked.includes(first.transactionHash), "the node was asked about A");
      if (has) {
        assert.equal(retried, first.transactionHash);
        assert.equal(node.raw.length, 2, "nothing was sent: the node has A");
        assert.equal(state.signatures, 2);
      } else {
        assert.equal(state.signatures, 3, "A was signed again");
        assert.deepEqual(node.raw.map(nonceOf), [0n, 0n, 1n]);
        assert.notEqual(node.raw[2], node.raw[0]);
      }
    }
  });

  it("asks the node about a revert without a hash when it sends bytes again", async () => {
    for (const has of [true, false]) {
      const { node, open, send } = await setUp();
      const connection = await open();
      failOnce(node);
      const first = await unknownOutcome(send(connection, { from: COW, to: TO }));
      refuse(node, "execution reverted", 3);
      node.lookUp = (asked) => (has ? { hash: asked } : null);
      const retried = await send(connection, { from: COW, to: TO });
      if (has) {
        assert.equal(resultOf(retried), first.transactionHash);
      } else {
        assert.deepEqual(errorOf(retried), { code: 3, message: "execution reverted" });
      }
    }
  });

  it("keeps the bytes when a retry gets a gateway's 'I don't know', for the next retry", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    await unknownOutcome(send(connection, { from: COW, to: TO }));
    refuse(node, "upstream request timeout", -32603);
    errorOf(await send(connection, { from: COW, to: TO }));
    node.onRaw = undefined;
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.equal(state.signatures, 1);
    assert.equal(node.raw.length, 3);
    assert.equal(new Set(node.raw).size, 1, "the same bytes all three times");
  });

  it("does not look up a transaction the node refused on its first send", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    refuse(node, "nonce too low");
    let lookups = 0;
    node.lookUp = (asked) => {
      lookups++;
      return { hash: asked };
    };
    assert.equal(errorOf(await send(connection, { from: COW, to: TO })).message, "nonce too low");
    assert.equal(lookups, 0);
  });

  it("does not count 'already known' as success on a first send", async () => {
    const { node, open, send } = await setUp();
    const connection = await open();
    refuse(node, "already known");
    assert.equal(errorOf(await send(connection, { from: COW, to: TO })).message, "already known");
  });

  it("drops the entry when sending again gets a refusal, and keeps it when there is no answer", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    node.onRaw = async () => {
      await Promise.resolve();
      throw new Error("socket hang up");
    };
    for (let i = 0; i < 3; i++) {
      await unknownOutcome(send(connection, { from: COW, to: TO }));
    }
    assert.equal(state.signatures, 1);
    assert.equal(new Set(node.raw).size, 1, "one transaction, sent three times");
    refuse(node, "nonce too low");
    assert.equal(errorOf(await send(connection, { from: COW, to: TO })).message, "nonce too low");
    assert.equal(state.signatures, 1, "the refused retry sent the kept bytes");
    errorOf(await send(connection, { from: COW, to: TO }));
    assert.equal(state.signatures, 2, "no entry is left: filled and signed again");
  });

  it("is missed by other params, another account and another connection", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    await unknownOutcome(send(connection, { from: COW, to: TO, value: "0x1" }));
    resultOf(await send(connection, { from: COW, to: TO, value: "0x2" }));
    resultOf(await send(connection, { from: ZERO, to: TO, value: "0x1" }));
    resultOf(await send(await open(), { from: COW, to: TO, value: "0x1" }));
    assert.equal(state.signatures, 4, "each was filled and signed");
    assert.equal(node.raw.length, 4);
  });

  it("expires after 120 s", async () => {
    const { node, state, timers, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    await unknownOutcome(send(connection, { from: COW, to: TO }));
    assert.deepEqual(timers.delays(), [RETRY_TTL_MS]);
    timers.fire();
    resultOf(await send(connection, { from: COW, to: TO }));
    assert.equal(state.signatures, 2, "filled and signed again");
  });

  it(`keeps at most ${MAX_RETRY_ENTRIES} entries per connection`, async () => {
    const { node, state, timers, open, send } = await setUp();
    const connection = await open();
    node.onRaw = async () => {
      await Promise.resolve();
      throw new Error("socket hang up");
    };
    // Each with the caller's nonce, so no send looks up the one before and drops its entry.
    for (let i = 0; i <= MAX_RETRY_ENTRIES; i++) {
      await unknownOutcome(send(connection, withNonce(i)));
    }
    assert.equal(timers.pending(), MAX_RETRY_ENTRIES, "the oldest entry's timer is cancelled");
    node.onRaw = undefined;
    const signatures = state.signatures;
    resultOf(await send(connection, withNonce(1)));
    assert.equal(state.signatures, signatures, "a newer entry is still there");
    resultOf(await send(connection, withNonce(0)));
    assert.equal(state.signatures, signatures + 1, "the oldest entry was dropped");
  });

  it("is dropped when the connection closes", async () => {
    const { node, timers, open, close, send } = await setUp();
    const connection = await open();
    const other = await open();
    failOnce(node);
    await unknownOutcome(send(connection, { from: COW, to: TO }));
    await close(connection);
    assert.equal(timers.pending(), 0, "the entry's timer is cancelled");
    await close(other);
  });

  it("keeps no entry for params it cannot serialize", async () => {
    const { node, state, open, send } = await setUp();
    const connection = await open();
    failOnce(node);
    await unknownOutcome(send(connection, { from: COW, to: TO, extra: new Date(0) }));
    resultOf(await send(connection, { from: COW, to: TO, extra: new Date(0) }));
    assert.equal(state.signatures, 2);
  });
});
