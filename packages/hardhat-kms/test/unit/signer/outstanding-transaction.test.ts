// A transaction signature the provider may still complete after the plugin gave up on it (#537):
// for an adapter with `signTransactionOutlivesAbort`, a `signTransaction` that times out or is
// cancelled after `ctx.requestSent` fails with `core.signer.transaction-outstanding`, whose nonce
// (`outstandingNonce`) the caller must keep held. Any other failure, and every other adapter, fails as before.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import { InvalidSignatureError } from "../../../src/internal/crypto/signature.ts";
import { ERRORS } from "../../../src/internal/error-catalog.ts";
import { catalogError, catalogMessage } from "../../../src/internal/errors.ts";
import type { TransactionFiller } from "../../../src/internal/rpc/transaction-filler.ts";
import { signTransaction } from "../../../src/internal/rpc/transactions.ts";
import {
  KmsSigner,
  outstandingNonce,
  providerCopyOf,
  type TransactionToSign,
} from "../../../src/internal/signer/kms-signer.ts";
import type { KmsKeyAdapter, SignContext } from "../../../src/internal/signer/types.ts";
import { fakeAdapter } from "../../helpers/fake-adapter.ts";
import { fakeTimers } from "../../helpers/fake-timers.ts";
import { fakeTxAdapter } from "../../helpers/fake-tx-adapter.ts";
import { HARDHAT_ACCOUNT_0 } from "../../helpers/vectors.ts";

const secretKey = new Uint8Array(Buffer.from(HARDHAT_ACCOUNT_0.secretKey, "hex"));
const FROM = HARDHAT_ACCOUNT_0.address;
const ID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const TRANSACTION: TransactionToSign = {
  unsigned: Uint8Array.of(0xc0),
  type: 0,
  chainId: 1n,
  nonce: 7n,
};
const HOLD =
  ". Until nonce 7 is mined, the provider's copy itself reaches the node through this network connection, or the connection closes, the connection's sends from this account skip nonce 7, so they wait behind a gap that the replacement fills";

/** What the fake's signing methods do before they never answer. */
interface Behaviour {
  /** The ids to report with `ctx.requestSent`, in order; `null` reports without an id. */
  sent?: (string | null)[];
  /** Values to report with `ctx.requestSent` that are not strings, as a third-party adapter might. */
  sentValues?: unknown[];
  /** Throw this instead of waiting for the abort. */
  fail?: Error;
  /** Steps after `sent`: `refused` calls `ctx.requestRefused`, `sent` reports a sent request again. */
  after?: ("refused" | "sent")[];
}

/** Waits until the call's signal aborts, then rejects, as an SDK call does. */
async function untilAborted(ctx: SignContext): Promise<never> {
  return await new Promise<never>((_, reject) => {
    ctx.signal.addEventListener("abort", () => {
      reject(new Error("aborted"));
    });
  });
}

/** Runs a behaviour inside one signing method. */
async function behave(behaviour: Behaviour, ctx: SignContext): Promise<never> {
  for (const id of behaviour.sent ?? []) {
    if (id === null) {
      ctx.requestSent?.();
    } else {
      ctx.requestSent?.(id);
    }
  }
  const { requestSent } = ctx;
  assert.ok(requestSent !== undefined, "the core sets requestSent");
  for (const value of behaviour.sentValues ?? []) {
    Reflect.apply(requestSent, ctx, [value]);
  }
  for (const step of behaviour.after ?? []) {
    if (step === "refused") {
      ctx.requestRefused?.();
    } else {
      ctx.requestSent?.();
    }
  }
  if (behaviour.fail !== undefined) {
    throw behaviour.fail;
  }
  return await untilAborted(ctx);
}

/**
 * An adapter whose signing methods report sent requests and then never answer. `flag` is its
 * `signTransactionOutlivesAbort`; `transactions: false` leaves out `signTransaction`, so the core
 * signs transactions with `signDigest`.
 */
function outliving(
  behaviour: Behaviour,
  options: { flag?: boolean; provider?: string; transactions?: boolean } = {},
): KmsKeyAdapter {
  const inner = fakeAdapter({ secretKey });
  const adapter: KmsKeyAdapter = {
    describe: () => ({
      provider: options.provider ?? "fake",
      pinnedId: "fake-key-1",
      displayId: "fake-key-1",
    }),
    getPublicKey: async (ctx) =>
      await (inner.getPublicKey?.(ctx) ?? Promise.reject(new Error("missing"))),
    signDigest: async (_request, ctx) => await behave(behaviour, ctx),
    signMessage: async (_request, ctx) => await behave(behaviour, ctx),
    ...(options.transactions === false
      ? {}
      : { signTransaction: async (_request, ctx) => await behave(behaviour, ctx) }),
    ...(options.flag === undefined ? {} : { signTransactionOutlivesAbort: options.flag }),
  };
  return adapter;
}

/** A signer over `adapter`, with timers the test fires, and its key already looked up. */
async function signerOf(adapter: KmsKeyAdapter) {
  const timers = fakeTimers();
  const signer = new KmsSigner(adapter, {
    timeoutMs: 1300,
    displayMessage: async () => {},
    timers,
  });
  await signer.getAddress();
  return { signer, timers };
}

/** Lets the adapter call run as far as it can. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Starts `run`, fires the call's timeout once the adapter waits, and returns the error. */
async function afterTimeout(
  timers: ReturnType<typeof fakeTimers>,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const outcome = run().then(
    () => assert.fail("the call succeeded"),
    (error: unknown) => error,
  );
  await settle();
  timers.fire();
  return await outcome;
}

/** The message of the outstanding error, for a provider's words. */
function outstandingMessage(parts: {
  reason: string;
  who?: string;
  request: string;
  reject?: string;
  hold?: string;
  provider?: string;
}): string {
  return catalogError(
    ERRORS.signerTransactionOutstanding,
    {
      reason: parts.reason,
      who: parts.who ?? "the provider",
      request: parts.request,
      nonce: 7n,
      reject: parts.reject ?? "Reject the request at the provider",
      hold: parts.hold ?? "",
    },
    { provider: parts.provider ?? "fake", operation: "sign transaction", key: "fake-key-1" },
  ).message;
}

const NO_ANSWER = catalogMessage(ERRORS.signerNoAnswer, { timeout: 1300 });
const plainNoAnswer = catalogError(
  ERRORS.signerNoAnswer,
  { timeout: 1300 },
  { provider: "fake", operation: "sign", key: "fake-key-1" },
).message;

/** Asserts that an error is a plugin error with a held nonce. */
function assertOutstanding(error: unknown): asserts error is HardhatPluginError {
  assert.ok(error instanceof HardhatPluginError, String(error));
  assert.notEqual(outstandingNonce(error), undefined, error.message);
}

/** Asserts that an error is the plain timeout, not an outstanding transaction. */
function assertPlainTimeout(error: unknown): void {
  assert.ok(error instanceof HardhatPluginError, String(error));
  assert.equal(outstandingNonce(error), undefined, error.message);
  assert.equal(error.message, plainNoAnswer);
}

describe("a transaction the provider may still sign after a timeout or abort (#537)", () => {
  it("names the nonce, the request id and the hold, after a timeout once the request was sent", async () => {
    const { signer, timers } = await signerOf(outliving({ sent: [null, ID] }, { flag: true }));

    const error = await afterTimeout(
      timers,
      async () => await signer.signTransaction(TRANSACTION, { holdsNonce: true }),
    );

    assert.ok(error instanceof HardhatPluginError, String(error));
    assert.equal(outstandingNonce(error), 7n);
    assert.equal(
      error.message,
      outstandingMessage({ reason: NO_ANSWER, request: `request ${ID}`, hold: HOLD }),
    );
    assert.equal(error.pluginId, "hardhat-kms");
  });

  it("describes no hold for a caller that keeps none, such as kms sign-tx", async () => {
    const { signer, timers } = await signerOf(outliving({ sent: [ID] }, { flag: true }));

    const error = await afterTimeout(timers, async () => await signer.signTransaction(TRANSACTION));

    assertOutstanding(error);
    assert.equal(
      error.message,
      outstandingMessage({ reason: NO_ANSWER, request: `request ${ID}` }),
    );
  });

  it("says why when the caller's signal cancels the call after the request was sent", async () => {
    const { signer } = await signerOf(outliving({ sent: [ID] }, { flag: true }));
    const controller = new AbortController();

    const outcome = signer
      .signTransaction(TRANSACTION, { signal: controller.signal, holdsNonce: true })
      .then(
        () => assert.fail("the call succeeded"),
        (error: unknown) => error,
      );
    await settle();
    controller.abort();
    const error = await outcome;

    assertOutstanding(error);
    assert.equal(
      error.message,
      outstandingMessage({
        reason: catalogMessage(ERRORS.signerCancelled, {}),
        request: `request ${ID}`,
        hold: HOLD,
      }),
    );
  });

  it("uses Turnkey's words for a turnkey key", async () => {
    const { signer, timers } = await signerOf(
      outliving({ sent: [null, ID] }, { flag: true, provider: "turnkey" }),
    );

    const error = await afterTimeout(
      timers,
      async () => await signer.signTransaction(TRANSACTION, { holdsNonce: true }),
    );

    assertOutstanding(error);
    assert.equal(
      error.message,
      `turnkey, sign transaction, key fake-key-1: no answer within 1300 ms. The request reached the provider, and Turnkey may still sign this transaction (activity ${ID}); anyone who can read it there can then broadcast it with nonce 7. Reject the activity in the Turnkey dashboard while it is pending; then, or if it completed, send a replacement transaction with nonce 7, before any other transaction from this account. Until nonce 7 is mined, the provider's copy itself reaches the node through this network connection, or the connection closes, the connection's sends from this account skip nonce 7, so they wait behind a gap that the replacement fills`,
    );
  });

  it("says the id is not known when the adapter gave none, or one that is not a UUID", async () => {
    for (const sent of [
      [null],
      ["activity/../../etc"],
      [`x${ID}`],
      [`${ID}x`],
      [`${ID}\n`],
      [ID, "not-a-uuid"],
    ]) {
      for (const provider of ["fake", "turnkey"]) {
        const { signer, timers } = await signerOf(outliving({ sent }, { flag: true, provider }));

        const error = await afterTimeout(
          timers,
          async () => await signer.signTransaction(TRANSACTION),
        );

        assertOutstanding(error);
        // A later id that is not a UUID keeps the UUID reported before it.
        const known = sent[0] === ID;
        const expected =
          provider === "turnkey"
            ? outstandingMessage({
                reason: NO_ANSWER,
                who: "Turnkey",
                request: known
                  ? `activity ${ID}`
                  : "its activity id is not known: look for the account's newest sign_transaction activity",
                reject: "Reject the activity in the Turnkey dashboard",
                provider,
              })
            : outstandingMessage({
                reason: NO_ANSWER,
                request: known ? `request ${ID}` : "its request id is not known",
              });
        assert.equal(error.message, expected);
        assert.ok(!error.message.includes("not-a-uuid"));
        assert.ok(!error.message.includes("etc"));
      }
    }
  });

  it("shows no id that is not a string, even one whose text reads as a UUID", async () => {
    let reads = 0;
    const hostile = {
      toString: () => {
        reads++;
        return reads === 1 ? ID : "planted text";
      },
    };
    const { signer, timers } = await signerOf(
      outliving({ sentValues: [hostile, 42] }, { flag: true }),
    );

    const error = await afterTimeout(timers, async () => await signer.signTransaction(TRANSACTION));

    assertOutstanding(error);
    assert.equal(
      error.message,
      outstandingMessage({ reason: NO_ANSWER, request: "its request id is not known" }),
    );
  });

  it("fails as any cancellation when an adapter without the flag sent its request", async () => {
    const { signer } = await signerOf(outliving({ sent: [ID] }));
    const controller = new AbortController();
    const outcome = signer
      .signTransaction(TRANSACTION, { signal: controller.signal, holdsNonce: true })
      .then(
        () => assert.fail("the call succeeded"),
        (error: unknown) => error,
      );
    await settle();
    controller.abort();
    const error = await outcome;
    assert.ok(error instanceof HardhatPluginError, String(error));
    assert.equal(outstandingNonce(error), undefined);
    assert.equal(
      error.message,
      catalogError(
        ERRORS.signerCancelled,
        {},
        { provider: "fake", operation: "sign", key: "fake-key-1" },
      ).message,
    );
  });

  it("fails as any timeout when the request was not sent yet", async () => {
    const { signer, timers } = await signerOf(outliving({}, { flag: true }));
    assertPlainTimeout(
      await afterTimeout(
        timers,
        async () => await signer.signTransaction(TRANSACTION, { holdsNonce: true }),
      ),
    );
  });

  it("fails as any cancellation when the request was not sent yet", async () => {
    const { signer } = await signerOf(outliving({}, { flag: true }));
    const controller = new AbortController();
    const outcome = signer.signTransaction(TRANSACTION, { signal: controller.signal }).then(
      () => assert.fail("the call succeeded"),
      (error: unknown) => error,
    );
    await settle();
    controller.abort();
    const error = await outcome;
    assert.ok(error instanceof HardhatPluginError);
    assert.equal(outstandingNonce(error), undefined);
    assert.equal(
      error.message,
      catalogError(
        ERRORS.signerCancelled,
        {},
        { provider: "fake", operation: "sign", key: "fake-key-1" },
      ).message,
    );
  });

  it("holds the nonce when the adapter throws after sending, and names the error as the cause", async () => {
    const planted = catalogError(
      ERRORS.signerCallFailed,
      { errorName: "Planted" },
      { provider: "fake", operation: "poll", key: "fake-key-1" },
    );
    for (const [fail, reason] of [
      [new TypeError("broken"), "the provider call failed (TypeError)"],
      // The adapter's own prefix goes, and so does a final full stop.
      [planted, "the provider call failed (Planted)"],
      [
        new HardhatPluginError("hardhat-kms", "fake: no key prefix here."),
        "fake: no key prefix here",
      ],
      [new HardhatPluginError("hardhat-kms", "fake, but no key here"), "fake, but no key here"],
      [
        new HardhatPluginError("hardhat-kms", "other, poll, key fake-key-1: another provider's"),
        "other, poll, key fake-key-1: another provider's",
      ],
    ] as const) {
      const { signer } = await signerOf(outliving({ sent: [ID], fail }, { flag: true }));
      await assert.rejects(signer.signTransaction(TRANSACTION, { holdsNonce: true }), (error) => {
        assertOutstanding(error);
        assert.equal(outstandingNonce(error), 7n);
        assert.equal(
          error.message,
          outstandingMessage({ reason, request: `request ${ID}`, hold: HOLD }),
        );
        return true;
      });
    }
  });

  it("retries an invalid signature from the adapter and holds nothing, as before", async () => {
    const { signer } = await signerOf(
      outliving({ sent: [ID], fail: new InvalidSignatureError("planted") }, { flag: true }),
    );
    await assert.rejects(signer.signTransaction(TRANSACTION, { holdsNonce: true }), (error) => {
      assert.ok(error instanceof HardhatPluginError);
      assert.equal(outstandingNonce(error), undefined);
      assert.equal(
        error.message,
        catalogError(
          ERRORS.signerInvalidSignature,
          { reason: "planted" },
          { provider: "fake", operation: "sign", key: "fake-key-1" },
        ).message,
      );
      return true;
    });
  });

  it("releases the nonce when the adapter says the provider refused the request", async () => {
    const { signer } = await signerOf(
      outliving({ sent: [ID], after: ["refused"], fail: new TypeError("refused") }, { flag: true }),
    );
    await assert.rejects(signer.signTransaction(TRANSACTION, { holdsNonce: true }), (error) => {
      assert.ok(error instanceof HardhatPluginError);
      assert.equal(outstandingNonce(error), undefined);
      assert.equal(
        error.message,
        catalogError(
          ERRORS.signerCallFailed,
          { errorName: "TypeError" },
          { provider: "fake", operation: "sign", key: "fake-key-1" },
        ).message,
      );
      return true;
    });
    const timed = await signerOf(outliving({ sent: [ID], after: ["refused"] }, { flag: true }));
    assertPlainTimeout(
      await afterTimeout(
        timed.timers,
        async () => await timed.signer.signTransaction(TRANSACTION, { holdsNonce: true }),
      ),
    );
  });

  it("holds again when the adapter sends another request after a refusal", async () => {
    const { signer } = await signerOf(
      outliving(
        { sent: [ID], after: ["refused", "sent"], fail: new TypeError("x") },
        { flag: true },
      ),
    );
    await assert.rejects(signer.signTransaction(TRANSACTION), (error) => {
      assert.equal(outstandingNonce(error), 7n);
      return true;
    });
  });

  it("ignores a refusal without a sent request, and from an adapter without the flag", async () => {
    const cases: [Behaviour, boolean][] = [
      [{ after: ["refused"] }, true],
      [{ sent: [ID], after: ["refused", "sent"] }, false],
    ];
    for (const [behaviour, flag] of cases) {
      const { signer, timers } = await signerOf(outliving(behaviour, { flag }));
      assertPlainTimeout(
        await afterTimeout(timers, async () => await signer.signTransaction(TRANSACTION)),
      );
    }
  });

  it("keeps nothing for an adapter without the flag, or with it false", async () => {
    for (const flag of [undefined, false]) {
      const { signer, timers } = await signerOf(
        outliving({ sent: [ID] }, flag === undefined ? {} : { flag }),
      );
      assertPlainTimeout(
        await afterTimeout(
          timers,
          async () => await signer.signTransaction(TRANSACTION, { holdsNonce: true }),
        ),
      );
    }
  });

  it("keeps nothing when the flag is set but signDigest signs the transaction", async () => {
    const { signer, timers } = await signerOf(
      outliving({ sent: [ID] }, { flag: true, transactions: false }),
    );
    assertPlainTimeout(
      await afterTimeout(
        timers,
        async () => await signer.signTransaction(TRANSACTION, { holdsNonce: true }),
      ),
    );
  });

  it("keeps nothing for a message or a digest through the same adapter", async () => {
    for (const sign of [
      async (signer: KmsSigner) => await signer.signPersonalMessage(Uint8Array.of(1)),
      async (signer: KmsSigner) => await signer.signDigest(new Uint8Array(32).fill(1)),
    ]) {
      const { signer, timers } = await signerOf(outliving({ sent: [ID] }, { flag: true }));
      assertPlainTimeout(await afterTimeout(timers, async () => await sign(signer)));
    }
  });

  it("says the provider keeps signed transactions only with the flag and signTransaction", async () => {
    for (const [options, keeps] of [
      [{ flag: true }, true],
      [{ flag: true, transactions: false }, false],
      [{ flag: false }, false],
      [{}, false],
    ] as const) {
      const { signer } = await signerOf(outliving({}, options));
      assert.equal(signer.keepsSignedTransactions(), keeps, JSON.stringify(options));
    }
  });

  it("reads the flag once, when the signer is built", async () => {
    const adapter = outliving({ sent: [ID] }, { flag: true });
    const { signer, timers } = await signerOf(adapter);
    Reflect.set(adapter, "signTransactionOutlivesAbort", false);
    const error = await afterTimeout(timers, async () => await signer.signTransaction(TRANSACTION));
    assertOutstanding(error);
  });
});

describe("signTransaction's nonce hold (#537)", () => {
  const filled = {
    from: new Uint8Array(Buffer.from(FROM.slice(2), "hex")),
    to: new Uint8Array(20).fill(1),
    gas: 21_000n,
    gasPrice: 1n,
    nonce: 4n,
    chainId: 1n,
    value: 0n,
    data: new Uint8Array(),
  };
  const filler: TransactionFiller = { fill: async () => await Promise.resolve(filled) };

  /** Signs through the RPC path with a hold callback, and returns the held nonces and the error. */
  async function held(adapter: KmsKeyAdapter, withHold: boolean) {
    const { signer, timers } = await signerOf(adapter);
    const nonces: bigint[] = [];
    const error = await afterTimeout(
      timers,
      async () =>
        await signTransaction(signer, {
          filler,
          method: "eth_sendTransaction",
          params: [{ from: FROM }],
          from: FROM.toLowerCase(),
          ...(withHold
            ? {
                holdNonce: (nonce: bigint) => {
                  nonces.push(nonce);
                },
              }
            : {}),
        }),
    );
    return { nonces, error };
  }

  it("holds the filled nonce and says how the hold ends", async () => {
    const { nonces, error } = await held(outliving({ sent: [ID] }, { flag: true }), true);
    assert.deepEqual(nonces, [4n]);
    assertOutstanding(error);
    assert.equal(outstandingNonce(error), 4n);
    assert.match(error.message, /skip nonce 4, so they wait behind a gap/);
  });

  it("signs with a flagged adapter without a hold callback, as kms sign-tx does", async () => {
    const adapter: KmsKeyAdapter = {
      ...fakeTxAdapter({ secretKey }),
      signTransactionOutlivesAbort: true,
    };
    const signer = new KmsSigner(adapter, { timeoutMs: 1300, displayMessage: async () => {} });
    const signed = await signTransaction(signer, {
      filler,
      method: "kms sign-tx",
      params: [{ from: FROM }],
      from: FROM.toLowerCase(),
    });
    assert.equal(signed.providerCopy?.nonce, 4n);
    assert.equal(signed.providerCopy?.who, "the provider");
    // The fake reports no request id.
    assert.equal(signed.providerCopy?.request, "its request id is not known");
    const digest = await signer.signDigest(new Uint8Array(32).fill(1));
    assert.equal(providerCopyOf(digest), undefined, "only a transaction has a copy to hold");
  });

  it("describes no hold without a hold callback", async () => {
    const { error } = await held(outliving({ sent: [ID] }, { flag: true }), false);
    assertOutstanding(error);
    assert.ok(!error.message.includes("skip nonce"), error.message);
  });

  it("holds nothing after a plain timeout", async () => {
    const { nonces, error } = await held(outliving({}, { flag: true }), true);
    assert.deepEqual(nonces, []);
    assertPlainTimeout(error);
  });
});
