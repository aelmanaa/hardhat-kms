import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ERRORS } from "../../../src/internal/error-catalog.ts";
import { catalogMessage } from "../../../src/internal/errors.ts";
import { debugLines } from "../../helpers/debug-lines.ts";
import { fakeAdapter } from "../../helpers/fake-adapter.ts";
import { fakeTxAdapter } from "../../helpers/fake-tx-adapter.ts";
import { EIP712_MAIL, HARDHAT_ACCOUNT_0 } from "../../helpers/vectors.ts";

// A logger reads DEBUG when it is created, and the signer modules create theirs when they load,
// so DEBUG is set before they are imported. Each test file runs in its own process.
process.env.DEBUG = "hardhat:kms:signer";
process.env.DEBUG_COLORS = "no";
const { KmsSigner } = await import("../../../src/internal/signer/kms-signer.ts");
const { SignerCache } = await import("../../../src/internal/signer/key-cache.ts");

const secretKey = new Uint8Array(Buffer.from(HARDHAT_ACCOUNT_0.secretKey, "hex"));
const baseOptions = {
  timeoutMs: 30_000,
  displayMessage: async () => {
    // Status lines are not under test here.
  },
};

let written: string[] = [];
let restore: (() => void) | undefined;

/** The signer's debug lines written so far, without the namespace and the time since the last. */
function lines(): string[] {
  return debugLines(written.join(""), "hardhat:kms:signer");
}

/** The milliseconds in a timing line, checked to be a plausible duration. */
function duration(line: string | undefined, pattern: RegExp): number {
  const match = line === undefined ? null : pattern.exec(line);
  assert.ok(match?.[1] !== undefined, `no timing in ${String(line)}`);
  const ms = Number(match[1]);
  assert.ok(ms >= 0 && ms < 60_000, `implausible duration ${match[1]} ms`);
  return ms;
}

describe("signer debug lines", () => {
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

  it("logs each provider call with its request id and duration, and the derived address", async () => {
    const kms = new KmsSigner(fakeAdapter({ secretKey }), baseOptions);

    await kms.getAddress();
    const [start, done, derived, ...rest] = lines();
    assert.match(
      start ?? "",
      /^fake-key-1: get public key \(request [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/,
    );
    duration(done, /^fake-key-1: get public key done in (\d+) ms$/);
    assert.equal(derived, `fake-key-1: public key derives to ${HARDHAT_ACCOUNT_0.address}`);
    assert.deepEqual(rest, []);
  });

  it("logs a failed provider call with its duration and error class", async () => {
    const kms = new KmsSigner(
      fakeAdapter({ secretKey, throwError: new RangeError("throttled") }),
      baseOptions,
    );

    await assert.rejects(kms.getAddress());
    const [, failed] = lines();
    duration(failed, /^fake-key-1: get public key failed after (\d+) ms \(RangeError\)$/);
  });

  it("logs the reason for asking for a fresh signature", async () => {
    const kms = new KmsSigner(fakeAdapter({ secretKey, wrongKeyForCalls: 1 }), baseOptions);
    await kms.getAddress();
    written = [];

    await kms.signDigest(new Uint8Array(32).fill(1));
    assert.ok(
      lines().includes(
        `fake-key-1: invalid signature (${catalogMessage(ERRORS.signatureNoRecovery, {})}), asking for a fresh one`,
      ),
      lines().join("\n"),
    );
  });

  it("names the adapter method each signature goes to", async () => {
    const kms = new KmsSigner(fakeTxAdapter({ secretKey }), baseOptions);
    await kms.getAddress();
    const transaction = { unsigned: Uint8Array.of(0xc0), type: 0, chainId: 1n, nonce: 0n };

    // Without signTransaction, a transaction goes to signDigest.
    const plain = new KmsSigner(fakeAdapter({ secretKey }), baseOptions);
    await plain.getAddress();
    const methods: string[] = [];
    for (const run of [
      async () => await kms.signTransaction(transaction),
      async () => await kms.signDigest(new Uint8Array(32).fill(1)),
      async () => await kms.signPersonalMessage(Uint8Array.of(1)),
      async () => await plain.signTransaction(transaction),
    ]) {
      written = [];
      await run();
      methods.push(lines()[0] ?? "");
    }
    assert.deepEqual(methods, [
      "fake-key-1: sign with signTransaction",
      "fake-key-1: sign with signDigest",
      "fake-key-1: sign with signMessage",
      "fake-key-1: sign with signDigest",
    ]);
  });

  it("names signTypedData for an adapter that signs typed data natively", async () => {
    const inner = fakeAdapter({ secretKey });
    const kms = new KmsSigner(
      {
        describe: () => inner.describe(),
        getPublicKey: async (ctx) =>
          await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing"))),
        signTypedData: async ({ digest }, ctx) =>
          await (inner.signDigest?.({ digest }, ctx) ?? Promise.reject(new Error("missing"))),
      },
      baseOptions,
    );
    await kms.getAddress();
    written = [];

    await kms.signTypedData(EIP712_MAIL);
    assert.equal(lines()[0], "fake-key-1: sign with signTypedData");
  });

  it("logs how many signers the cache closes", async () => {
    await new SignerCache().closeAll();

    assert.deepEqual(lines(), ["closing 0 signers"]);
  });
});
