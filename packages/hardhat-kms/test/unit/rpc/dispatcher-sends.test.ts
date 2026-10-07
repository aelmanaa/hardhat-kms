// dispatch() for sends: what a broadcast's answer does to the retry entry, the uncertain record
// and the high-water mark; raw transactions; and the nonces of library accounts. Each test has a
// chain id of its own, since the send locks and library holds are process-global.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import type { JsonRpcRequest } from "hardhat/types/providers";
import { Transaction } from "micro-eth-signer";

import {
  isAlreadyKnown,
  isUncertainAnswer,
  libraryNonce,
  resetLibraryNonce,
} from "../../../src/internal/rpc/dispatcher.ts";
import { libraryHoldOf, SendOutcomeUnknownError } from "../../../src/internal/rpc/send-guard.ts";
import {
  COW,
  type DispatchFixture,
  dispatchFixture,
  ErrorAnswer,
  type FixtureOptions,
  resultOf,
  ZERO,
} from "../../helpers/dispatch-fixture.ts";
import { COW_ACCOUNT } from "../../helpers/vectors.ts";

const cow = COW.toLowerCase();
let nextChainId = 70_000n;

/** A fixture on a chain of its own. */
async function fixtureOnOwnChain(options: FixtureOptions = {}): Promise<DispatchFixture> {
  nextChainId++;
  return await dispatchFixture({ ...options, chainId: nextChainId });
}

const hashOf = (raw: string): string =>
  `0x${Buffer.from(keccak_256(Buffer.from(raw.slice(2), "hex"))).toString("hex")}`;
const rawOf = (request: JsonRpcRequest): string => {
  const [raw]: unknown[] = Array.isArray(request.params) ? request.params : [];
  assert.ok(typeof raw === "string");
  return raw;
};
const nonceOf = (raw: string): bigint => Transaction.fromHex(raw, false).raw.nonce;

/** The raw transactions the node got, in order. */
function broadcasts(fixture: DispatchFixture): string[] {
  return fixture.forwarded
    .filter((request) => request.method.startsWith("eth_sendRawTransaction"))
    .map((request) => rawOf(request));
}

/** The lookups by hash the dispatcher made. */
function lookups(fixture: DispatchFixture): number {
  return fixture.reads.filter((read) => read.method === "eth_getTransactionByHash").length;
}

/** The signatures the fake adapters made. */
function signatures(fixture: DispatchFixture): number {
  return fixture.adapters.reduce((sum, adapter) => sum + adapter.calls.signDigest, 0);
}

/** The node accepts raw transactions with their hash. */
function accept(fixture: DispatchFixture): void {
  fixture.answers.set("eth_sendRawTransaction", (request) => hashOf(rawOf(request)));
}

/** The node answers each raw transaction with these answers in turn, then accepts. */
function answerInTurn(fixture: DispatchFixture, ...turns: ((raw: string) => unknown)[]): void {
  fixture.answers.set("eth_sendRawTransaction", (request) => {
    const turn = turns.shift();
    return turn === undefined ? hashOf(rawOf(request)) : turn(rawOf(request));
  });
}

const noAnswer = (): never => {
  throw new Error("socket hang up");
};

/** Sends a transfer from cow; `nonce` is the caller's, if given. */
async function send(fixture: DispatchFixture, nonce?: number) {
  const tx =
    nonce === undefined
      ? { from: COW, to: ZERO }
      : { from: COW, to: ZERO, nonce: `0x${nonce.toString(16)}` };
  return await fixture.request("eth_sendTransaction", [tx]);
}

/** A transfer signed by cow outside the plugin. */
function cowRaw(chainId: bigint, nonce: bigint, fees: { maxFeePerGas?: bigint } = {}): string {
  return Transaction.prepare(
    {
      to: ZERO,
      nonce,
      chainId,
      maxFeePerGas: fees.maxFeePerGas ?? 2n,
      maxPriorityFeePerGas: 1n,
      gasLimit: 21_000n,
      value: 1n,
    },
    false,
  )
    .signBy(new Uint8Array(Buffer.from(COW_ACCOUNT.secretKey, "hex")), false)
    .toHex(true);
}

describe("isUncertainAnswer", () => {
  it("reads a revert only at the start of the message, after any spaces", () => {
    assert.equal(isUncertainAnswer(-32603, "  execution reverted"), false);
    assert.equal(isUncertainAnswer(-32603, "\trevert: timed out"), false);
    assert.equal(isUncertainAnswer(-32603, "internal error: execution reverted"), true);
    assert.equal(isUncertainAnswer(-32603, "internal error"), true);
    assert.equal(isUncertainAnswer("-32603", "internal error"), false);
    // A message that is not a string says nothing, even one that reads as the text.
    assert.equal(isUncertainAnswer(-32603, ["execution reverted"]), true);
    assert.equal(isUncertainAnswer(-32000, ["timed out"]), false);
    assert.equal(isUncertainAnswer(-32000, "request timed out"), true);
  });

  it("is told apart from 'already known', which needs a string", () => {
    assert.equal(isAlreadyKnown("already known"), true);
    assert.equal(isAlreadyKnown(["already known"]), false);
  });
});

describe("a send through the plugin", () => {
  it("broadcasts at most once per request, and a retry after no answer sends the same bytes", async () => {
    const fixture = await fixtureOnOwnChain();
    answerInTurn(fixture, noAnswer);
    const first = await send(fixture).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(first instanceof SendOutcomeUnknownError, String(first));
    const [raw] = broadcasts(fixture);
    assert.ok(raw !== undefined);
    assert.equal(
      first.message,
      `eth_sendTransaction: transaction ${hashOf(raw)} was handed to the node, but no answer came back (Error). It may still be mined: look it up by its hash before sending another transaction. Repeating the same request within 120 s sends the same transaction again.`,
    );
    assert.equal(resultOf(await send(fixture)), hashOf(raw));
    assert.deepEqual(broadcasts(fixture), [raw, raw]);
    assert.equal(signatures(fixture), 1);
  });

  it("keeps the bytes for a retry after an internal error answer, whatever its message", async () => {
    const fixture = await fixtureOnOwnChain();
    answerInTurn(fixture, () => new ErrorAnswer(-32603, "internal error"));
    const response = await send(fixture);
    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32603, message: "internal error" },
    });
    const [raw] = broadcasts(fixture);
    assert.ok(raw !== undefined);
    assert.equal(resultOf(await send(fixture)), hashOf(raw));
    assert.equal(signatures(fixture), 1);
  });

  it("takes a revert without a hash as definite, even when its message says it timed out", async () => {
    const fixture = await fixtureOnOwnChain();
    answerInTurn(fixture, () => new ErrorAnswer(3, "request timed out"));
    await send(fixture);
    // No retry entry: the retry signs again.
    resultOf(await send(fixture));
    assert.equal(signatures(fixture), 2);
  });

  it("counts the nonce of a transaction an error answer says was mined", async () => {
    const fixture = await fixtureOnOwnChain();
    answerInTurn(
      fixture,
      (raw) => new ErrorAnswer(-32000, "reverted", { transactionHash: hashOf(raw) }),
    );
    await send(fixture);
    assert.equal(fixture.sends.highWaterOf(cow), 0n);
  });

  it("does not take an answer whose transactionHash is not a string, or whose data is null, for mined", async () => {
    for (const data of [{ transactionHash: 123 }, null, "0xhash"]) {
      const fixture = await fixtureOnOwnChain();
      answerInTurn(fixture, () => new ErrorAnswer(-32000, "refused", data));
      await send(fixture);
      assert.equal(fixture.sends.highWaterOf(cow), undefined, JSON.stringify(data));
    }
  });

  it("ends the reservations up to its nonce when the node takes it", async () => {
    const fixture = await fixtureOnOwnChain();
    accept(fixture);
    fixture.sends.reserve(cow, 0n);
    // The reservation makes the send take nonce 1, and the node's answer ends it.
    const hash = resultOf(await send(fixture));
    const [raw] = broadcasts(fixture);
    assert.ok(raw !== undefined);
    assert.equal(hash, hashOf(raw));
    assert.equal(nonceOf(raw), 1n);
    assert.equal(fixture.sends.hasReservations(cow), false);
    answerInTurn(
      fixture,
      (sent) => new ErrorAnswer(-32000, "reverted", { transactionHash: hashOf(sent) }),
    );
    fixture.sends.reserve(cow, 2n);
    await send(fixture);
    assert.equal(fixture.sends.hasReservations(cow), false);
  });
});

/** A first send without an answer, so the next send of the same request sends its bytes again. */
async function afterNoAnswer(fixture: DispatchFixture): Promise<string> {
  answerInTurn(fixture, noAnswer);
  await send(fixture).catch(() => undefined);
  const raw = broadcasts(fixture).at(-1);
  assert.ok(raw !== undefined);
  return raw;
}

describe("a retry's bytes sent again", () => {
  it("asks the node about a revert that says 'already known', rather than trusting it", async () => {
    const fixture = await fixtureOnOwnChain();
    await afterNoAnswer(fixture);
    answerInTurn(fixture, () => new ErrorAnswer(3, "already known"));
    const response = await send(fixture);
    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 7,
      error: { code: 3, message: "already known" },
    });
    assert.equal(lookups(fixture), 1);
  });

  it("does not read a message that is not a string as 'already known'", async () => {
    const fixture = await fixtureOnOwnChain();
    await afterNoAnswer(fixture);
    // A thrown answer from a broken node, whose message is a list.
    const thrown = Object.assign(new Error("refused"), {
      code: -32000,
      message: ["already known"],
    });
    answerInTurn(fixture, () => {
      throw thrown;
    });
    await assert.rejects(send(fixture), (error: unknown) => error === thrown);
    assert.equal(lookups(fixture), 1, "the node is asked, as for any refusal of the same bytes");
  });

  it("settles the uncertain record after a revert or a refusal the node confirms", async () => {
    for (const refusal of [
      new ErrorAnswer(3, "reverted"),
      new ErrorAnswer(-32000, "nonce too low"),
    ]) {
      const fixture = await fixtureOnOwnChain();
      await afterNoAnswer(fixture);
      answerInTurn(fixture, () => refusal);
      await send(fixture);
      assert.equal(lookups(fixture), 1, "the node is asked whether it has the bytes");
      // The record is settled, so the next send does not look the transaction up again.
      accept(fixture);
      await fixture.request("eth_sendTransaction", [{ from: COW, to: ZERO, value: "0x2" }]);
      assert.equal(lookups(fixture), 1);
    }
  });

  it("returns the hash of bytes a later send's nonce passed when the node has them, and settles them", async () => {
    const fixture = await fixtureOnOwnChain();
    // A first send takes nonce 0, so the mark is not 0 when the retry reads it.
    accept(fixture);
    await fixture.request("eth_sendTransaction", [{ from: COW, to: ZERO, value: "0x9" }]);
    const raw = await afterNoAnswer(fixture);
    assert.equal(nonceOf(raw), 1n);
    // A later send with the caller's nonce, which looks nothing up and raises the mark.
    accept(fixture);
    await fixture.request("eth_sendTransaction", [
      { from: COW, to: ZERO, value: "0x2", nonce: "0x1" },
    ]);
    fixture.answers.set("eth_getTransactionByHash", () => ({ hash: hashOf(raw) }));
    assert.equal(resultOf(await send(fixture)), hashOf(raw));
    assert.equal(lookups(fixture), 1);
    assert.equal(broadcasts(fixture).length, 3, "the retry sends nothing: the node has the bytes");
    // Settled: the next send does not look it up again.
    await fixture.request("eth_sendTransaction", [{ from: COW, to: ZERO, value: "0x3" }]);
    assert.equal(lookups(fixture), 1);
  });
});

/** A fixture whose KMS addresses are known, as after a first send or eth_accounts. */
async function known(): Promise<DispatchFixture> {
  const fixture = await fixtureOnOwnChain();
  await fixture.accounts.addresses();
  return fixture;
}

describe("a KMS account's raw transaction", () => {
  it("is recognised with fees that strict decoding refuses", async () => {
    const fixture = await known();
    accept(fixture);
    const raw = cowRaw(fixture.chainId, 4n, { maxFeePerGas: 20_000n * 10n ** 9n });
    assert.equal(resultOf(await fixture.request("eth_sendRawTransaction", [raw])), hashOf(raw));
    assert.equal(fixture.sends.highWaterOf(cow), 4n);
  });

  it("passes on unchanged when the chain id cannot be read", async () => {
    const fixture = await known();
    accept(fixture);
    fixture.chainIdFails = true;
    const raw = cowRaw(fixture.chainId, 4n);
    assert.equal(resultOf(await fixture.request("eth_sendRawTransaction", [raw])), hashOf(raw));
    assert.equal(fixture.sends.highWaterOf(cow), undefined);
  });

  it("takes EIP-7966's timeout as in the pool only for the sync method", async () => {
    const fixture = await known();
    fixture.answers.set("eth_sendRawTransaction", () => new ErrorAnswer(4, "no receipt yet"));
    await fixture.request("eth_sendRawTransaction", [cowRaw(fixture.chainId, 4n)]);
    assert.equal(fixture.sends.highWaterOf(cow), undefined);
    fixture.answers.set("eth_sendRawTransactionSync", () => new ErrorAnswer(4, "no receipt yet"));
    await fixture.request("eth_sendRawTransactionSync", [cowRaw(fixture.chainId, 5n)]);
    assert.equal(fixture.sends.highWaterOf(cow), 5n);
  });

  it("settles the uncertain record when the node takes the same bytes", async () => {
    const fixture = await known();
    answerInTurn(fixture, noAnswer);
    await send(fixture).catch(() => undefined);
    const [raw] = broadcasts(fixture);
    assert.ok(raw !== undefined);
    accept(fixture);
    await fixture.request("eth_sendRawTransaction", [raw]);
    // Settled: the next send looks nothing up.
    await fixture.request("eth_sendTransaction", [{ from: COW, to: ZERO, value: "0x2" }]);
    assert.equal(lookups(fixture), 0);
  });

  it("does not read a thrown answer whose message is a list as 'already known'", async () => {
    const fixture = await known();
    const thrown = Object.assign(new Error("refused"), {
      code: -32000,
      message: ["already known"],
    });
    fixture.answers.set("eth_sendRawTransaction", () => {
      throw thrown;
    });
    await assert.rejects(
      fixture.request("eth_sendRawTransaction", [cowRaw(fixture.chainId, 4n)]),
      (error: unknown) => error === thrown,
    );
    assert.equal(fixture.sends.highWaterOf(cow), undefined);
  });

  it("does not look at params that are not a string", async () => {
    const fixture = await known();
    fixture.answers.set("eth_sendRawTransaction", () => "0xhash");
    assert.equal(resultOf(await fixture.request("eth_sendRawTransaction", [5])), "0xhash");
    assert.deepEqual(fixture.forwarded.at(-1)?.params, [5]);
  });

  it("marks a reservation failed when the node refuses its raw transaction or gives no answer", async () => {
    for (const refusal of [
      () => new ErrorAnswer(-32000, "nonce too low"),
      () => {
        throw new Error("socket hang up");
      },
    ]) {
      const fixture = await known();
      fixture.sends.reserve(cow, 0n);
      fixture.sends.reserve(cow, 1n);
      fixture.answers.set("eth_sendRawTransaction", refusal);
      await fixture
        .request("eth_sendRawTransaction", [cowRaw(fixture.chainId, 0n)])
        .catch(() => undefined);
      // The reset ends the failed reservation (0), not the newest one (1).
      await resetLibraryNonce(fixture.transactions, cow, fixture.chainId);
      assert.equal(fixture.sends.nonceFor(cow, 0n), 2n);
    }
  });
});

/** A nonce request of cow on the fixture's chain. */
const nonceRequest = (fixture: DispatchFixture, reserve: boolean, ownTransport = false) => ({
  address: cow,
  chainId: fixture.chainId,
  reserve,
  ownTransport,
});

describe("a library account's nonce", () => {
  it("reads the pending count of the account, and names the call when the answer is not a string", async () => {
    const fixture = await fixtureOnOwnChain();
    fixture.answers.set("eth_getTransactionCount", () => "0x3");
    assert.equal(await libraryNonce(fixture.transactions, nonceRequest(fixture, false)), 3n);
    assert.deepEqual(fixture.reads.at(-1), {
      method: "eth_getTransactionCount",
      params: [cow, "pending"],
    });
    fixture.answers.set("eth_getTransactionCount", () => 3);
    for (const [reserve, operation] of [
      [false, "nonceManager.get"],
      [true, "nonceManager.consume"],
    ] as const) {
      await assert.rejects(
        libraryNonce(fixture.transactions, nonceRequest(fixture, reserve, true)),
        (error: unknown) =>
          error instanceof Error &&
          error.message ===
            `${operation}: the node's eth_getTransactionCount answer is not a string`,
      );
    }
  });

  it("refuses a consume from inside a send from the same account, naming the call", async () => {
    let inner: unknown;
    const fixture = await fixtureOnOwnChain({
      beforeSign: async () => {
        inner = await libraryNonce(fixture.transactions, nonceRequest(fixture, true)).catch(
          (error: unknown) => error,
        );
      },
    });
    accept(fixture);
    resultOf(await send(fixture));
    assert.ok(inner instanceof Error);
    assert.equal(
      inner.message,
      `nonceManager.consume: A transaction of the library account ${cow} on chain ${fixture.chainId} was started from inside an earlier send from the same account on that chain, for example by a hook during its fill or broadcast. It would wait for itself, so it was not signed or sent.`,
    );
  });

  it("owes the reset of a held send whose raw transaction got no answer", async () => {
    const fixture = await fixtureOnOwnChain();
    const key = `${fixture.chainId}:${cow}`;
    fixture.answers.set("eth_sendRawTransaction", () => {
      throw new Error("socket hang up");
    });
    const nonce = await libraryNonce(fixture.transactions, nonceRequest(fixture, true));
    await assert.rejects(
      fixture.request("eth_sendRawTransaction", [cowRaw(fixture.chainId, nonce)]),
      /socket hang up/,
    );
    assert.equal(libraryHoldOf(key), undefined, "the failed broadcast ended its hold");
    // The next send holds the lock; the failed send's reset must not end that hold.
    await libraryNonce(fixture.transactions, nonceRequest(fixture, true));
    await resetLibraryNonce(fixture.transactions, cow, fixture.chainId);
    assert.ok(libraryHoldOf(key) !== undefined);
    await resetLibraryNonce(fixture.transactions, cow, fixture.chainId);
    assert.equal(libraryHoldOf(key), undefined);
  });

  it("ignores a reset for another chain, which holds nothing on this connection", async () => {
    const fixture = await fixtureOnOwnChain();
    await libraryNonce(fixture.transactions, nonceRequest(fixture, true, true));
    assert.equal(fixture.sends.hasReservations(cow), true);
    await resetLibraryNonce(fixture.transactions, cow, fixture.chainId + 1n);
    assert.equal(fixture.sends.hasReservations(cow), true);
    await resetLibraryNonce(fixture.transactions, cow, fixture.chainId);
    assert.equal(fixture.sends.hasReservations(cow), false);
  });

  it("does not read the pending count at a reset with reservations and no hold", async () => {
    const fixture = await fixtureOnOwnChain();
    await libraryNonce(fixture.transactions, nonceRequest(fixture, true, true));
    const reads = fixture.reads.length;
    await resetLibraryNonce(fixture.transactions, cow, fixture.chainId);
    assert.equal(fixture.reads.length, reads);
  });

  it("ends no reservation at a reset when the pending count is not a hex quantity", async () => {
    for (const count of [7, "0xzz"]) {
      const fixture = await fixtureOnOwnChain();
      await libraryNonce(fixture.transactions, nonceRequest(fixture, true, true));
      await libraryNonce(fixture.transactions, nonceRequest(fixture, true, true));
      await libraryNonce(fixture.transactions, nonceRequest(fixture, true));
      fixture.answers.set("eth_getTransactionCount", () => count);
      // Of the two reservations, the reset ends one; the other stays, with the hold.
      await resetLibraryNonce(fixture.transactions, cow, fixture.chainId);
      assert.equal(fixture.sends.hasReservations(cow), true, String(count));
      await resetLibraryNonce(fixture.transactions, cow, fixture.chainId);
      await resetLibraryNonce(fixture.transactions, cow, fixture.chainId);
      assert.equal(libraryHoldOf(`${fixture.chainId}:${cow}`), undefined);
    }
  });

  it("does nothing at a reset with neither a hold nor a reservation", async () => {
    const fixture = await fixtureOnOwnChain();
    await resetLibraryNonce(fixture.transactions, cow, fixture.chainId);
    assert.equal(fixture.sends.hasReservations(cow), false);
  });

  it("reads the pending count at a reset with a hold and reservations, by its address", async () => {
    const fixture = await fixtureOnOwnChain();
    await libraryNonce(fixture.transactions, nonceRequest(fixture, true, true));
    await libraryNonce(fixture.transactions, nonceRequest(fixture, true));
    await resetLibraryNonce(fixture.transactions, cow, fixture.chainId);
    assert.deepEqual(fixture.reads.at(-1), {
      method: "eth_getTransactionCount",
      params: [cow, "pending"],
    });
    // The reservation took the reset; the hold stays until its own.
    await resetLibraryNonce(fixture.transactions, cow, fixture.chainId);
    assert.equal(libraryHoldOf(`${fixture.chainId}:${cow}`), undefined);
  });
});

describe("a raw transaction while a library send of another address holds a lock", () => {
  it("passes on from an address the connection has not looked up and that holds nothing", async () => {
    const fixture = await fixtureOnOwnChain();
    const zero = ZERO.toLowerCase();
    // zero's library send holds its lock; the connection has not looked up its KMS addresses.
    await libraryNonce(fixture.transactions, {
      address: zero,
      chainId: fixture.chainId,
      reserve: true,
      ownTransport: false,
    });
    accept(fixture);
    const raw = cowRaw(fixture.chainId, 4n);
    assert.equal(resultOf(await fixture.request("eth_sendRawTransaction", [raw])), hashOf(raw));
    assert.equal(fixture.sends.highWaterOf(cow), undefined, "nothing learned for cow");
    await resetLibraryNonce(fixture.transactions, zero, fixture.chainId);
  });
});
