# Transactions

Audience: Contributors working on transaction filling and sending.

Status: The chain-id checks for typed data shipped in M4. M5 adds transaction filling ([#23](https://github.com/aelmanaa/hardhat-kms/issues/23)) signing and sending ([#24](https://github.com/aelmanaa/hardhat-kms/issues/24)), and the send lock, the nonce high-water mark and retries after broadcast ([#25](https://github.com/aelmanaa/hardhat-kms/issues/25)).

## Transaction filling

The plugin's hook runs before Hardhat's built-in handlers, so it has to fill transactions itself. `packages/hardhat-kms/src/internal/rpc/transaction-filler.ts` ports the fill logic of Hardhat 3.18.0 behind a `TransactionFiller` interface, one filler per connection. Its reads go through `connection.provider`, so they pass through the hook chain to Hardhat's built-in handlers, which fill `from` on `eth_estimateGas` like on any other request. The filler treats `eth_sendTransaction` and `eth_signTransaction` alike. Hardhat fills only `eth_sendTransaction`, and its local accounts do not sign `eth_signTransaction`.

### Ported steps

The filler runs Hardhat's steps in Hardhat's order. The sources are under `hardhat/dist/src/internal/builtin-plugins/network-manager/request-handlers/handlers/`.

1. Fees, from `gas/automatic-gas-price-handler.js` and `gas/fixed-gas-price-handler.js`. With `gasPrice: "auto"`, a request that has `gasPrice` or both EIP-1559 fields is left alone. Otherwise the filler reads the latest block once per connection to learn whether the node has a base fee, then calls `eth_feeHistory ["0x1", "latest", [50]]`. The priority fee is the median reward; if that is 0, the answer of `eth_maxPriorityFeePerGas`; if that fails or is 0 too, 1 wei. `maxFeePerGas` is the last base fee times 81/64, plus the priority fee when it would be lower than the priority fee. When `eth_feeHistory` fails (remembered per connection), a request without EIP-1559 fields gets a legacy `gasPrice` from `eth_gasPrice`, and a request with one of them gets the gas price for both defaults. A fixed `gasPrice` is set only on a request with no fee field.
2. Gas, from `gas/automatic-gas-handler.js`, `gas/multiplied-gas-estimation.js` and `gas/fixed-gas-handler.js`. With `gas: "auto"`, the filler calls `eth_estimateGas` with the request's params after step 1. A `gasMultiplier` other than 1 multiplies the estimate, capped at 95% of the latest block's gas limit (read once) minus 1. If an internal call runs out of gas and the provider exposes a default gas limit, which only in-process simulated networks do, that limit is used, capped to the pending block's limit when the network enforces one. An error whose message contains "execution error" gives the capped block gas limit. Other errors reach the caller.
3. Checks, from `accounts/local-accounts.js` (`#modifyRequest`). The filler validates the request with `rpcTransactionRequest` from `@nomicfoundation/hardhat-zod-utils/rpc` and refuses what Hardhat refuses: no fee field, `gasPrice` with an EIP-1559 field, `gasPrice` with `authorizationList`, or only one EIP-1559 field. The filler differs in one place (#140). Before step 1, it rewrites an authorization's `r` and `s` on its copy as JSON-RPC quantities, the execution APIs' `uint256` form that geth requires, whether the caller sent a quantity (as viem does) or 32 bytes, and refuses a value outside [1, n - 1] before any request to the node. The schema's `rpcHash` accepts only 32 bytes, so validation, and through it signing, gets a copy with `r` and `s` left-padded to 32 bytes. Hardhat's local accounts accept only 32 bytes, and forward the caller's form to `eth_estimateGas`.
4. Chain id. The filler reads the connection's `ConnectionChain`, and a request's own `chainId` must equal it (see [Chain-id checks](#chain-id-checks)). Hardhat signs whatever `chainId` the request names.
5. Nonce, from `accounts/local-accounts.js` (`#getNonce`): `eth_getTransactionCount [from, "pending"]` when the request has none.

`buildUnsignedTransaction` mirrors `LocalAccountsHandler#getSignedTransaction` field for field, with micro-eth-signer `^0.19` (the version Hardhat 3.18 depends on) and strict mode off. The fields decide the type: `authorizationList` gives EIP-7702, `maxFeePerGas` EIP-1559, `accessList` EIP-2930, and anything else legacy. `signingHash` returns the digest that `Transaction#signBy` signs.

## Signing and sending

The network hook (`packages/hardhat-kms/src/internal/hook-handlers/network.ts`) creates one `TransactionFiller` per connection, on the connection's first KMS transaction, and keeps it in a WeakMap next to the connection's `ConnectionChain`. Closing the connection drops it. One filler per connection keeps the caches Hardhat's handlers keep per connection; a filler per request would read the block gas limit on every multiplied estimate.

For `eth_sendTransaction` and `eth_signTransaction`, the dispatcher (`packages/hardhat-kms/src/internal/rpc/dispatcher.ts`) resolves the sender and its key, then `signTransaction` in `packages/hardhat-kms/src/internal/rpc/transactions.ts` runs inside `ConnectionAccounts.signWith`, so the idle close waits for it:

1. Fill the request with the connection's filler, and build the unsigned transaction with `buildUnsignedTransaction`.
2. Lint the pre-signed EIP-7702 authorizations (see below).
3. Sign `signingHash(unsigned)` with `KmsSigner.signDigest`, which returns a low-S signature verified against the key ([decision 0004](decisions/0004-verify-every-signature.md)).
4. Rebuild the transaction as `Transaction#signBy` does: `new Transaction(unsigned.type, { ...unsigned.raw, r, s, yParity }, false)`.
5. Require `recoverSender().address` to equal `from`. A mismatch, or a signature micro-eth-signer cannot recover, fails with an error and nothing is sent. The signer has already verified the signature against the key, so this check covers the step from signature to transaction.

`eth_signTransaction` returns the raw hex. The `kms sign-tx` task calls the same `signTransaction` with a filler of its own on the `--network` connection, built by the same `createTransactionFiller` and `createConnectionChain` (see [Tasks](architecture.md#tasks)), so its bytes equal those of `eth_signTransaction`. `eth_sendTransaction` replaces the request with `eth_sendRawTransaction` and the raw hex, and calls `next` once, as Hardhat's local accounts do, under the send lock described in [Nonces and the send lock](#nonces-and-the-send-lock).

### Sender resolution

Hardhat's sender handlers run after the plugin's hook. Without help, a transaction without `from` on an http network without local accounts would get a KMS address from Hardhat's `AutomaticSenderHandler` (its `eth_accounts` call goes through the hook) and reach the node unsigned. The plugin therefore resolves the sender first, the way Hardhat would:

- The network's `from`, as `FixedSenderHandler` does.
- Otherwise the first address of `eth_accounts`, sent through `connection.provider`, so the plugin's own order applies, as `AutomaticSenderHandler` sees it.

The plugin sets `from` to that sender and signs when it is a KMS account. Otherwise the request goes on with `from` set, so Hardhat's sender handlers do nothing. Passing it on without `from` is not safe: `AutomaticSenderHandler` reads `eth_accounts` once per connection and keeps the first address, while the plugin reads it on each request. If the two answers differ, for example because `eth_accounts` failed downstream once and the plugin listed only the KMS addresses, Hardhat would fill a KMS address the plugin did not choose, and the node would get an unsigned KMS transaction. Without a sender (an empty list, or an answer that is not a list), the request goes on unchanged and Hardhat reports the error.

Hardhat fills `from` only for `eth_sendTransaction`; the plugin also does it for `eth_signTransaction`, since its filler treats both alike.

### Copies

Before its first `await`, the dispatcher reads `from` from the caller's transaction and copies the transaction and the other params with `structuredClone`; the filler copies them again. A caller that changes the transaction object, including its access or authorization list, while the request runs cannot change what is signed. `signTransaction` also checks that the filled transaction's `from` is the KMS account it signs for.

When the copy fails, the dispatcher resolves the sender first (the `from` it read, or the default sender). A KMS sender gets the `the transaction must be plain data` error and nothing is sent. Any other sender's request passes on as it came, following rule 1; without `from`, the default sender is set on a shallow copy of the caller's transaction, so Hardhat's sender handlers still choose nothing. A first param that is not an object passes on without any copy.

### EIP-7702 authorization lint

The RPC path signs only transactions whose `authorizationList` entries are already signed; Hardhat's request schema requires the signature fields. When the sender is a KMS account, `lintAuthorizations` checks each tuple: its `s` must be in the lower half of the curve order, and a public key must recover from its signature over `keccak256(0x05 || rlp([chainId, address, nonce]))` (`authorizationDigest` in `packages/hardhat-kms/src/internal/crypto/digests.ts`). A failing tuple prints a warning through `packages/hardhat-kms/src/internal/warnings.ts`, the plugin's one `console.warn`, and the transaction is still signed. EIP-7702 nodes accept such a transaction and skip the authorization, so an error would block a transaction the chain accepts.

### Byte-identical test

`packages/hardhat-kms/test/integration/sign-transactions.test.ts` runs the recording node of the differential test (`packages/hardhat-kms/test/helpers/recording-node.ts`). A fake adapter holds Hardhat's account-0 key and signs deterministically (RFC 6979), as Hardhat's local accounts do. For legacy, EIP-2930, EIP-1559 with automatic fees, a contract creation and EIP-7702 with a pre-signed tuple, the raw transaction the plugin sends must equal the one Hardhat sends from a local account, also when the adapter returns high-S signatures. `eth_signTransaction` must return the same bytes and broadcast nothing. `packages/hardhat-kms-aws/test/integration/network.test.ts` signs an `eth_signTransaction` through the real AWS SDK against a local KMS server and compares it with Hardhat's bytes.

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

The send guard lives in `packages/hardhat-kms/src/internal/rpc/send-guard.ts`: `withSendLock`, and `ConnectionSends`, which holds a connection's high-water marks, retry entries and uncertain transactions. The network hook creates one `ConnectionSends` per connection, on its first send, and closes it when the connection closes; a closed one remembers nothing more.

An `eth_sendTransaction` from KMS address `a` on chain `c` runs `withSendLock("c:a", ...)`. The lock is a process-global queue per key: holders of one key run one after the other, in arrival order, and other keys never wait. Inside the lock, `sendTransaction` in the dispatcher:

1. Takes a retry entry for the request, if one is alive (see [Retries after broadcast](#retries-after-broadcast)), and sends its bytes again.
2. Otherwise, for a send without the caller's nonce, looks up the sender's uncertain transaction, if there is one (see below).
3. Fills and signs inside `ConnectionAccounts.signWith`. The fill's reads go through `connection.provider` and pass through the hook (rule 1), so they never wait on the lock.
4. Calls `next(eth_sendRawTransaction)` once, after `signWith` has returned. The signer cache's idle close therefore waits on KMS calls only, never on the node.

The lock bounds the wait for it, not the work of its holder. Three limits apply, and none of their failures signs or sends anything. Each error names the address and the chain id, never the key:

- **Re-entrant sends fail at once.** `withSendLock` records each hold in an `AsyncLocalStorage` store, and the holder's `run` executes inside it. A request for a key that the current async context still holds fails before it joins the queue. Such a request comes from code that runs inside the holder, for example another plugin's network hook during the fill or the broadcast, and it would wait for itself. The store survives `await` and timers, on the Node 22.13 floor too. Code that the holder starts inherits the store, whether or not the holder awaits it, so a send from a listener that the holder triggers (`EventEmitter.emit`, `setImmediate`, `queueMicrotask`) also fails at once while the hold lasts; left uncaught, that rejection ends the process. A hold counts only until it is released, so such work that starts its send after the holder is done is queued as usual. On Node 22, the first `AsyncLocalStorage.run` turns on promise hooks for the whole process, a small overhead on every promise; Node 24's `AsyncContextFrame` does not pay it. The same account on another chain, and another account, are other keys and do not fail.
- **A waiter fails after 120 s without progress** (`SEND_LOCK_STALL_MS`). Progress is the lock passing to the next holder; each pass starts every waiter's 120 s again, so a queue that moves never trips it. A waiter that fails leaves the queue, and the others keep their order. A holder that hangs therefore keeps the lock until the network timeout below, but the sends behind it fail after 120 s, unsigned and unsent; a slow RPC endpoint can trigger this.
- **At most 1024 waiters per key** (`MAX_SEND_LOCK_WAITERS`); the holder does not count. The next send fails at once.

The holder itself has no deadline. Its KMS calls stop at `timeoutMs`, and its broadcast stops at Hardhat's network timeout (the http network's `timeout`, 300 s by default). A deadline that fired during the broadcast could not say whether the transaction went out. The two numeric limits are constants, and are not configurable in 1.0. The timers come from the `Timers` seam, so the unit tests drive them with a fake clock.

The nonce for a KMS send whose caller gave none is `max(pending, highWater + 1)`, where `pending` is the filler's `eth_getTransactionCount [from, "pending"]`. `signTransaction` takes the choice as `chooseNonce`, applied after the fill. The high-water mark is keyed by (connection, from):

- After a send, `hw = max(hw, usedNonce)`.
- A nonce supplied by the caller (Ignition does this) is always honoured, and sets `hw = max(hw, nonce)`.
- On `edr-simulated` networks the high-water mark is disabled, because the in-process pending count is authoritative there.

"After a send" means once the node is known to have the transaction: it answered with a result; it answered with an error that carries the transaction hash, as Hardhat's nodes do for a transaction they mined and that reverted; or it answered "already known" to a retry's bytes. A failure before the broadcast (fill, KMS or the sender check) leaves the mark as it was, so the next send gets the same nonce. So does a node's refusal, such as "nonce too low" or "insufficient funds".

When the outcome is uncertain (no answer, or a gateway's "I don't know"; see [Retries after broadcast](#retries-after-broadcast)), the node may or may not have the transaction, and the mark does not move. If it moved and the node never got the transaction, every later send from that connection would leave a nonce gap and wait in the node's queue without an error. Leaving the mark has its own risk: if the node did get the transaction and its pending count lags, the next send could get the same nonce, and with fees about 10% higher a Geth node accepts it as a replacement and silently drops the first transaction. The plugin therefore keeps the transaction (hash and nonce) as the sender's uncertain transaction on that connection. The sender's next send without the caller's nonce asks the node with `eth_getTransactionByHash`, inside the lock. If the node has the transaction, the mark rises to its nonce. If it does not, or the lookup fails, the node's pending count decides as usual, and the transaction's retry entry is dropped too: this send may take its nonce, and a later retry of the first request must not send bytes that could replace it, so that retry is filled and signed afresh. Either way the uncertain transaction is forgotten. A definite answer to a retry of its bytes (accepted, "already known", or a refusal) forgets it as well; another uncertain answer to that retry keeps it. A send with the caller's nonce does not look it up; the caller chose the nonce.

The retry path has its own guard. Before a retry entry's bytes go out again, the plugin compares their nonce with the high-water mark. If a later send has used that nonce or a higher one, the bytes are sent again only if the node has them, in which case the request returns their hash without a broadcast; otherwise the request is filled and signed afresh.

The lookup has limits. Behind a load balancer it can reach the same lagging backend that miscounted the pending nonce, and get no transaction. The record is also dropped after one lookup, so a transaction that reaches the node only after that lookup is not found again. Both cases fall back to the node's pending count, as before the lookup existed.

Each sender has one uncertain record per connection, and a newer uncertain transaction replaces it. Sends with the caller's nonce never look it up, so in a narrow case one is overwritten unchecked: an uncertain send without the caller's nonce, then an uncertain send with one, then a send without one. That last send looks up only the second transaction. The design accepts this; it needs two failures without an answer and mixed nonce styles from one sender.

The mark is per connection, as specified, and the lock is per chain. Two connections in one process to the same chain therefore wait for each other, but each keeps its own mark. A process-global mark would carry nonces from one node to another node with the same chain id, such as two local nodes on chain 31337, and leave gaps there.

Nothing refuses a nonce that was already sent. Hardhat Ignition (ignition-core 3.1.9) sends with an explicit nonce from its own nonce manager and, for a stuck transaction, sends the same nonce again with higher fees, up to `maxFeeBumps` times. Each such replacement has other params, so it gets no retry entry: it is filled, signed and broadcast like any send, with the caller's nonce. Tests in `send-lock.test.ts` (unit and integration) send same-nonce replacements, including one after a failed broadcast.

`eth_signTransaction` takes no lock and never reads or moves the mark (rule 5). It signs the filled nonce.

Separate processes are not coordinated. Two `hardhat run` invocations sending from the same KMS key at the same time can collide on a nonce, and the [RPC methods reference](../user/reference/rpc-methods.md#parallel-sends-and-failed-broadcasts) says so.

## Retries after broadcast

A send cannot be repeated blindly, because the transaction may already be on its way. `broadcast` in the dispatcher sorts what `next(eth_sendRawTransaction)` gives back into four outcomes:

- Accepted: the node answers with a result, which is returned as it is.
- Not sent: Hardhat's `HardhatError` HHE703 (`CONNECTION_REFUSED`), recognised with `HardhatError.isHardhatError`. The request never reached the node. Hardhat's error is rethrown unchanged, with no transaction hash, no retry entry and no uncertain record, so Ignition does not track a hash that was never sent.
- Answered: a JSON-RPC error answer, or a thrown error whose `code` is a number other than -1. Hardhat's EDR throws rather than answering, so the outcome is decided by the error's shape: `ProviderError` and its subclasses carry `code`, and so does `SolidityError` (code 3) for a transaction that was mined and reverted. The answer is returned, or the same error object rethrown, unchanged. A revert therefore keeps its data and `transactionHash`, which revert assertions and Ignition rely on. If the error carries a `transactionHash` (on the error, or in its `data`), the nonce counts as used. Within this outcome:
  - A gateway's "I don't know" (`isUncertainAnswer`): code -32603, or a message matching `/\btimed? ?out\b|deadline exceeded/i`. A gateway that forwarded the transaction and gave up waiting for its backend answers like this, and the backend may have taken the transaction. The answer is still passed on unchanged, but the transaction gets a retry entry and an uncertain record, as for no answer. An answer that carries a `transactionHash`, a revert (code 3), or a message that starts with "execution reverted" or "revert" is never treated this way, even when its reason mentions a timeout ("execution reverted: Deadline exceeded").
  - A revert (code 3) without a hash, for bytes sent again: the node may be refusing the nonce because the first send of those bytes was mined. The node is asked with `eth_getTransactionByHash`; if it has the transaction, the request succeeds with its hash.
  - Any other answer is a refusal, such as "fee below the base fee" or "nonce too low", and nothing is kept, so later requests do not resend refused bytes.
- No answer: any other thrown error. That is Hardhat's `HardhatError` HHE704 (`NETWORK_TIMEOUT`), which has no `code`; its `UnknownError` (code -1), which wraps an HTTP 4xx or 5xx status or a transport failure; or anything else. The plugin throws `SendOutcomeUnknownError`, a `HardhatPluginError` with `code` -32000, the generic JSON-RPC server error, so clients read it as an RPC error and not as an unknown (-1) or internal (-32603) error, which some retry layers repeat. It carries the transaction hash in `transactionHash`, in `data.hash` and in its message, so the caller can look it up. The message names the thrown error's class only, because a transport error's text can contain the node's URL and its API key. viem never retries a send whatever the code: it calls `eth_sendTransaction` and `eth_sendRawTransaction` with `retryCount: 0`.

How each failure shape is classified:

| What happens                                 | What `next` gives back                                   | Outcome                           |
| -------------------------------------------- | -------------------------------------------------------- | --------------------------------- |
| EDR refuses or reverts                       | throws `ProviderError` or `SolidityError` (numeric code) | answered: passed on               |
| An http node refuses                         | returns a JSON-RPC error answer                          | answered: passed on               |
| HTTP 429 after Hardhat's own retries         | throws `LimitExceededError` (-32005)                     | answered: passed on               |
| HTTP 4xx or 5xx, or a transport failure      | throws `UnknownError` (-1)                               | no answer: -32000, retry entry    |
| The connection is refused                    | throws `HardhatError` HHE703                             | not sent: rethrown, nothing kept  |
| Hardhat's network timeout                    | throws `HardhatError` HHE704                             | no answer: -32000, retry entry    |
| A gateway answers that its backend timed out | returns or throws -32603, or a timeout message           | uncertain: passed on, retry entry |

The design first wrapped every failure after the broadcast in a -32000 error. Review found that this hid the revert data and transaction hash of a mined transaction and made later identical requests resend refused bytes, so a node's answer is now passed through.

Hardhat builds a `ProviderError` from a JSON-RPC error answer with only `code`, `message` and `data`, so an answer cannot carry `transactionHash`. That is why the no-answer outcome is thrown, as the plugin's own error class, rather than returned as an answer. Ignition (ignition-core 3.1.9, `jsonrpc-client.js`) reads `error.transactionHash` after a failed `eth_sendTransaction` and then tracks that hash as a sent transaction, which is what an uncertain send needs. A gateway's "I don't know" answer is passed on unchanged and so carries no `transactionHash`.

A narrow cache covers clients that retry anyway. An entry is created only for an uncertain outcome (no answer, or a gateway's "I don't know"), keyed by (connection, chainId, from, canonical JSON of the caller's params). It lives for 120 s and is consumed on the first hit. A retried identical request that hits it re-submits the same raw bytes (same hash), treats "already known" as success, and returns the same hash. Successful sends are never recorded, so a deliberate duplicate send is never dropped. The code never re-enters fill and sign after a broadcast.

How the implementation reads the parts the design leaves open:

- The caller's params are the request's params as the caller sent them, copied before the first `await`, without the `from` the plugin may add. A request without `from` and the same request with the default sender as `from` therefore get different keys; both resolve to the same sender, so the only cost is a missed retry.
- `canonicalJson` sorts object keys and keeps every value's type: a string is quoted, a bigint is written as `1n` and bytes as `bytes(<hex>)`, so values of different types never share a key. A key whose value is `undefined` counts as absent, as it does for the filler. Params holding anything else (a `Date`, a `Map`, a number that is not finite) get no entry, so such a request is never re-sent, only signed again.
- "Already known" is what clients say at the start of the message: `already known` (Geth, Reth, Erigon), `AlreadyKnown` (Nethermind) or `known transaction` (older Geth, and EDR as `Known transaction: <hash>`), in any case. "unknown transaction type" does not match. It counts as success only when bytes are sent again; on a first send it is passed through like any other answer.
- When a retry's bytes get no answer again, a new entry with the same bytes is created, with a new 120 s lifetime; so does a refused connection, since the first send's outcome is still unknown. When they get a refusal such as "nonce too low", the node is first asked with `eth_getTransactionByHash`, inside the lock, whether it has the transaction: the first send may have gone through, which is what makes the node refuse the same bytes now. If it has, the request succeeds with the hash and the nonce counts as used. Otherwise the refusal is passed through and no entry is left, so the next identical request is filled and signed again.
- A new entry for a key replaces the old one. A connection keeps at most 256 entries; a new one beyond that drops the oldest and cancels its timer. Closing the connection drops its entries and cancels their timers. The timers come from the network hook's `Timers`, which are unref'd, so an entry never keeps the process alive.

`packages/hardhat-kms/test/integration/send-lock.test.ts` covers these end to end:

- With hardhat-viem over HTTP, the recording node accepts the transaction and answers after the client's timeout. viem reports the -32000 error and the node receives the transaction once.
- The same request then sends the same bytes again without a new KMS signature.
- A node's refusal comes back unchanged and leaves no entry.
- A reverted contract creation on a simulated network throws Hardhat's `SolidityError` with code 3, the revert data and the transaction hash, as for a local account. The next identical request is signed again and gets the next nonce.
- 10 transactions sent in parallel from each of two accounts on a simulated network, with an `eth_signTransaction` among them, get nonces 0 to 9 for each.

`packages/hardhat-kms/test/unit/rpc/send-lock.test.ts` drives the network hook with a fake node, fake KMS adapters and fake timers: the high-water mark, uncertain transactions, the lock across accounts, the idle close during a broadcast, and the retry cache.

## Chain-id checks

Each `NetworkConnection` has one `ConnectionChain` (`packages/hardhat-kms/src/internal/rpc/chain-id.ts`, held in a WeakMap) that reads `eth_chainId` once. If the network config sets `chainId`, the two must be equal. The check fails closed, and because a failure is never kept, the next request tries again. Typed data that names a chain reads it ([decision 0011](decisions/0011-typed-data-chain-check.md)), and so does every transaction from a KMS account. Messages do not: the chain is not part of their signature, and they sign without a reachable node.

Hardhat adds its `ChainIdValidator` only to http networks that set a `chainId`, and it validates once per connection, on the first request the built-in handlers see. The fill reads of a transaction pass through it; message and typed-data signing never reach the built-in handlers. This check covers every case.

Two further rules apply:

- Transactions always carry an explicit `chainId`, and `tx.chainId` must equal the connection's chain id.
- Typed data whose `domain.chainId` differs from the connection's chain id is rejected unless `kms.allowCrossChainTypedData` is set. Typed data without `domain.chainId` is signed ([decision 0011](decisions/0011-typed-data-chain-check.md)).
