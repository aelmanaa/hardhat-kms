// A key's allowedDelegates (#562) in the library account: signAuthorization, and signTransaction's
// self-authorizations. Every refusal comes before any KMS call, with the exact message.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Address, SignedAuthorizationList } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createKmsNetworkConnection } from "../../../src/internal/viem/account.ts";
import type { KmsAllowedDelegate, KmsKeyConfig } from "../../../src/types.ts";
import {
  ADDRESS,
  assertRefused,
  CHAIN_ID,
  kmsCalls,
  setup,
  VIEM_ACCOUNT,
  viemAuthorizationWithoutV,
} from "../../helpers/library-account.ts";
import { COW_ACCOUNT } from "../../helpers/vectors.ts";

const SIMPLE: Address = "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9";
const MAV2: Address = "0x77021100bD87b7008E5E1989d0eB38555d0d0000";
const OTHER: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const TO: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CODE = "0x60806040fe";
const CODE_HASH = `0x${Buffer.from(keccak_256(Buffer.from(CODE.slice(2), "hex"))).toString("hex")}`;
const COW = privateKeyToAccount(`0x${COW_ACCOUNT.secretKey}`);

const LIST: readonly KmsAllowedDelegate[] = [
  { address: SIMPLE, chains: "all", label: "Simple7702Account" },
  { address: MAV2, chains: [1, CHAIN_ID], label: "Modular Account v2" },
  { address: OTHER, chains: [CHAIN_ID], codeHash: CODE_HASH, label: "batcher" },
];

async function accountWith(
  allowedDelegates: readonly KmsAllowedDelegate[] | undefined,
  options: { code?: Record<string, unknown>; allowChainZeroAuthorization?: boolean } = {},
) {
  const made = setup({
    ...(allowedDelegates === undefined ? {} : { allowedDelegates }),
    ...(options.code === undefined ? {} : { code: options.code }),
  });
  const account = await createKmsNetworkConnection(made.connection).getAccount(ADDRESS, {
    allowChainZeroAuthorization: options.allowChainZeroAuthorization ?? false,
  });
  return { ...made, account };
}

describe("signAuthorization with allowedDelegates", () => {
  it("refuses a delegate not listed, naming the key, the delegate and the chain", async () => {
    const { adapter, account } = await accountWith(LIST);
    await assertRefused(
      adapter,
      async () => await account.signAuthorization({ address: TO, chainId: CHAIN_ID, nonce: 0 }),
      `signAuthorization: key deployer may not delegate to ${TO} on chain ${CHAIN_ID}: no entry of its allowedDelegates allows that delegate on that chain. Nothing was signed`,
    );
  });

  it("refuses a chain-0 authorization for a delegate listed only for some chains", async () => {
    const { adapter, account } = await accountWith(LIST, { allowChainZeroAuthorization: true });
    await assertRefused(
      adapter,
      async () => await account.signAuthorization({ address: MAV2, chainId: 0, nonce: 0 }),
      `signAuthorization: key deployer may not delegate to ${MAV2} on chain 0, which is every chain: only an allowedDelegates entry with chains: "all" allows a chain-0 authorization. Nothing was signed`,
    );
    const request = { address: SIMPLE, chainId: 0, nonce: 3 } as const;
    assert.deepEqual(
      await account.signAuthorization(request),
      await viemAuthorizationWithoutV(request),
    );
  });

  it("signs a listed delegate, in any case, and the zero address with an empty list", async () => {
    const { account } = await accountWith(LIST);
    const lower = {
      address: `0x${MAV2.slice(2).toLowerCase()}`,
      chainId: CHAIN_ID,
      nonce: 1,
    } as const;
    assert.deepEqual(
      await account.signAuthorization(lower),
      await viemAuthorizationWithoutV(lower),
    );
    const empty = await accountWith([]);
    const revoke = { address: ZERO, chainId: CHAIN_ID, nonce: 2 } as const;
    assert.deepEqual(
      await empty.account.signAuthorization(revoke),
      await viemAuthorizationWithoutV(revoke),
    );
    await assertRefused(
      empty.adapter,
      async () =>
        await empty.account.signAuthorization({ address: SIMPLE, chainId: CHAIN_ID, nonce: 0 }),
      /may not delegate to 0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9 on chain 31337/,
    );
  });

  it("signs any delegate for a key without allowedDelegates, and reads no code", async () => {
    const { account, codeCalls } = await accountWith(undefined);
    await account.signAuthorization({ address: TO, chainId: CHAIN_ID, nonce: 0 });
    assert.deepEqual(codeCalls, []);
  });

  it("reads a pinned delegate's code and refuses a mismatch or empty code", async () => {
    const mismatch = await accountWith(LIST, { code: { [OTHER.toLowerCase()]: "0x6000" } });
    await assertRefused(
      mismatch.adapter,
      async () =>
        await mismatch.account.signAuthorization({ address: OTHER, chainId: CHAIN_ID, nonce: 0 }),
      /^signAuthorization: the code of delegate 0x5FbDB2315678afecb367f032d93F642f64180aa3 on chain 31337 has hash 0x[0-9a-f]{64}, which no codeHash/,
    );
    assert.deepEqual(mismatch.codeCalls, [OTHER]);
    const empty = await accountWith(LIST);
    await assertRefused(
      empty.adapter,
      async () =>
        await empty.account.signAuthorization({ address: OTHER, chainId: CHAIN_ID, nonce: 0 }),
      /has no code on chain 31337/,
    );
    const matching = await accountWith(LIST, { code: { [OTHER.toLowerCase()]: CODE } });
    const request = { address: OTHER, chainId: CHAIN_ID, nonce: 4 } as const;
    assert.deepEqual(
      await matching.account.signAuthorization(request),
      await viemAuthorizationWithoutV(request),
    );
  });
});

/** An EIP-7702 transaction from the account with this authorization list. */
const transaction = (authorizationList: SignedAuthorizationList) => ({
  type: "eip7702" as const,
  chainId: CHAIN_ID,
  nonce: 0,
  gas: 50_000n,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
  to: TO,
  authorizationList,
});

describe("signTransaction's self-authorizations with allowedDelegates", () => {
  it("refuses a self-authorization to a delegate not listed, before the KMS call", async () => {
    const { adapter, account } = await accountWith(LIST);
    const self = await VIEM_ACCOUNT.signAuthorization({ address: TO, chainId: CHAIN_ID, nonce: 1 });
    const before = kmsCalls(adapter);
    await assertRefused(
      adapter,
      async () => await account.signTransaction(transaction([self])),
      `signTransaction: authorizationList[0] is signed by the sender and delegates it to ${TO} on chain ${CHAIN_ID}, which the allowedDelegates of key deployer do not allow; nothing was signed`,
    );
    assert.equal(kmsCalls(adapter), before);
  });

  it("signs when another authority signed the same delegate", async () => {
    const { account } = await accountWith(LIST);
    const other = await COW.signAuthorization({ address: TO, chainId: CHAIN_ID, nonce: 5 });
    const request = transaction([other]);
    assert.equal(
      await account.signTransaction(request),
      await VIEM_ACCOUNT.signTransaction(request),
    );
  });

  it("signs a self-authorization to a listed delegate", async () => {
    const { account } = await accountWith(LIST);
    const self = await VIEM_ACCOUNT.signAuthorization({
      address: SIMPLE,
      chainId: CHAIN_ID,
      nonce: 1,
    });
    const request = transaction([self]);
    assert.equal(
      await account.signTransaction(request),
      await VIEM_ACCOUNT.signTransaction(request),
    );
  });
});

describe("a --kms copy of a listed config key (#593)", () => {
  // The helper's key is alias/deployer; this config key has its address pin.
  const pinned: KmsKeyConfig = {
    provider: "aws",
    name: "listed",
    timeoutMs: 10_000,
    displayId: "aws:listed",
    keyId: { get: async () => await Promise.resolve("alias/listed"), display: "alias/listed" },
    address: ADDRESS,
    allowedDelegates: LIST,
  };
  const refusal =
    "the --kms key deployer is the same KMS key as listed, which has allowedDelegates. Name listed instead, so its list applies. Nothing was signed";

  async function copy() {
    const made = setup({ listed: [pinned] });
    const account = await createKmsNetworkConnection(made.connection).getAccount(ADDRESS);
    return { ...made, account };
  }

  it("refuses signAuthorization and a self-authorization, before the KMS call", async () => {
    const { adapter, account } = await copy();
    const before = kmsCalls(adapter);
    await assertRefused(
      adapter,
      async () => await account.signAuthorization({ address: SIMPLE, chainId: CHAIN_ID, nonce: 0 }),
      `signAuthorization: ${refusal}`,
    );
    const self = await VIEM_ACCOUNT.signAuthorization({
      address: SIMPLE,
      chainId: CHAIN_ID,
      nonce: 1,
    });
    await assertRefused(
      adapter,
      async () => await account.signTransaction(transaction([self])),
      `signTransaction: ${refusal}`,
    );
    assert.equal(kmsCalls(adapter), before);
  });

  it("signs the zero address, and a transaction whose authorizations another authority signed", async () => {
    const { account } = await copy();
    const cleared = await account.signAuthorization({ address: ZERO, chainId: CHAIN_ID, nonce: 0 });
    assert.equal(cleared.address, ZERO);
    const other = await COW.signAuthorization({ address: TO, chainId: CHAIN_ID, nonce: 5 });
    const request = transaction([other]);
    assert.equal(
      await account.signTransaction(request),
      await VIEM_ACCOUNT.signTransaction(request),
    );
  });
});
