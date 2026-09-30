# Transactions

Audience: Contributors working on transaction filling and sending.

Status: Planned: M4 (chain-id checks) and M5.

## Transaction filling

The plugin's hook runs before Hardhat's built-in handlers, so it has to fill transactions itself. `rpc/transaction-filler.ts` is a port of Hardhat's built-in fill logic, kept behind a `TransactionFiller` interface and pinned to a Hardhat commit. Building the signed transaction mirrors `LocalAccountsHandler#getSignedTransaction` field for field, using micro-eth-signer `^0.19` (the version Hardhat 3.18 depends on) with `strict=false`. The signed transaction is rebuilt from the verified r, s and yParity, and the code asserts `recoverSender().address === from`.

A differential test guards the port against drift. It sends the same request once with the key as a local account and once through KMS, and requires the same fields and the same unsigned bytes. The test runs against the Hardhat floor (the `^3.18.0` peer) and against `latest`, so a Dependabot bump of Hardhat that changes fill behaviour fails CI.

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

Each `NetworkConnection` has one memoized promise (held in a WeakMap) that reads `eth_chainId`. The plugin resolves it before the first KMS signature of any kind on that connection, and also before the address-pin check. If the network config sets `chainId`, the two must be equal. The check fails closed, and because a failure is never cached, the next request simply tries again.

Hardhat adds its `ChainIdValidator` only to http networks that set a `chainId`, and it validates once per connection, on the first request the built-in handlers see. The fill reads of a transaction pass through it; message and typed-data signing never reach the built-in handlers. This check covers every case.

Two further rules apply:

- Transactions always carry an explicit `chainId`, and `tx.chainId` must equal the connection's chain id.
- Typed data whose `domain.chainId` differs from the connection's chain id is rejected unless `kms.allowCrossChainTypedData` is set.
