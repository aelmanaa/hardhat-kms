// The account's public types are written without viem's (so a project without viem typechecks).
// This file fails to compile when they stop being assignable to viem's account types.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Account, LocalAccount, PrivateKeyAccount } from "viem";
import { createWalletClient, http } from "viem";
import { toCoinbaseSmartAccount, toSimple7702SmartAccount } from "viem/account-abstraction";
import type { CustomSource } from "viem/accounts";

import type { KmsAccount, KmsRawSignAccount } from "../../../src/types.ts";

/**
 * Assignments the compiler checks; never called.
 *
 * @param account - An account from `getAccount(address)`.
 * @param rawAccount - An account from `getAccount(address, { rawSign: true })`.
 * @returns The assigned values.
 */
function assignments(account: KmsAccount, rawAccount: KmsRawSignAccount): unknown[] {
  const local: LocalAccount = account;
  const source: CustomSource = account;
  const any: Account = account;
  const rawLocal: LocalAccount = rawAccount;
  // @ts-expect-error -- without rawSign the account has no `sign`, which a PrivateKeyAccount needs.
  const privateKey: PrivateKeyAccount = account;
  const wallet = createWalletClient({ account, transport: http() });
  const owner = toCoinbaseSmartAccount({
    client: createWalletClient({ transport: http() }),
    owners: [rawAccount],
    version: "1.1",
  });
  // A known non-goal: viem types the owner of toSimple7702SmartAccount as a PrivateKeyAccount,
  // whose `source` is "privateKey", even with rawSign. Its code calls only `address`,
  // `signMessage`, `signTypedData` and `signAuthorization`, so a project passes the account with a
  // cast at the call site (docs/user/reference/library-accounts.md).
  const simple7702 = toSimple7702SmartAccount({
    client: createWalletClient({ transport: http() }),
    // @ts-expect-error -- the owner must be a PrivateKeyAccount, which no KMS account is.
    owner: rawAccount,
  });
  return [local, source, any, rawLocal, privateKey, wallet, owner, simple7702];
}

describe("KmsAccount types", () => {
  it("are assignable to viem's account types (checked by tsc)", () => {
    assert.equal(typeof assignments, "function");
  });
});
