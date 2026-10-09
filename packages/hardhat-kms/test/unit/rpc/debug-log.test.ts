// The dispatcher's debug lines, under DEBUG=hardhat:kms:rpc.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { HardhatError } from "@nomicfoundation/hardhat-errors";
import type { JsonRpcRequest } from "hardhat/types/providers";
import { Transaction } from "micro-eth-signer";

import { COW_ACCOUNT } from "../../helpers/vectors.ts";

// A logger reads DEBUG when it is created, and the dispatcher creates its logger when it loads,
// so DEBUG is set before the fixture imports it. Each test file runs in its own process.
process.env.DEBUG = "hardhat:kms:rpc";
process.env.DEBUG_COLORS = "no";
const { COW, dispatchFixture, ErrorAnswer, OTHER, ZERO } =
  await import("../../helpers/dispatch-fixture.ts");
const { libraryNonce, resetLibraryNonce } = await import("../../../src/internal/rpc/dispatcher.ts");
const { MAX_SEND_LOCK_WAITERS, withSendLock } =
  await import("../../../src/internal/rpc/send-guard.ts");
const { gate } = await import("../../helpers/send-harness.ts");

const cow = COW.toLowerCase();
let nextChainId = 90_000n;

let written: string[] = [];
let restore: (() => void) | undefined;

/** The debug lines written so far, without the namespace and the time since the last. */
function lines(): string[] {
  const all = written
    .join("")
    .split("\n")
    .flatMap((line) => {
      const match = /hardhat:kms:rpc (.*?)(?: \+\d+\w+)?$/.exec(line);
      return match?.[1] === undefined ? [] : [match[1]];
    });
  written = [];
  return all;
}

const hashOf = (raw: string): string =>
  `0x${Buffer.from(keccak_256(Buffer.from(raw.slice(2), "hex"))).toString("hex")}`;
const rawOf = (request: JsonRpcRequest): string => {
  const [raw]: unknown[] = Array.isArray(request.params) ? request.params : [];
  assert.ok(typeof raw === "string");
  return raw;
};

/** A fixture on a chain of its own, with its KMS addresses looked up and its lines cleared. */
async function knownFixture() {
  nextChainId++;
  const fixture = await dispatchFixture({ chainId: nextChainId });
  await fixture.accounts.addresses();
  lines();
  return fixture;
}

/** A transfer signed by cow outside the plugin. */
function cowRaw(chainId: bigint, nonce: bigint): string {
  return Transaction.prepare(
    {
      to: ZERO,
      nonce,
      chainId,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      gasLimit: 21_000n,
      value: 1n,
    },
    false,
  )
    .signBy(new Uint8Array(Buffer.from(COW_ACCOUNT.secretKey, "hex")), false)
    .toHex(true);
}

describe("rpc debug lines", () => {
  beforeEach(() => {
    written = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    restore = () => {
      process.stderr.write = original;
    };
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("logs the accounts, a failed account list and a refused wallet send", async () => {
    const fixture = await dispatchFixture();
    fixture.answers.set("eth_accounts", () => {
      throw new TypeError("no accounts at https://secret.example");
    });
    await fixture.request("eth_accounts");
    await fixture.request("wallet_sendTransaction", [{ from: COW, to: ZERO }]);
    assert.deepEqual(lines(), [
      "eth_accounts failed downstream (TypeError); listing the KMS accounts only",
      "accounts: myvault:cow, myvault:zero",
      `refused wallet_sendTransaction from KMS account ${COW}`,
    ]);
  });

  it("logs nothing for an account list that is an error answer or not a list", async () => {
    const fixture = await dispatchFixture();
    await fixture.accounts.addresses();
    lines();
    fixture.answers.set("eth_accounts", () => new ErrorAnswer(-32601, "no accounts"));
    await fixture.request("eth_accounts");
    fixture.answers.set("eth_accounts", () => ({ accounts: [] }));
    await fixture.request("eth_accounts");
    assert.deepEqual(lines(), []);
  });

  it("logs a raw transaction that passes on because too many requests wait for the lock", async () => {
    const fixture = await knownFixture();
    const key = `${fixture.chainId}:${cow}`;
    const held = gate();
    const holding = withSendLock(key, async () => await held.promise);
    const waiters = Array.from(
      { length: MAX_SEND_LOCK_WAITERS },
      async () => await withSendLock(key, async () => {}),
    );
    fixture.answers.set("eth_sendRawTransaction", () => "0xhash");
    await fixture.request("eth_sendRawTransaction", [cowRaw(fixture.chainId, 0n)]);
    held.open();
    await holding;
    await Promise.all(waiters);
    const logged = lines();
    assert.equal(logged.length, 1, logged.join("\n"));
    assert.match(
      logged[0] ?? "",
      /^eth_sendRawTransaction: the send lock could not be had \(\w+\); passed on$/,
    );
  });

  it("logs an unknown-account error it cannot add the KMS accounts to", async () => {
    const failing = await dispatchFixture({ failLookups: 10 });
    const unknown = Object.assign(new Error(`Unknown account ${OTHER}`), { code: -32000 });
    failing.answers.set("eth_sign", () => {
      throw unknown;
    });
    await failing.request("eth_sign", ["not an address", "0x00"]).catch(() => undefined);
    const fixture = await dispatchFixture();
    const frozen = Object.assign(new Error(`Unknown account ${OTHER}`), { code: -32000 });
    Object.freeze(frozen);
    fixture.answers.set("eth_sign", () => {
      throw frozen;
    });
    await fixture.request("eth_sign", [OTHER, "0x00"]).catch(() => undefined);
    assert.deepEqual(lines(), [
      "listing the KMS accounts for an unknown account failed (HardhatPluginError)",
      "accounts: myvault:cow, myvault:zero",
      "could not add the KMS accounts to the error (TypeError)",
    ]);
  });

  it("logs a send without an answer, its retry, and the lookups", async () => {
    const fixture = await knownFixture();
    const sent: string[] = [];
    fixture.answers.set("eth_sendRawTransaction", (request) => {
      sent.push(rawOf(request));
      if (sent.length === 1) {
        throw new TypeError("socket hang up");
      }
      return hashOf(rawOf(request));
    });
    const tx = { from: COW, to: ZERO };
    await fixture.request("eth_sendTransaction", [tx]).catch(() => undefined);
    await fixture.request("eth_sendTransaction", [tx]);
    const [first] = sent;
    assert.ok(first !== undefined);
    const hash = hashOf(first);
    // A later send looks up the first one, which is uncertain again after a failed lookup.
    fixture.answers.set("eth_getTransactionByHash", () => {
      throw new RangeError("lookup failed");
    });
    fixture.sends.rememberUncertain(cow, { raw: first, hash, nonce: 0n });
    await fixture.request("eth_sendTransaction", [{ ...tx, value: "0x1" }]);
    assert.deepEqual(lines(), [
      `sending transaction ${hash} got no answer (TypeError)`,
      `sending transaction ${hash} again for a retried request`,
      `looking up transaction ${hash} failed (RangeError)`,
      `transaction ${hash} is not known to the node`,
    ]);
  });

  it("logs a retry whose nonce a later send used", async () => {
    const fixture = await knownFixture();
    const sent: string[] = [];
    fixture.answers.set("eth_sendRawTransaction", (request) => {
      sent.push(rawOf(request));
      if (sent.length === 1) {
        throw new TypeError("socket hang up");
      }
      return hashOf(rawOf(request));
    });
    const tx = { from: COW, to: ZERO };
    await fixture.request("eth_sendTransaction", [tx]).catch(() => undefined);
    await fixture.request("eth_sendTransaction", [{ ...tx, value: "0x1", nonce: "0x0" }]);
    fixture.answers.set("eth_getTransactionByHash", () => ({}));
    await fixture.request("eth_sendTransaction", [tx]);
    const [first] = sent;
    assert.ok(first !== undefined);
    const hash = hashOf(first);
    fixture.answers.set("eth_getTransactionByHash", () => null);
    fixture.sends.rememberFailure(
      `${fixture.chainId}\0${cow}\0[{"from":"${COW}","to":"${ZERO}"}]`,
      {
        raw: first,
        hash,
        nonce: 0n,
      },
    );
    lines();
    await fixture.request("eth_sendTransaction", [tx]);
    const logged = lines();
    assert.deepEqual(logged.slice(0, 2), [
      `transaction ${hash} is not known to the node`,
      `transaction ${hash} is unknown and its nonce was used since; signing again`,
    ]);
  });

  it("logs a refused connection, an uncertain answer and the lookup that finds it", async () => {
    const fixture = await knownFixture();
    const hashes: string[] = [];
    fixture.answers.set("eth_sendRawTransaction", (request) => {
      hashes.push(hashOf(rawOf(request)));
      if (hashes.length === 1) {
        throw new HardhatError(HardhatError.ERRORS.CORE.NETWORK.CONNECTION_REFUSED, {
          network: "remote",
        });
      }
      return new ErrorAnswer(-32603, "internal error");
    });
    const tx = { from: COW, to: ZERO };
    await fixture.request("eth_sendTransaction", [tx]).catch(() => undefined);
    await fixture.request("eth_sendTransaction", [{ ...tx, value: "0x1" }]);
    fixture.answers.set("eth_getTransactionByHash", () => ({}));
    fixture.answers.set("eth_sendRawTransaction", (request) => hashOf(rawOf(request)));
    await fixture.request("eth_sendTransaction", [{ ...tx, value: "0x2" }]);
    const [refused, uncertain] = hashes;
    assert.deepEqual(lines(), [
      `sending transaction ${refused}: the node refused the connection`,
      `sending transaction ${uncertain}: the node does not know the outcome (-32603)`,
      `transaction ${uncertain} is known to the node`,
    ]);
  });

  it("logs raw transactions it passes on or gets no answer for", async () => {
    const fixture = await knownFixture();
    await fixture.request("eth_sendRawTransaction", [5]).catch(() => undefined);
    fixture.answers.set("eth_sendRawTransaction", () => "0xhash");
    await fixture.request("eth_sendRawTransaction", ["0x1234"]);
    fixture.chainIdFails = true;
    await fixture.request("eth_sendRawTransaction", [cowRaw(fixture.chainId, 0n)]);
    fixture.chainIdFails = false;
    await fixture.request("eth_sendRawTransaction", [cowRaw(fixture.chainId + 1n, 0n)]);
    fixture.answers.set("eth_sendRawTransaction", () => {
      throw new TypeError("socket hang up");
    });
    const raw = cowRaw(fixture.chainId, 1n);
    await fixture.request("eth_sendRawTransaction", [raw]).catch(() => undefined);
    const logged = lines();
    assert.equal(logged.length, 4, logged.join("\n"));
    assert.match(
      logged[0] ?? "",
      /^eth_sendRawTransaction: the plugin cannot decode it \(\w+\); passed on$/,
    );
    assert.deepEqual(logged.slice(1), [
      "eth_sendRawTransaction: the chain id is unknown (Error); passed on",
      `eth_sendRawTransaction: signed for chain ${fixture.chainId + 1n}n, not this connection's; passed on`,
      `raw transaction ${hashOf(raw)} got no answer (TypeError)`,
    ]);
  });

  it("does not decode a raw transaction before the KMS addresses are looked up, when nothing is held", async () => {
    nextChainId++;
    const fixture = await dispatchFixture({ chainId: nextChainId });
    lines();
    fixture.answers.set("eth_sendRawTransaction", () => "0xhash");
    await fixture.request("eth_sendRawTransaction", ["0x1234"]);
    assert.deepEqual(lines(), [], "no line says it could not be decoded");
    assert.equal(fixture.forwarded.length, 1);
  });

  it("logs nothing for a raw transaction request whose params are not a list", async () => {
    const fixture = await knownFixture();
    fixture.answers.set("eth_sendRawTransaction", () => "0xhash");
    await fixture.request("eth_sendRawTransaction", { 0: cowRaw(fixture.chainId, 0n) });
    await fixture.request("eth_sendRawTransaction");
    assert.deepEqual(lines(), []);
    assert.equal(fixture.forwarded.length, 2);
  });

  it("logs the type of an uncertain answer's code that is not a number", async () => {
    const fixture = await knownFixture();
    const answer = new ErrorAnswer(-32000, "request timed out");
    Object.assign(answer.error, { code: "late" });
    const hashes: string[] = [];
    fixture.answers.set("eth_sendRawTransaction", (request) => {
      hashes.push(hashOf(rawOf(request)));
      return answer;
    });
    await fixture.request("eth_sendTransaction", [{ from: COW, to: ZERO }]);
    assert.deepEqual(lines(), [
      `sending transaction ${hashes[0]}: the node does not know the outcome (string)`,
    ]);
  });

  it("logs the nonces it gives library accounts", async () => {
    nextChainId++;
    const fixture = await dispatchFixture({ chainId: nextChainId });
    const request = (ownTransport: boolean) => ({
      address: cow,
      chainId: fixture.chainId,
      reserve: true,
      ownTransport,
    });
    await libraryNonce(fixture.transactions, request(true));
    await libraryNonce(fixture.transactions, request(false));
    await resetLibraryNonce(fixture.transactions, cow, fixture.chainId);
    await resetLibraryNonce(fixture.transactions, cow, fixture.chainId);
    assert.deepEqual(lines(), [
      `${cow}: nonce 0n reserved for a library account's own transport`,
      `${cow}: nonce 1n given to a library account's send, which holds the lock`,
    ]);
  });
});
