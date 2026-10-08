// The `signal` option of getAccount: an abort stops the account's KMS call in flight with a
// cancellation error, refuses every later call before any KMS call, reserves no nonce, and never
// hands viem a signature to send.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";
import { createWalletClient, custom } from "viem";
import { hardhat } from "viem/chains";

import { ERRORS } from "../../../src/internal/error-catalog.ts";
import { catalogError } from "../../../src/internal/errors.ts";
import type { KmsSigner } from "../../../src/internal/signer/kms-signer.ts";
import { createKmsNetworkConnection } from "../../../src/internal/viem/account.ts";
import type { KmsAccount } from "../../../src/internal/viem/types.ts";
import type { KmsKeyConfig } from "../../../src/types.ts";
import {
  ADDRESS,
  assertRefused,
  CHAIN_ID,
  kmsCalls,
  type Setup,
  setup,
} from "../../helpers/library-account.ts";

const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const LOWER = ADDRESS.toLowerCase();
const TRANSACTION = {
  type: "eip1559",
  chainId: CHAIN_ID,
  nonce: 3,
  gas: 21_000n,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
  to: TO,
  value: 1n,
} as const;
const TYPED_DATA = {
  domain: { name: "Test", chainId: CHAIN_ID },
  types: { Mail: [{ name: "contents", type: "string" }] },
  primaryType: "Mail",
  message: { contents: "hi" },
} as const;

/** The account's refusal once its signal has aborted. */
const refused = (operation: string): string =>
  catalogError(ERRORS.accountCancelled, {}, { operation }).message;

/** The signer's error for a KMS call that the signal stopped. */
const CANCELLED_SIGN = catalogError(
  ERRORS.signerCancelled,
  {},
  { provider: "fake", operation: "sign", key: "fake-key-1" },
).message;

/** Each method of the account that asks the KMS, called with valid input. */
function kmsMethods(account: KmsAccount): [string, () => Promise<unknown>][] {
  return [
    ["signMessage", async () => await account.signMessage({ message: "hi" })],
    ["signTypedData", async () => await account.signTypedData(TYPED_DATA)],
    ["signTransaction", async () => await account.signTransaction(TRANSACTION)],
    [
      "signAuthorization",
      async () => await account.signAuthorization({ address: TO, chainId: CHAIN_ID, nonce: 0 }),
    ],
  ];
}

/** A setup whose KMS signatures wait until the test lets them go, and never answer by default. */
function holdingSetup(): Setup & { signing: () => number } {
  let started = 0;
  const base = setup({
    adapter: {
      beforeSign: async () => {
        started++;
        await new Promise<never>(() => {
          // Never answers: only the signal ends the call.
        });
      },
    },
  });
  return { ...base, signing: () => started };
}

/** Replaced in a promise's executor before it is called. */
const ignore = (): void => undefined;

/** Lets pending promise jobs and one macrotask run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("getAccount's signal", () => {
  it("refuses getAccount before any KMS call when the signal has already aborted", async () => {
    const { adapter, connection } = setup();
    await assertRefused(
      adapter,
      async () =>
        await createKmsNetworkConnection(connection).getAccount(ADDRESS, {
          signal: AbortSignal.abort(),
        }),
      refused("getAccount"),
    );
    assert.equal(kmsCalls(adapter), 0);
  });

  it("ignores an inherited signal, as it ignores other inherited options", async () => {
    const { connection } = setup();
    const options: unknown = Object.create({ signal: AbortSignal.abort() });
    const kms = createKmsNetworkConnection(connection);
    const account = await Reflect.apply(kms.getAccount, kms, [ADDRESS, options]);
    assert.equal(account.address, ADDRESS);
  });

  it("signs every kind of payload while the signal has not aborted", async () => {
    const { connection } = setup();
    const caller = new AbortController();
    const kms = createKmsNetworkConnection(connection);
    const account = await kms.getAccount(ADDRESS, { signal: caller.signal });
    const plain = await kms.getAccount(ADDRESS);
    for (const [index, [method, sign]] of kmsMethods(account).entries()) {
      const expected = await kmsMethods(plain)[index]?.[1]();
      assert.deepEqual(await sign(), expected, method);
    }
  });

  for (const method of ["signMessage", "signTypedData", "signTransaction", "signAuthorization"]) {
    it(`${method}: an abort stops the KMS call, and nothing is returned`, async () => {
      const { connection, nonceCalls, signing } = holdingSetup();
      const caller = new AbortController();
      const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS, {
        signal: caller.signal,
      });
      const call = kmsMethods(account).find(([name]) => name === method)?.[1];
      assert.ok(call !== undefined);

      const pending = call();
      await settle();
      assert.equal(signing(), 1, "the KMS call started");
      caller.abort();
      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof HardhatPluginError);
        assert.equal(error.message, CANCELLED_SIGN);
        return true;
      });
      assert.equal(signing(), 1, "a cancelled call is not retried");
      assert.deepEqual(nonceCalls, [], "no nonce is noted for an unsigned transaction");
    });
  }

  it("refuses every later call before any KMS call, and reserves no nonce", async () => {
    const { adapter, connection, chainCalls, nonceCalls } = setup();
    const caller = new AbortController();
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS, {
      signal: caller.signal,
    });
    caller.abort();
    const chainCallsBefore = chainCalls.count;
    for (const [method, call] of kmsMethods(account)) {
      await assertRefused(adapter, call, refused(method));
    }
    const parameters = { address: ADDRESS, chainId: CHAIN_ID, client: {} };
    await assertRefused(
      adapter,
      async () => await account.nonceManager.consume(parameters),
      refused("nonceManager.consume"),
    );
    await assertRefused(
      adapter,
      async () => await account.nonceManager.get(parameters),
      refused("nonceManager.get"),
    );
    assert.equal(chainCalls.count, chainCallsBefore, "refused before the chain id is read");
    assert.deepEqual(nonceCalls, []);
  });

  it("drops a signature that comes back after the signal aborted", async () => {
    const base = setup();
    const caller = new AbortController();
    // The signal aborts between the KMS answer and the account's return, as an abort can land in
    // the turn that resolves the signature.
    const connection = {
      ...base.connection,
      accounts: {
        ...base.connection.accounts,
        signWith: async <T>(
          key: KmsKeyConfig,
          use: (signer: KmsSigner) => Promise<T>,
        ): Promise<T> => {
          const result = await base.connection.accounts.signWith(key, use);
          if (base.adapter.calls.signDigest > 0) {
            caller.abort();
          }
          return result;
        },
      },
    };
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS, {
      signal: caller.signal,
    });
    await assert.rejects(account.signTransaction(TRANSACTION), (error: unknown) => {
      assert.ok(error instanceof HardhatPluginError);
      assert.equal(error.message, refused("signTransaction"));
      return true;
    });
    assert.equal(base.adapter.calls.signDigest, 1, "the KMS signed");
    assert.deepEqual(base.nonceCalls, [], "the nonce is not noted as signed");
  });

  it("stops getAccount's public key lookup for this caller", async () => {
    let answer: () => void = ignore;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const state = { entered: false };
    const { connection } = setup();
    const accounts = connection.accounts;
    const held = {
      ...connection,
      accounts: {
        ...accounts,
        signWith: async <T>(
          key: KmsKeyConfig,
          use: (signer: KmsSigner) => Promise<T>,
        ): Promise<T> => {
          state.entered = true;
          await answered;
          return await accounts.signWith(key, use);
        },
      },
    };
    const caller = new AbortController();
    const pending = createKmsNetworkConnection(held).getAccount(ADDRESS, { signal: caller.signal });
    while (!state.entered) {
      await settle();
    }
    caller.abort();
    answer();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof HardhatPluginError);
      assert.equal(
        error.message,
        catalogError(
          ERRORS.signerCancelled,
          {},
          { provider: "fake", operation: "get public key", key: "fake-key-1" },
        ).message,
      );
      return true;
    });
  });

  it("makes viem's send fail unsent, and viem's reset then ends the nonce's hold", async () => {
    const { connection, nonceCalls, signing } = holdingSetup();
    const caller = new AbortController();
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS, {
      signal: caller.signal,
    });
    const methods: string[] = [];
    const wallet = createWalletClient({
      account,
      chain: hardhat,
      transport: custom({
        request: async ({ method }: { method: string }): Promise<unknown> => {
          methods.push(method);
          await Promise.resolve();
          switch (method) {
            case "eth_chainId":
              return `0x${CHAIN_ID.toString(16)}`;
            case "eth_getBlockByNumber":
              return {
                baseFeePerGas: "0x1",
                number: "0x1",
                timestamp: "0x1",
                gasLimit: "0x1c9c380",
              };
            case "eth_maxPriorityFeePerGas":
              return "0x1";
            case "eth_estimateGas":
              return "0x5208";
            default:
              throw new Error(`the fake node does not answer ${method}`);
          }
        },
      }),
    });

    const sending = wallet.sendTransaction({ to: TO, value: 1n });
    while (signing() === 0) {
      await settle();
    }
    caller.abort();
    await assert.rejects(sending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(CANCELLED_SIGN), error.message);
      return true;
    });
    assert.ok(!methods.includes("eth_sendRawTransaction"), "nothing was broadcast");
    await settle();
    assert.deepEqual(nonceCalls, [
      ["choose", { address: LOWER, chainId: BigInt(CHAIN_ID), reserve: true, ownTransport: false }],
      ["reset", LOWER, BigInt(CHAIN_ID)],
    ]);
  });
});
