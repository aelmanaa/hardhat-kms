---
title: hardhat-kms/alchemy
description: "The hardhat-kms/alchemy entry point: checkPreparedCalls, which checks an Alchemy Wallet APIs prepared call before a KMS key signs it."
---

# hardhat-kms/alchemy

A check for Alchemy's Wallet APIs: `checkPreparedCalls` reads what `prepareCalls` of
`@alchemy/wallet-apis` returned and refuses it unless the KMS key would sign exactly the calls
you asked for. Call it between `prepareCalls` and `signPreparedCalls`.

This entry point needs viem, an optional peer dependency of hardhat-kms. It does not depend on
`@alchemy/wallet-apis`; it reads the response shape of version 5.3.0.

## Interfaces

### PreparedCallsExpectation

What you asked `prepareCalls` for, and what the key's account looks like on chain.

#### Properties

##### accountCode

> `readonly` **accountCode**: `` `0x${string}` `` \| `undefined`

The account's code now, as `getCode` returns it: `undefined` or `0x` when it has none, or
`0xef0100` and the delegate's address when it is delegated.

##### calls

> `readonly` **calls**: readonly [`RequestedCall`](#requestedcall)[]

The calls you gave `prepareCalls`, in the same order.

##### chainId

> `readonly` **chainId**: `number`

Your chain's id. The user operation hash is computed with it, not with the returned one.

##### delegate

> `readonly` **delegate**: `string`

The only contract the account may be delegated to, such as Modular Account v2 v1.1.0 at
`0x77021100bD87b7008E5E1989d0eB38555d0d0000`.

##### sender

> `readonly` **sender**: `string`

The key's address: the EIP-7702 account that sends the calls.

##### sponsored

> `readonly` **sponsored**: `boolean`

Whether you passed a gas sponsorship policy id to the client or to `prepareCalls`.

---

### RequestedCall

A call as you give it to `prepareCalls`.

#### Properties

##### data?

> `readonly` `optional` **data?**: `` `0x${string}` ``

The call data; missing data is `0x`.

##### to

> `readonly` **to**: `string`

The address the call goes to: lowercase, or with a valid EIP-55 checksum.

##### value?

> `readonly` `optional` **value?**: `bigint`

The value in wei; a missing value is 0.

## Functions

### checkPreparedCalls()

> **checkPreparedCalls**(`prepared`: `unknown`, `expected`: [`PreparedCallsExpectation`](#preparedcallsexpectation)): `void`

Checks a response of `prepareCalls` from `@alchemy/wallet-apis` before the key signs it, and
throws when the key would sign anything other than the calls you asked for.

It accepts a `user-operation-v070`, or an `array` of one `user-operation-v070` and at most one
EIP-7702 `authorization`, and requires:

- a `personal_sign` signature request over a raw hash (`{ raw }`), never typed data;
- the user operation and the authorization on your chain, from `sender`, with no factory;
- the EntryPoint v0.7 user operation hash, recomputed with your `chainId`, equal to the hash in
  the signature request;
- `callData` that is Modular Account v2 `execute` or `executeBatch`, optionally behind the
  `executeUserOp` selector `0x8dd7712f`, with exactly your calls, in order;
- with `sponsored`, a paymaster and `feePayment.sponsored`;
- an authorization only to `delegate`, and only when the account has no code or is already
  delegated to `delegate`; without one, the account must already be delegated to `delegate`.

Call it between `prepareCalls` and `signPreparedCalls`. It reads no chain state itself: pass the
account's code, read with `getCode` just before `prepareCalls`.

#### Parameters

| Parameter  | Type                                                    | Description                                          |
| ---------- | ------------------------------------------------------- | ---------------------------------------------------- |
| `prepared` | `unknown`                                               | What `client.prepareCalls(...)` returned, unchanged. |
| `expected` | [`PreparedCallsExpectation`](#preparedcallsexpectation) | What you asked for.                                  |

#### Returns

`void`

#### Throws

A `HardhatPluginError` that names the first check that failed; nothing was signed.
