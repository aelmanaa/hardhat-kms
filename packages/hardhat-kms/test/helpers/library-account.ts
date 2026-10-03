// A library account (connection.kms.getAccount) over a deterministic fake KMS, for the unit tests
// in test/unit/viem. The connection is a plain object, so each test controls its chain, its
// cross-chain option and whether it is closed.
import assert from "node:assert/strict";

import { HardhatPluginError } from "hardhat/plugins";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

import { KmsSigner } from "../../src/internal/signer/kms-signer.ts";
import type { AccountConnection } from "../../src/internal/viem/account.ts";
import type { KmsKeyConfig } from "../../src/types.ts";
import { type FakeAdapter, type FakeAdapterOptions, fakeAdapter } from "./fake-adapter.ts";
import { HARDHAT_ACCOUNT_0 } from "./vectors.ts";

/** viem's account for Hardhat's first test key, the key of the fake KMS. */
export const VIEM_ACCOUNT: PrivateKeyAccount = privateKeyToAccount(
  `0x${HARDHAT_ACCOUNT_0.secretKey}`,
);
/** The KMS account's address. */
export const ADDRESS: `0x${string}` = VIEM_ACCOUNT.address;
/** The connection's chain. */
export const CHAIN_ID: number = 31337;

const KEY: KmsKeyConfig = {
  provider: "aws",
  name: "deployer",
  timeoutMs: 10_000,
  displayId: "aws:deployer",
  keyId: { get: async () => await Promise.resolve("alias/deployer"), display: "alias/deployer" },
};

/** A connection for a library account, and what the tests observe of it. */
export interface Setup {
  adapter: FakeAdapter;
  connection: AccountConnection;
  /** Calls to the connection's chain id. */
  chainCalls: { count: number };
  /** Set `closed` to close the connection. */
  state: { closed: boolean };
  /** The calls to the connection's nonces, in order, as `[method, ...arguments]`. */
  nonceCalls: unknown[][];
}

/**
 * Builds a connection whose one KMS account is {@link ADDRESS}.
 *
 * @param options - The fake adapter's options (by default it holds the key of {@link ADDRESS};
 *   another `secretKey` makes the signer sign for another address), the connection's chain id
 *   and `kms.allowCrossChainTypedData`.
 * @returns The connection and its observers.
 */
export function setup(
  options: {
    adapter?: Partial<FakeAdapterOptions>;
    chainId?: bigint;
    allowCrossChainTypedData?: boolean;
  } = {},
): Setup {
  const adapter = fakeAdapter({
    secretKey: new Uint8Array(Buffer.from(HARDHAT_ACCOUNT_0.secretKey, "hex")),
    ...options.adapter,
  });
  const signer = new KmsSigner(adapter, {
    timeoutMs: 10_000,
    displayMessage: async () => {
      await Promise.resolve();
    },
  });
  const chainCalls = { count: 0 };
  const state = { closed: false };
  const nonceCalls: unknown[][] = [];
  const connection: AccountConnection = {
    network: "local",
    accounts: {
      keyFor: async (address) =>
        await Promise.resolve(address === ADDRESS.toLowerCase() ? KEY : undefined),
      addresses: async () => await Promise.resolve([ADDRESS]),
      signWith: async (_key, use) => await use(signer),
    },
    chainId: async () => {
      chainCalls.count++;
      return await Promise.resolve(options.chainId ?? BigInt(CHAIN_ID));
    },
    allowCrossChainTypedData: options.allowCrossChainTypedData ?? false,
    closed: () => state.closed,
    nonces: {
      choose: async (request) => {
        nonceCalls.push(["choose", request]);
        return await Promise.resolve(7n);
      },
      signed: (address, nonce) => {
        nonceCalls.push(["signed", address, nonce]);
      },
      reset: async (address, chainId) => {
        nonceCalls.push(["reset", address, chainId]);
        await Promise.resolve();
      },
    },
  };
  return { adapter, connection, chainCalls, state, nonceCalls };
}

/**
 * Every adapter call, to assert that a refusal made none.
 *
 * @param adapter - The fake adapter.
 * @returns The number of calls so far.
 */
export const kmsCalls = (adapter: FakeAdapter): number =>
  adapter.calls.getPublicKey + adapter.calls.getAddress + adapter.calls.signDigest;

/**
 * Asserts that `run` is refused with a `HardhatPluginError`, and that the adapter was not called
 * meanwhile.
 *
 * @param adapter - The fake adapter.
 * @param run - The call to refuse.
 * @param message - The exact message, or a pattern it matches.
 */
export async function assertRefused(
  adapter: FakeAdapter,
  run: () => Promise<unknown>,
  message: string | RegExp,
): Promise<void> {
  const before = kmsCalls(adapter);
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError);
    if (typeof message === "string") {
      assert.equal(error.message, message);
    } else {
      assert.match(error.message, message);
    }
    return true;
  });
  assert.equal(kmsCalls(adapter), before, "a refusal must not call the KMS");
}
