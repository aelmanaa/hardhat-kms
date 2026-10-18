// A transaction the provider may still sign after the plugin gave up on it (#537), through the
// network hook: for an adapter with `signTransactionOutlivesAbort`, a send whose signature times
// out after the request was sent keeps its nonce held, and the next send takes the next nonce, a
// gap rather than two valid transactions at one nonce. A request that never left, and an adapter
// without the flag, release the nonce as before.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";
import type { NetworkConnection } from "hardhat/types/network";

import { outstandingNonce } from "../../../src/internal/signer/kms-signer.ts";
import {
  COW,
  gate,
  type Hang,
  hashOf,
  nonceOf,
  failOnce,
  PENDING_REQUEST_ID,
  refuse,
  resultOf,
  type SendHarness,
  settle,
  setUp,
  TO,
  withNonce,
} from "../../helpers/send-harness.ts";

const TIMEOUT_MS = 1000;
const COW_CHECKSUM = "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826";
const HTTP_CLIENT = { transport: { type: "http" } };

/** A chain id per test: the send locks are process-global, keyed by chain. */
let nextChainId = 53_700;

/** The tests whose global mocks are set. */
const mocked = new WeakSet<TestContext>();
/** Each test's mock of console.warn, to read the warnings. */
const warnings = new WeakMap<TestContext, { mock: { calls: { arguments: unknown[] }[] } }>();

/** The harness with the global setTimeout mocked, which the signer's timeout runs on. */
async function harnessFor(
  t: TestContext,
  type: "http" | "edr-simulated" = "http",
  outliving = true,
): Promise<{ harness: SendHarness; connection: NetworkConnection<string>; chainId: number }> {
  // Once per test: a test may set up several harnesses.
  if (!mocked.has(t)) {
    mocked.add(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    warnings.set(
      t,
      t.mock.method(console, "warn", () => undefined),
    );
  }
  const chainId = nextChainId++;
  const harness = await setUp(type, chainId, { outliving, timeoutMs: TIMEOUT_MS });
  // The node has every transaction it was sent, queued ones past a gap too.
  harness.node.lookUp = (hash) =>
    harness.node.raw.some((raw) => hashOf(raw) === hash) ? { hash } : null;
  const connection = await harness.open();
  return { harness, connection, chainId };
}

/** Makes the transaction with this value hang, sent or unsent, until the call times out. */
function hangOn(harness: SendHarness, value: bigint, hang: Hang): void {
  harness.state.hang = (transaction) => (transaction.value === value ? hang : undefined);
}

/** A transfer from cow with this value. */
const transfer = (value: number): Record<string, unknown> => ({
  from: COW,
  to: TO,
  value: `0x${value.toString(16)}`,
});

/** Runs `request`, lets it reach the KMS, passes the key's timeout, and returns its error. */
async function timedOut(t: TestContext, request: Promise<unknown>): Promise<unknown> {
  const outcome = request.then(
    () => assert.fail("the request succeeded"),
    (error: unknown) => error,
  );
  await settle();
  t.mock.timers.tick(TIMEOUT_MS);
  return await outcome;
}

/** Asserts the outstanding error for nonce `nonce`, with the hold sentence. */
function assertOutstanding(error: unknown, nonce: bigint): void {
  assert.ok(error instanceof HardhatPluginError, String(error));
  assert.equal(outstandingNonce(error), nonce);
  assert.ok(error.message.includes(`request ${PENDING_REQUEST_ID}`), error.message);
  assert.ok(
    error.message.includes(`send a replacement transaction with nonce ${nonce}`),
    error.message,
  );
  assert.ok(error.message.includes(`skip nonce ${nonce}`), error.message);
}

describe("a send whose signature the provider may still complete (#537)", () => {
  for (const type of ["http", "edr-simulated"] as const) {
    it(`keeps the nonce held after a timeout once the request was sent, on ${type}`, async (t) => {
      const { harness, connection } = await harnessFor(t, type);
      hangOn(harness, 1n, "sent");

      assertOutstanding(await timedOut(t, harness.send(connection, transfer(1))), 0n);
      assert.deepEqual(harness.node.raw, [], "nothing was broadcast");

      // The node's pending count stays at the gap: the next sends go past it.
      resultOf(await harness.send(connection, transfer(2)));
      resultOf(await harness.send(connection, transfer(3)));
      assert.deepEqual(harness.node.raw.map(nonceOf), [1n, 2n]);
    });
  }

  it("keeps the nonce held when the adapter fails after sending, and releases it after a refusal", async (t) => {
    const { harness, connection } = await harnessFor(t);
    harness.state.hang = (transaction) =>
      transaction.value === 1n ? "fails" : transaction.value === 3n ? "refused" : undefined;

    const held = await harness.send(connection, transfer(1)).then(
      () => assert.fail("the send succeeded"),
      (error: unknown) => error,
    );
    assertOutstanding(held, 0n);
    assert.ok(String(held).includes(": the provider call failed (Error). The request reached"));
    resultOf(await harness.send(connection, transfer(2)));

    const refused = await harness.send(connection, transfer(3)).then(
      () => assert.fail("the send succeeded"),
      (error: unknown) => error,
    );
    assert.equal(outstandingNonce(refused), undefined, String(refused));
    harness.node.pending = 2n;
    resultOf(await harness.send(connection, transfer(4)));
    assert.deepEqual(harness.node.raw.map(nonceOf), [1n, 2n]);
  });

  it("on edr-simulated, keeps the nonce held after a replacement the node then drops", async (t) => {
    const { harness, connection } = await harnessFor(t, "edr-simulated");
    hangOn(harness, 1n, "sent");
    assertOutstanding(await timedOut(t, harness.send(connection, transfer(1))), 0n);
    harness.state.hang = undefined;
    // The caller's replacement at nonce 0 reaches the node, which drops it again.
    resultOf(await harness.send(connection, { ...withNonce(0), value: "0x2" }));
    harness.node.raw.length = 0;
    resultOf(await harness.send(connection, transfer(3)));
    assert.deepEqual(harness.node.raw.map(nonceOf), [1n], "the never-broadcast copy still holds 0");
    // A pending count past 0 is not enough: the node could drop that pool transaction again.
    harness.node.pending = 2n;
    const tags: unknown[] = [];
    harness.node.count = (tag) => {
      tags.push(tag);
      return tag === "latest" ? "0x0" : `0x${harness.node.pending.toString(16)}`;
    };
    resultOf(await harness.send(connection, transfer(4)));
    assert.ok(tags.includes("latest"), "the mined count is read while a nonce is held");
    // Once a transaction at nonce 0 is mined, the hold ends, and the count is no longer read.
    harness.node.count = (tag) => {
      tags.push(tag);
      return tag === "latest" ? "0x1" : `0x${harness.node.pending.toString(16)}`;
    };
    harness.node.pending = 3n;
    resultOf(await harness.send(connection, transfer(5)));
    harness.node.pending = 4n;
    tags.length = 0;
    resultOf(await harness.send(connection, transfer(6)));
    assert.ok(!tags.includes("latest"), JSON.stringify(tags));
    assert.deepEqual(harness.node.raw.map(nonceOf), [1n, 2n, 3n, 4n]);
  });

  it("releases the nonce when the request never left", async (t) => {
    const { harness, connection } = await harnessFor(t);
    hangOn(harness, 1n, "unsent");

    const error = await timedOut(t, harness.send(connection, transfer(1)));

    assert.equal(outstandingNonce(error), undefined, String(error));
    assert.match(String(error), /no answer within 1000 ms$/);
    resultOf(await harness.send(connection, transfer(2)));
    assert.deepEqual(harness.node.raw.map(nonceOf), [0n]);
  });

  it("releases the nonce for an adapter without the flag, as the cloud providers' adapters are", async (t) => {
    const { harness, connection } = await harnessFor(t, "http", false);
    let first = true;
    harness.state.beforeSign = async () => {
      if (first) {
        first = false;
        await new Promise(() => undefined);
      }
    };

    const error = await timedOut(t, harness.send(connection, transfer(1)));

    assert.equal(outstandingNonce(error), undefined, String(error));
    resultOf(await harness.send(connection, transfer(2)));
    assert.deepEqual(harness.node.raw.map(nonceOf), [0n]);
  });

  it("holds the nonce of a caller's nonce too, and a replacement at it ends the hold", async (t) => {
    const { harness, connection } = await harnessFor(t);
    hangOn(harness, 0n, "sent");

    assertOutstanding(await timedOut(t, harness.send(connection, withNonce(0))), 0n);
    harness.state.hang = undefined;
    resultOf(await harness.send(connection, transfer(1)));
    // The replacement the error asks for: the caller's nonce 0, which the node accepts.
    resultOf(await harness.send(connection, withNonce(0)));
    harness.node.pending = 2n;
    resultOf(await harness.send(connection, transfer(2)));
    assert.deepEqual(harness.node.raw.map(nonceOf), [1n, 0n, 2n]);
  });

  it("holds the nonce of eth_signTransaction, whose caller never sees the transaction", async (t) => {
    const { harness, connection } = await harnessFor(t);
    hangOn(harness, 1n, "sent");

    assertOutstanding(
      await timedOut(t, harness.request(connection, "eth_signTransaction", transfer(1))),
      0n,
    );
    resultOf(await harness.send(connection, transfer(2)));
    assert.deepEqual(harness.node.raw.map(nonceOf), [1n]);
  });

  it("lets a second eth_signTransaction skip the nonce the first one left held", async (t) => {
    const { harness, connection } = await harnessFor(t);
    hangOn(harness, 1n, "sent");
    assertOutstanding(
      await timedOut(t, harness.request(connection, "eth_signTransaction", transfer(1))),
      0n,
    );
    harness.state.hang = undefined;

    const second = resultOf(await harness.request(connection, "eth_signTransaction", transfer(2)));
    assert.ok(typeof second === "string");
    assert.equal(nonceOf(second), 1n);
    // A caller's nonce is the caller's choice, as for a send: the replacement at the held nonce.
    const replacement = resultOf(
      await harness.request(connection, "eth_signTransaction", { ...transfer(3), nonce: "0x0" }),
    );
    assert.ok(typeof replacement === "string");
    assert.equal(nonceOf(replacement), 0n);
  });

  it("keeps the nonce of a completed eth_signTransaction held: the provider keeps a copy", async (t) => {
    const { harness, connection } = await harnessFor(t);
    const signed = resultOf(await harness.request(connection, "eth_signTransaction", transfer(1)));
    assert.ok(typeof signed === "string");
    assert.equal(nonceOf(signed), 0n);
    resultOf(await harness.send(connection, transfer(2)));
    // Broadcast through the connection, the copy reaches the node: the hold ends there.
    resultOf((await harness.call(connection, "eth_sendRawTransaction", [signed])).response);
    harness.node.pending = 2n;
    resultOf(await harness.send(connection, transfer(3)));
    assert.deepEqual(harness.node.raw.map(nonceOf), [1n, 0n, 2n]);
  });

  it("keeps the nonce held when the node refuses a send the provider keeps a copy of", async (t) => {
    const { harness, connection } = await harnessFor(t);
    refuse(harness.node, "insufficient funds for gas * price + value");

    const error = await harness.send(connection, transfer(1)).then(
      () => assert.fail("the send succeeded"),
      (thrown: unknown) => thrown,
    );

    assert.ok(error instanceof HardhatPluginError, String(error));
    assert.equal(
      error.message,
      `eth_sendTransaction: the node refused the transaction with nonce 0 (insufficient funds, code -32000), but the provider keeps it signed (request ${PENDING_REQUEST_ID}), and anyone who can read it there can broadcast it once the node would take it. This connection's sends from the account skip nonce 0 until a transaction with it reaches the node through the connection. Fix the cause, such as the account's funds or the fees, then send a replacement transaction with nonce 0, or broadcast that signed transaction`,
    );
    harness.node.onRaw = undefined;
    resultOf(await harness.send(connection, transfer(2)));
    assert.deepEqual(harness.node.raw.map(nonceOf), [0n, 1n]);
  });

  it("names the kind and code of a refusal, never the node's text", async (t) => {
    for (const [message, code, kind] of [
      ["replacement transaction underpriced: planted", -32000, "fee too low"],
      ["transaction underpriced", -32000, "fee too low"],
      ["max fee per gas less than block base fee: planted", -32003, "fee too low"],
      ["max fee per gas less than base fee", -32003, "refused"],
      ["tx fee (1.00 ether) exceeds the configured cap (planted)", -32000, "refused"],
      ["exceeds block gas limit, planted", 3, "refused"],
    ] as const) {
      const { harness, connection } = await harnessFor(t);
      refuse(harness.node, message, code);
      const error = await harness.send(connection, transfer(1)).then(
        () => assert.fail("the send succeeded"),
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof HardhatPluginError, String(error));
      assert.ok(error.message.includes(`with nonce 0 (${kind}, code ${code}), but`), error.message);
      assert.ok(!error.message.includes("planted"), error.message);
    }
  });

  it("passes a refusal on when the node has mined past the nonce, whatever its message", async (t) => {
    for (const message of ["nonce too low", "OldNonce", "transaction already imported"]) {
      const { harness, connection } = await harnessFor(t);
      const tags: unknown[] = [];
      harness.node.count = (tag) => {
        tags.push(tag);
        // Another transaction at nonce 0 was mined, but the pool still counts as pending 0.
        return tag === "latest" ? "0x1" : `0x${harness.node.pending.toString(16)}`;
      };
      refuse(harness.node, message);
      const response = await harness.send(connection, transfer(1)).catch((error: unknown) => error);
      assert.ok(!(response instanceof HardhatPluginError), String(response));
      assert.ok(tags.includes("latest"), JSON.stringify(tags));
      // The hold below the mined count ended: the next send reads no mined count.
      harness.node.onRaw = undefined;
      harness.node.pending = 1n;
      tags.length = 0;
      resultOf(await harness.send(connection, transfer(2)));
      assert.ok(!tags.includes("latest"), JSON.stringify(tags));
    }
  });

  it("keeps the hold when the mined count fails or is not a string", async (t) => {
    for (const count of [() => 1, () => assert.fail("no count")]) {
      const { harness, connection } = await harnessFor(t);
      harness.node.count = (tag) => (tag === "latest" ? count() : "0x0");
      refuse(harness.node, "nonce too low");
      await assert.rejects(harness.send(connection, transfer(1)), /\(refused, code -32000\)/);
    }
  });

  it("keeps the hold of a refused copy while the node has not mined past its nonce", async (t) => {
    const { harness, connection } = await harnessFor(t);
    refuse(harness.node, "nonce too low");
    await assert.rejects(harness.send(connection, transfer(1)), /\(refused, code -32000\)/);
    harness.node.onRaw = undefined;
    resultOf(await harness.send(connection, transfer(2)));
    assert.deepEqual(harness.node.raw.map(nonceOf), [0n, 1n]);
  });

  it("on edr-simulated, ends the hold of a library copy that reached the node itself", async (t) => {
    const { harness, connection, chainId } = await harnessFor(t, "edr-simulated");
    const account = await connection.kms.getAccount(COW);
    const raw = await account.signTransaction({
      type: "eip1559",
      chainId,
      nonce: 0,
      gas: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      to: TO,
      value: 7n,
    });
    resultOf((await harness.call(connection, "eth_sendRawTransaction", [raw])).response);
    // The node drops it again: the copy was public, so a send may take nonce 0 (#537).
    harness.node.raw.length = 0;
    harness.node.lookUp = () => null;
    resultOf(await harness.send(connection, transfer(2)));
    assert.deepEqual(harness.node.raw.map(nonceOf), [0n]);
  });

  it("counts an answer that the node already knows the transaction as sent", async (t) => {
    for (const message of ["already known", "known transaction: 0xab"]) {
      const { harness, connection } = await harnessFor(t);
      refuse(harness.node, message);
      assert.equal(
        resultOf(await harness.send(connection, transfer(1))),
        hashOf(harness.node.raw[0] ?? ""),
      );
      harness.node.onRaw = undefined;
      resultOf(await harness.send(connection, transfer(2)));
      assert.deepEqual(harness.node.raw.map(nonceOf), [0n, 1n]);
    }
  });

  it("keeps the nonce of a library account's completed transaction held", async (t) => {
    const { harness, connection, chainId } = await harnessFor(t);
    const account = await connection.kms.getAccount(COW);
    await account.signTransaction({
      type: "eip1559",
      chainId,
      nonce: 0,
      gas: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      to: TO,
      value: 7n,
    });
    resultOf(await harness.send(connection, transfer(2)));
    assert.deepEqual(harness.node.raw.map(nonceOf), [1n]);
  });

  it("passes a refusal on and releases the nonce for an adapter without the flag", async (t) => {
    const { harness, connection } = await harnessFor(t, "http", false);
    refuse(harness.node, "insufficient funds");
    const response = await harness.send(connection, transfer(1)).catch((error: unknown) => error);
    assert.ok(!(response instanceof HardhatPluginError), String(response));
    harness.node.onRaw = undefined;
    resultOf(await harness.send(connection, transfer(2)));
    assert.deepEqual(harness.node.raw.map(nonceOf), [0n, 0n]);
  });

  it("warns when held nonces put a send, not an eth_signTransaction, above the pending count", async (t) => {
    const { harness, connection } = await harnessFor(t);
    for (const value of [1, 2]) {
      resultOf(await harness.request(connection, "eth_signTransaction", transfer(value)));
    }
    const calls = (): { arguments: unknown[] }[] => warnings.get(t)?.mock.calls ?? [];
    assert.equal(calls().length, 0, "signatures alone do not warn");
    resultOf(await harness.send(connection, transfer(3)));
    assert.equal(calls().length, 1);
    assert.deepEqual(harness.node.raw.map(nonceOf), [2n]);
    const last = String(calls().at(-1)?.arguments[0]);
    assert.ok(
      last.includes(
        `the send from ${COW_CHECKSUM} takes nonce 2, above nonce 0, 1, which this connection holds because the provider may sign, or keeps signed, a transaction at each. The node cannot mine this send until transactions with nonce 0, 1 are:`,
      ),
      last,
    );
    assert.ok(last.includes("send replacements with those nonces"), last);
    assert.ok(
      last.endsWith(
        "See https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/turnkey-setup.md#when-turnkey-does-not-answer-in-time.",
      ),
      last,
    );
    // No warning when nothing held is skipped.
    const before = calls().length;
    harness.node.pending = 3n;
    resultOf(await harness.send(connection, transfer(4)));
    assert.equal(calls().length, before);
  });

  it("looks up unanswered sends before eth_signTransaction chooses its nonce, not with a caller's nonce", async (t) => {
    const { harness, connection } = await harnessFor(t);
    failOnce(harness.node);
    await harness.send(connection, transfer(1)).catch(() => undefined);
    // The node has the unanswered send at 0, and its pending count lags at 0.
    harness.node.methods.length = 0;
    const callerNonce = resultOf(
      await harness.request(connection, "eth_signTransaction", { ...transfer(2), nonce: "0x7" }),
    );
    assert.equal(nonceOf(String(callerNonce)), 7n);
    assert.ok(!harness.node.methods.includes("eth_getTransactionByHash"));
    const signed = resultOf(await harness.request(connection, "eth_signTransaction", transfer(3)));
    assert.ok(harness.node.methods.includes("eth_getTransactionByHash"));
    // Past the unanswered send, which the lookup found, and the held nonce 7 of the first.
    assert.equal(nonceOf(String(signed)), 8n);
  });

  it("does not warn about a held nonce above the one a send takes after a fall", async (t) => {
    const { harness, connection } = await harnessFor(t, "edr-simulated");
    harness.state.hang = (transaction) => (transaction.value === 9n ? "fails" : undefined);
    await harness.send(connection, { ...transfer(9), nonce: "0x5" }).catch(() => undefined);
    resultOf(await harness.send(connection, transfer(1)));
    // The node lost the send at 0: its pending count stays 0, and it no longer has it.
    harness.node.lookUp = () => null;
    const before = warnings.get(t)?.mock.calls.length ?? 0;
    resultOf(await harness.send(connection, transfer(2)));
    assert.equal(nonceOf(harness.node.raw.at(-1) ?? ""), 0n);
    assert.equal(warnings.get(t)?.mock.calls.length ?? 0, before);
  });

  it("signs eth_signTransaction under the send lock, after a send that is signing (#537)", async (t) => {
    const { harness, connection } = await harnessFor(t);
    const signing = gate();
    let first = true;
    harness.state.beforeSign = async () => {
      if (first) {
        first = false;
        await signing.promise;
      }
    };
    const sending = harness.send(connection, transfer(1));
    await settle();
    const signOnly = harness.request(connection, "eth_signTransaction", transfer(2));
    await settle();
    assert.equal(harness.state.signatures, 1, "eth_signTransaction waits for the lock");
    signing.open();
    resultOf(await sending);
    const raw = resultOf(await signOnly);
    assert.ok(typeof raw === "string");
    assert.deepEqual([...harness.node.raw.map(nonceOf), nonceOf(raw)], [0n, 1n]);
  });

  it("signs parallel eth_signTransaction calls of a key without the flag in parallel, all at one nonce", async (t) => {
    const { harness, connection } = await harnessFor(t, "http", false);
    let active = 0;
    let most = 0;
    harness.state.beforeSign = async () => {
      active++;
      most = Math.max(most, active);
      await settle();
      active--;
    };
    const signed = await Promise.all(
      Array.from({ length: 20 }, async (_, value) =>
        String(resultOf(await harness.request(connection, "eth_signTransaction", transfer(value)))),
      ),
    );
    assert.ok(most > 1, `the signatures overlapped: at most ${most} at once`);
    assert.deepEqual(new Set(signed.map(nonceOf)), new Set([0n]), "no lock and no hold");
  });

  it("gives two parallel eth_signTransaction calls distinct nonces (#537)", async (t) => {
    const { harness, connection } = await harnessFor(t);
    const signed = await Promise.all([
      harness.request(connection, "eth_signTransaction", transfer(1)),
      harness.request(connection, "eth_signTransaction", transfer(2)),
    ]);
    assert.deepEqual(
      signed.map((answer) => nonceOf(String(resultOf(answer)))),
      [0n, 1n],
    );
  });

  it("keeps ten parallel sends on distinct nonces, and none on the nonce of the one that hangs", async (t) => {
    const { harness, connection } = await harnessFor(t);
    hangOn(harness, 3n, "sent");

    const outcomes = Array.from({ length: 10 }, async (_, value) => {
      try {
        return resultOf(await harness.send(connection, transfer(value)));
      } catch (error) {
        return error;
      }
    });
    // Sends 0 to 2 go out, send 3 waits for its signature, the rest wait for the lock.
    while (harness.state.signatures < 3 || harness.node.raw.length < 3) {
      await settle();
    }
    await settle();
    t.mock.timers.tick(TIMEOUT_MS);
    const results = await Promise.all(outcomes);

    assertOutstanding(results[3], 3n);
    assert.equal(results.filter((result) => result instanceof Error).length, 1);
    assert.deepEqual(harness.node.raw.map(nonceOf), [0n, 1n, 2n, 4n, 5n, 6n, 7n, 8n, 9n]);
  });

  it("keeps the nonce on its own connection only", async (t) => {
    const { harness, connection } = await harnessFor(t);
    const other = await harness.open();
    hangOn(harness, 1n, "sent");

    assertOutstanding(await timedOut(t, harness.send(connection, transfer(1))), 0n);
    resultOf(await harness.send(other, transfer(2)));
    assert.deepEqual(harness.node.raw.map(nonceOf), [0n]);
  });

  it("forgets the hold when its connection closes", async (t) => {
    const { harness, connection } = await harnessFor(t);
    hangOn(harness, 1n, "sent");
    assertOutstanding(await timedOut(t, harness.send(connection, transfer(1))), 0n);
    await harness.close(connection);
    const reopened = await harness.open();
    resultOf(await harness.send(reopened, transfer(2)));
    assert.deepEqual(harness.node.raw.map(nonceOf), [0n]);
  });
});

/** A library account of cow, its nonce manager and a transfer it signs. */
async function library(connection: NetworkConnection<string>, chainId: number, client: unknown) {
  const account = await connection.kms.getAccount(COW);
  const parameters = { address: account.address, chainId, client };
  return {
    consume: async (): Promise<bigint> => BigInt(await account.nonceManager.consume(parameters)),
    reset: async (): Promise<void> => {
      account.nonceManager.reset(parameters);
      await settle();
    },
    sign: async (nonce: bigint, value: bigint): Promise<string> =>
      await account.signTransaction({
        type: "eip1559",
        chainId,
        nonce: Number(nonce),
        gas: 21_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        to: TO,
        value,
      }),
  };
}

describe("a library account's transaction the provider may still complete (#537)", () => {
  for (const [name, client] of [
    ["through the connection", {}],
    ["with its own transport", HTTP_CLIENT],
  ] as const) {
    it(`keeps the nonce held through viem's reset, ${name}`, async (t) => {
      const { harness, connection, chainId } = await harnessFor(t);
      const account = await library(connection, chainId, client);
      hangOn(harness, 7n, "sent");

      const nonce = await account.consume();
      assert.equal(nonce, 0n);
      assertOutstanding(await timedOut(t, account.sign(nonce, 7n)), 0n);
      // viem resets after the failed send, which ends its hold or reservation.
      await account.reset();

      resultOf(await harness.send(connection, transfer(2)));
      assert.deepEqual(harness.node.raw.map(nonceOf), [1n]);
    });

    it(`releases the nonce at viem's reset when the request never left, ${name}`, async (t) => {
      const { harness, connection, chainId } = await harnessFor(t);
      const account = await library(connection, chainId, client);
      hangOn(harness, 7n, "unsent");

      const nonce = await account.consume();
      const error = await timedOut(t, account.sign(nonce, 7n));
      assert.equal(outstandingNonce(error), undefined, String(error));
      await account.reset();

      resultOf(await harness.send(connection, transfer(2)));
      assert.deepEqual(harness.node.raw.map(nonceOf), [0n]);
    });
  }
});
