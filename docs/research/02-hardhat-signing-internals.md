# Research 02 — Hardhat 3 signing internals

Source: `NomicFoundation/hardhat@738db95`. `NM/` = `packages/hardhat/src/internal/builtin-plugins/network-manager/`, `LG/` = `packages/hardhat-ledger/src/internal/`, `MES/` = micro-eth-signer 0.19.0 sources.

**Headline:** our `onRequest` runs before ALL built-ins, so the plugin must fill every tx field. A KMS signature can't be byte-identical to Hardhat's RFC6979 signature, but the unsigned payload and signing hash can — and with a deterministic fake backend (local key + RFC6979) the whole signed tx must be byte-identical to Hardhat's vectors.

## 1. Order & filled fields

- Built-ins (`NM/request-handlers/handlers-array.ts:33-134`): ChainIdValidator (http+chainId only) → Automatic/FixedGasPrice (all network types) → Automatic/FixedGas → Automatic/FixedSender → LocalAccounts/HDWallet (http only).
- Our hook sees the raw caller request: no gas, fees, nonce; `from` may be missing. viem json-rpc accounts send no gas/fees/nonce; ethers signer sends no gas.
- Ledger only fills nonce + chainId and THROWS if gas/fees missing (`LG/handler.ts:726-768`) — don't copy.
- EDR: no LocalAccountsHandler; EDR signs internally for genesis accounts only → submit `eth_sendRawTransaction`. Only EDR exposes `defaultTransactionGasLimit` / `isBlockGasLimitEnforced`.

Fill order to replicate for KMS senders:

1. `from`: config `from`, else `eth_accounts[0]` (`NM/.../accounts/sender.ts:48-57`, `automatic-sender-handler.ts:36-56`).
2. Fees: fixed `networkConfig.gasPrice`, else `eth_getBlockByNumber` baseFee → `eth_feeHistory("0x1","latest",[50])`, `maxFee = base·9²/8²`, priority = reward, fallback `eth_maxPriorityFeePerGas` then 1 wei; legacy `eth_gasPrice` (`automatic-gas-price-handler.ts:59-226`).
3. Gas: `eth_estimateGas` × `gasMultiplier`, capped below block gas limit, fallback on "execution error" (`multiplied-gas-estimation.ts:48-110`); needs `from` set.
4. Nonce: `eth_getTransactionCount(from, "pending")`.

## 2. Transaction construction (`NM/.../accounts/local-accounts.ts:346-470`)

- Type: `authorizationList` → eip7702; `maxFeePerGas` → eip1559; `accessList` → eip2930; else legacy.
- `Transaction.prepare(..., strict=false)`; `to = addr.addChecksum(hex(to ?? empty), true)` (deploy → "0x"); `chainId: tx.chainId ?? providerChainId`; `value ?? 0n`, `data ?? "0x"`, `gasPrice ?? 0n`; access list / authorization mapping `:362-383`; throws if no `to` and no `data` (`:385-393`). Sign: `signBy(pk,false)` → `toBytes()`.
- EIP-4844 not supported by Hardhat.
- micro-eth-signer 0.19: signing hash = `keccak_256(tx.toBytes(false))` (`calcHash` private); signed = `new Transaction(type, {...unsigned.raw, r, s, yParity}, false)` (as `signBy` does, `tx.ts:280-283`).
- Ledger differs (ignores tx.chainId, no to/data check, rejects 7702, micro-eth-signer ^0.14, default strict=true). Nothing is exported from hardhat; public reusables: `@nomicfoundation/hardhat-zod-utils/rpc` (`rpcTransactionRequest`, `validateParams`), `@nomicfoundation/hardhat-utils` (hex, bytes, bigint, synchronization).
- Plan: copy `#getSignedTransaction` field for field, micro-eth-signer ^0.19, strict=false; DER→low-S→trial parity; assert `recoverSender() === from`.

## 3. Message signing (`local-accounts.ts:119-201`)

- `eth_sign [address, data]`; `personal_sign [data, address]`; both `eip191Signer.sign(bytes)`; digest via `eip191Signer._getHash(bytes)`.
- `eth_signTypedData_v4 [address, data]` (data may be JSON string); digest `keccak(0x19 0x01 ‖ domainSep ‖ structHash)`. micro-eth-signer 0.19 does NOT export the typed-data hash (0.14's `micro-eth-signer/typed-data` `encoder()` does — used by ledger). Alternatives: viem/ox `hashTypedData`. Cross-check with 0.19 `verifyTyped`.
- Response: `0x ‖ r ‖ s ‖ v` with v = 27/28.
- Unknown address: sign/personal_sign/sendTransaction throw NOT_LOCAL_ACCOUNT in core; typed data forwards.
- Not handled by Hardhat: `eth_signTransaction`, `wallet_sendTransaction`, 7702 authorization signing.

## 4. Accounts exposure

- LocalAccountsHandler answers `eth_accounts`/`eth_requestAccounts` with local addresses only (no forward). Ledger forwards then appends its addresses (own only if node errors).
- AutomaticSenderHandler caches `eth_accounts[0]` once (after our hook) → fill `from` ourselves for from-less requests.
- viem caches `eth_accounts` per provider; wallet clients send `chainId`. ethers `getSigners()` calls `eth_accounts` each time; `signMessage` → `personal_sign [hex, addr]`; `signTypedData` → `eth_signTypedData_v4 [addr, JSON]`.

## 5. Test vectors

- `packages/hardhat/test/internal/builtin-plugins/network-manager/request-handlers/handlers/accounts/local-accounts.ts`: legacy raw tx `:537-541`, EIP-2930 `:20-26`, EIP-7702 `:576-618`, eth_sign `:144-219`, EIP-712 `:254-313`, personal_sign `:413-455` (mocked provider, chainId 123 via net_version).
- Full-chain e2e harness: `.../request-handlers/e2e.ts` + `hooks-mock.ts:23-69`.
- Ledger: `packages/hardhat-ledger/test/internal/handler.ts:736-1030`.
- Equivalence: Mode A (fake backend with the test key, RFC6979 `micro-eth-signer/utils.js sign(hash, pk, false)`) → byte-identical to vectors; Mode B (real KMS) → identical unsigned bytes + recovers to `from`.

## 6. Pitfalls

- Recursion via `provider.request` (pass internal methods through or guard). Call `next` exactly once.
- Concurrency: nonce from "pending" without lock in core and ledger; KMS latency widens the race → per-address `AsyncMutex` across nonce→sign→send.
- chainId: assert `tx.chainId === eth_chainId`.
- Built-ins mutate requests in place (issue #8090) → clone.
- Cleanup in `closeConnection` (WeakMap entry, KMS clients).
- EDR funding: `hardhat_setBalance` for KMS addresses.

## Proposed request flow

```
onRequest(ctx, conn, req, next):
  no KMS accounts                         -> next(req)
  passthrough (eth_chainId, eth_getTransactionCount, eth_estimateGas, eth_feeHistory,
    eth_getBlockByNumber, eth_gasPrice, eth_maxPriorityFeePerGas, eth_sendRawTransaction) -> next(req)
  eth_accounts / eth_requestAccounts      -> [...next(req).result, ...kmsAddrs] (own only on error)
  eth_sign / personal_sign / eth_signTypedData_v4 (addr ∈ KMS) -> digest -> KMS -> lowS + parity -> r‖s‖(1b|1c)
  eth_sendTransaction (from ∈ KMS)        -> lock(from): fill fees, gas, nonce, chainId; prepare; sign; verify;
                                             next(eth_sendRawTransaction)
  otherwise                               -> next(req)
closeConnection: drop state, close clients, next()
```
