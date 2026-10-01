# Transactions

Audience: Contributors working on transaction filling and sending.

Status: The chain-id checks for typed data shipped in M4, and transaction filling in M5 ([#23](https://github.com/aelmanaa/hardhat-kms/issues/23)). Signing and sending transactions, nonces and the send lock are planned for M5.

## Transaction filling

The plugin's hook runs before Hardhat's built-in handlers, so it has to fill transactions itself. `packages/hardhat-kms/src/internal/rpc/transaction-filler.ts` ports the fill logic of Hardhat 3.18.0 behind a `TransactionFiller` interface, one filler per connection. Its reads go through `connection.provider`, so they pass through the hook chain to Hardhat's built-in handlers, which fill `from` on `eth_estimateGas` like on any other request. The filler treats `eth_sendTransaction` and `eth_signTransaction` alike. Hardhat fills only `eth_sendTransaction`, and its local accounts do not sign `eth_signTransaction`.

### Ported steps

The filler runs Hardhat's steps in Hardhat's order. The sources are under `hardhat/dist/src/internal/builtin-plugins/network-manager/request-handlers/handlers/`.

1. Fees, from `gas/automatic-gas-price-handler.js` and `gas/fixed-gas-price-handler.js`. With `gasPrice: "auto"`, a request that has `gasPrice` or both EIP-1559 fields is left alone. Otherwise the filler reads the latest block once per connection to learn whether the node has a base fee, then calls `eth_feeHistory ["0x1", "latest", [50]]`. The priority fee is the median reward; if that is 0, the answer of `eth_maxPriorityFeePerGas`; if that fails or is 0 too, 1 wei. `maxFeePerGas` is the last base fee times 81/64, plus the priority fee when it would be lower than the priority fee. When `eth_feeHistory` fails (remembered per connection), a request without EIP-1559 fields gets a legacy `gasPrice` from `eth_gasPrice`, and a request with one of them gets the gas price for both defaults. A fixed `gasPrice` is set only on a request with no fee field.
2. Gas, from `gas/automatic-gas-handler.js`, `gas/multiplied-gas-estimation.js` and `gas/fixed-gas-handler.js`. With `gas: "auto"`, the filler calls `eth_estimateGas` with the request's params after step 1. A `gasMultiplier` other than 1 multiplies the estimate, capped at 95% of the latest block's gas limit (read once) minus 1. If an internal call runs out of gas and the provider exposes a default gas limit, which only in-process simulated networks do, that limit is used, capped to the pending block's limit when the network enforces one. An error whose message contains "execution error" gives the capped block gas limit. Other errors reach the caller.
3. Checks, from `accounts/local-accounts.js` (`#modifyRequest`). The filler validates the request with `rpcTransactionRequest` from `@nomicfoundation/hardhat-zod-utils/rpc` and refuses what Hardhat refuses: no fee field, `gasPrice` with an EIP-1559 field, `gasPrice` with `authorizationList`, or only one EIP-1559 field.
4. Chain id. The filler reads the connection's `ConnectionChain`, and a request's own `chainId` must equal it (see [Chain-id checks](#chain-id-checks)). Hardhat signs whatever `chainId` the request names.
5. Nonce, from `accounts/local-accounts.js` (`#getNonce`): `eth_getTransactionCount [from, "pending"]` when the request has none.

`buildUnsignedTransaction` mirrors `LocalAccountsHandler#getSignedTransaction` field for field, with micro-eth-signer `^0.19` (the version Hardhat 3.18 depends on) and strict mode off. The fields decide the type: `authorizationList` gives EIP-7702, `maxFeePerGas` EIP-1559, `accessList` EIP-2930, and anything else legacy. `signingHash` returns the digest that `Transaction#signBy` signs. Signing, rebuilding the signed transaction from the verified r, s and yParity, and the `recoverSender().address === from` check come with sending ([#24](https://github.com/aelmanaa/hardhat-kms/issues/24)).

### Deliberate differences

- Blob transactions (`blobs` or `blobVersionedHashes`) are refused before any request. Hardhat's local accounts drop those fields and sign a transaction of another type.
- Hardhat recognises the out-of-gas estimation failure with `instanceof InternalCallOutOfGasError`, a class it does not export. The filler accepts an error with JSON-RPC code -32000 whose name is `InternalCallOutOfGasError` or whose `data.reason` is `InternalCallOutOfGas`, the marker Hardhat also sends over HTTP. Either one is enough, so renaming the class or the marker alone does not break the fallback.
- The chain id comes from `eth_chainId` only. Hardhat falls back to `net_version` when `eth_chainId` fails. `eth_chainId` is standard since EIP-695, and `net_version` returns a network id, which can differ from the chain id. A wrong chain id would sign for another chain, so the filler fails instead.
- The filler's caches (EIP-1559 support, `eth_feeHistory` support, the capped block gas limit) are its own, separate from those of Hardhat's handlers on the same connection. After `evm_setBlockGasLimit`, a local account and a KMS account can therefore get different multiplier caps until the connection is recreated.
- Refused requests fail with `kmsError` messages, not with Hardhat's `MISSING_FEE_PRICE_FIELDS` or `INCOMPATIBLE_*` error codes.

Hardhat counts only a string `maxFeePerGas` or `maxPriorityFeePerGas` as the caller's value and replaces any other value, such as a bigint, with its suggestion. The filler does the same, so both fill a request identically.

### Differential test

`packages/hardhat-kms/test/integration/transaction-filler.test.ts` guards the port against drift. It starts a simulated node behind a JSON-RPC server that records raw transactions instead of running them, so the chain state is the same for both fills. On an http network with the key as a local account, Hardhat fills and signs the request, and the plugin's filler then fills the same request on the same connection. The test requires the same type, fields, unsigned bytes and signing hash for: EIP-1559 with automatic fees, legacy, EIP-2930, contract creations with and without `to: null`, EIP-7702, a caller's nonce, value and chain id, a single EIP-1559 field, gas multipliers with and without the block gas limit cap, a fixed gas and gas price, a node without a base fee, a failing `eth_feeHistory`, an estimate with an execution error, and two sends on one connection. Where Hardhat refuses a request (an EIP-1559 field on a pre-London node, a reverting contract creation), the plugin must fail with the same message.

The test runs against the Hardhat version in `pnpm-lock.yaml`, which today is also the `^3.18.0` floor, so a Dependabot bump of Hardhat that changes fill behaviour fails CI. A separate run against the floor is needed once the two differ.

The long-term plan is to delete the port once Hardhat exports a filler or a post-fill signing stage (see [Roadmap](roadmap.md#roadmap)).

## Nonces and the send lock

The nonce for a KMS send is `max(pending, highWater + 1)`. The high-water mark is keyed by (connection, from):

- After a send, `hw = max(hw, usedNonce)`.
- A nonce supplied by the caller (Ignition does this) is always honoured, and sets `hw = max(hw, nonce)`.
- On `edr-simulated` networks the high-water mark is disabled, because the in-process pending count is authoritative there.

The lock stays process-global on `chainId:from`, so parallel sends from one process get consecutive nonces.

Separate processes are not coordinated. Two `hardhat run` invocations sending from the same KMS key at the same time can collide on a nonce, and the docs say so.

## Retries after broadcast

A send cannot be repeated blindly, because the transaction may already be on its way. The plugin handles failures after `next(eth_sendRawTransaction)` like this:

- Every failure after the broadcast call returns JSON-RPC error code -32000, which viem does not retry. The error carries the local transaction hash so the caller can look it up.
- A narrow cache covers clients that retry anyway. An entry is created only in that post-broadcast failure path, keyed by (connection, chainId, from, canonical JSON of the caller's params). It lives for 120 s and is consumed on the first hit. A retried identical request that hits it re-submits the same raw bytes (same hash), treats "already known" as success, and returns the same hash.
- Successful sends are never recorded. A deliberate duplicate send is therefore never dropped.
- The code never re-enters fill and sign after a broadcast.

A hardhat-viem test over HTTP injects a timeout on the broadcast and proves there is no double broadcast.

## Chain-id checks

Each `NetworkConnection` has one `ConnectionChain` (`packages/hardhat-kms/src/internal/rpc/chain-id.ts`, held in a WeakMap) that reads `eth_chainId` once. If the network config sets `chainId`, the two must be equal. The check fails closed, and because a failure is never kept, the next request tries again. Typed data that names a chain reads it now ([decision 0011](decisions/0011-typed-data-chain-check.md)); transactions will in M5. Messages do not: the chain is not part of their signature, and they sign without a reachable node.

Hardhat adds its `ChainIdValidator` only to http networks that set a `chainId`, and it validates once per connection, on the first request the built-in handlers see. The fill reads of a transaction pass through it; message and typed-data signing never reach the built-in handlers. This check covers every case.

Two further rules apply:

- Transactions always carry an explicit `chainId`, and `tx.chainId` must equal the connection's chain id.
- Typed data whose `domain.chainId` differs from the connection's chain id is rejected unless `kms.allowCrossChainTypedData` is set. Typed data without `domain.chainId` is signed ([decision 0011](decisions/0011-typed-data-chain-check.md)).
