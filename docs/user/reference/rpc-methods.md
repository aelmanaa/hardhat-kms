---
title: RPC methods reference
description: Which JSON-RPC methods hardhat-kms answers for KMS accounts, which it passes to the node, and which transaction types it signs.
---

# RPC methods reference

Audience: Users and library authors who want to know which JSON-RPC calls the plugin handles.

## RPC behaviour

The plugin installs a network hook on every connection. On a connection whose network has no `kmsAccounts`, it passes every request through. Otherwise it behaves as follows:

- `eth_accounts` and `eth_requestAccounts` return the network's own accounts followed by the KMS addresses, without duplicates. `eth_requestAccounts` is passed on as `eth_accounts`, as Hardhat's local accounts do, since many nodes implement only that. If the downstream call fails, only the KMS addresses are returned.
- A KMS address comes from the `address` pin when one is set, with no KMS call. Otherwise it comes from a public-key lookup, run in parallel across keys on first use. A failed lookup is not cached; the next request retries it. Two keys that resolve to the same address are an error: `<key> and <key> are the same account (<address>); list each key once`.
- Five signing methods are intercepted, but only when the address is a KMS account: `eth_sendTransaction`, `eth_signTransaction`, `eth_sign`, `personal_sign` and `eth_signTypedData_v4`.
- `eth_sign` (`[address, data]`) and `personal_sign` (`[data, address]`) use EIP-191 with the message prefix, the same semantics as Hardhat core. Their params are checked with Hardhat's own validators: data must be strict hex (`0x` and an even number of digits).
- `eth_signTypedData_v4` (`[address, typedData]`) accepts the typed data as an object or a JSON string. Its shape is checked before any KMS call. When `domain.chainId` is set, it must equal the connection's chain (read with `eth_chainId`) unless `kms.allowCrossChainTypedData` is `true`, and a mismatch fails before any KMS signing call. A number, bigint, hex string with a lowercase `0x` prefix or decimal string is accepted, and `0` is checked like any other value. Typed data without `domain.chainId` is signed, as MetaMask, Hardhat and Foundry do; its signature is valid on every chain.
- `eth_sendTransaction` fills the same fields as Hardhat does for a local account (fees, gas, nonce, chain id), signs the transaction with the KMS key and sends it to the node as `eth_sendRawTransaction`. It returns the transaction hash. The nonce can be higher than a local account's, since the plugin also counts the nonces the node accepted on the same connection and those held by library accounts ([Which nonce a send gets](#which-nonce-a-send-gets)). The signature bytes can differ from a local account's for the same request, and so can the transaction hash ([Every signature is verified](../explanation/security-model.md#every-signature-is-verified)).
- `eth_signTransaction` fills and signs the same way, and returns the signed raw transaction as hex without sending it, like `cast mktx` and viem's json-rpc `signTransaction`. The nonce is read from the node and not reserved: sending another transaction first makes the signed one stale. Hardhat's local accounts do not sign `eth_signTransaction`. The [`kms sign-tx`](tasks.md#kms-sign-tx) task does the same from the command line, for any configured key.
- A transaction's `chainId`, when set, must equal the connection's chain id (read with `eth_chainId`, and checked against the network's `chainId` when the config sets one). A mismatch fails before any KMS call.
- No RPC method signs a bare digest.
- `connection.kms.getAccount(address)` gives library code a viem account for a KMS key, outside the JSON-RPC path. viem sends its transactions with `eth_sendRawTransaction`, or `eth_sendRawTransactionSync` for `sendTransactionSync` and `writeContractSync`; see [Library accounts](library-accounts.md#sending).
- `eth_sendRawTransaction` and `eth_sendRawTransactionSync` ([EIP-7966](https://eips.ethereum.org/EIPS/eip-7966)) from a KMS account go to the node unchanged, in turn with that account's sends (see below). No answer is rewritten: `eth_getTransactionCount` and every other read pass through untouched.
- `wallet_sendTransaction` from a KMS account fails with JSON-RPC error `-32601` (method not found) and never reaches the node. The plugin sends a KMS account's transactions only through `eth_sendTransaction`. viem sends `wallet_sendTransaction` once after an `eth_sendTransaction` error such as `-32000`. On `-32601` it throws the `eth_sendTransaction` error and keeps using `eth_sendTransaction` on that client, so an endpoint that answers `wallet_sendTransaction` cannot take later sends away from the KMS key. The plugin reads the sender from `from` in the first param, in any letter case of its hex digits. A `wallet_sendTransaction` without `from`, or from another address, passes through unchanged.
- `wallet_sendCalls` ([EIP-5792](https://eips.ethereum.org/EIPS/eip-5792)) from a KMS account fails the same way, with `-32601`, and never reaches the node. The plugin does not implement EIP-5792. viem's `sendCalls` sends this method. With `experimental_fallback: true`, viem answers `-32601` by sending each call as its own transaction, so the KMS key signs each one. Without it, viem throws a `TransactionExecutionError` with the `-32601` error in its cause chain. viem does not fall back, and throws `AtomicityNotSupportedError` or `UnsupportedNonOptionalCapabilityError`, when the batch has `forceAtomic` and more than one call, or a capability without `optional: true`. A client created with `dataSuffix: { required: true }` adds such a capability to every batch. The plugin reads the sender from `from` in the first param. EIP-5792 makes `from` optional: a `wallet_sendCalls` without `from`, or from another address, passes through unchanged.
- Every other method passes through untouched.

When `from` (or the address param) is not a KMS address, the request passes through. If the sender is not a local account either, the node or Hardhat refuses it, and the plugin appends the network's checksummed KMS addresses to that error. On a simulated network with one KMS account, a request from `0x1111111111111111111111111111111111111111` fails with:

```text
Unknown account 0x1111111111111111111111111111111111111111. The KMS account on this network is 0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826.
```

The error then shows a mistyped address or a key missing from `kmsAccounts`. It keeps its class, code and data, and Hardhat's CLI prints the list too. At most 10 addresses are listed, then "and N more". No key id is ever named. The plugin recognizes these errors:

- Hardhat's simulated network: `Unknown account <address>`, code -32000.
- Hardhat's local accounts on a network with `accounts`: `HHE716: Account "<address>" is not managed by the node you are connected to.`
- Geth: `unknown account`, code -32000.
- Reth: `unknown account`, code -32602.
- Anvil: `No Signer available`, code -32602.

Every other error passes through unchanged.

An `eth_sendTransaction` or `eth_signTransaction` without `from` gets the sender Hardhat would give it: the network's `from` when the config sets one, otherwise the first address of `eth_accounts`, in the plugin's order (the network's own accounts, then the KMS addresses). The plugin sets `from` to that sender. When the sender is a KMS account, the plugin signs; otherwise the request passes on with `from` set, and Hardhat or the node signs it. A transaction therefore never reaches the node unsigned with a KMS address as its sender. Hardhat's sender handlers cover `eth_sendTransaction` but not `eth_signTransaction`; the plugin chooses the sender for both. When there is no sender (an empty or invalid `eth_accounts` answer), the request passes on unchanged.

This covers only a request that reaches the network without `from`. hardhat-viem, hardhat-ethers and Ignition set `from` themselves, and their default wallet client, signer or sender is the first address of `eth_accounts`, whatever the network's `from` says. Name the KMS key's address instead, as shown in [Choose the sender by address](../guides/multiple-keys.md#choose-the-sender-by-address).

The plugin copies a KMS account's transaction when the request arrives, so changing the request object after the call does not change what is signed. A KMS account's transaction that cannot be copied (one holding a function, for example) fails with `the transaction must be plain data`, and nothing is sent. Requests from other senders pass through as they came; for a transaction without `from`, only `from` is added, on a shallow copy.

`kmsAccounts` on the `default` network prints a warning, because tasks and tests use that network when no `--network` is given; see the [configuration reference](configuration.md#configuration).

## Parallel sends and failed broadcasts

`eth_sendTransaction` calls from one KMS account on one chain run one at a time within a process, across every connection the process has to that chain. [Which nonce a send gets](#which-nonce-a-send-gets) gives the nonce rule. A library account's send through the connection takes its turn the same way, from its nonce to its broadcast; see [Library accounts](library-accounts.md#sending). Sends from other accounts, or to other chains, do not wait for each other. `eth_signTransaction` does not wait for sends.

A send whose broadcast hangs keeps the account's turn until Hardhat's network timeout (the network's `timeout`, 300 seconds by default) ends it. The account's sends waiting behind it do not wait that long: each fails after 120 seconds in which none of the account's earlier sends finished. A slow RPC endpoint can trigger this.

Three limits keep a waiting send from hanging. Each one fails the send with an error that names the account and the chain, and that send is not signed or sent:

- A send from an account and chain, made by code that runs inside a send from the same account and chain, fails at once. Another plugin's network hook that sends while the plugin fills a transaction is one example. It would otherwise wait for itself forever.
- A send that has waited 120 seconds while none of the account's earlier sends finished fails.
- When 1024 sends from one account on one chain are already waiting, the next one fails at once.

The first limit also covers a send that nothing waits for. A send started from inside another send's hook, or from a listener that the hook triggers (an `EventEmitter.emit`, or a callback queued with `setImmediate` or `queueMicrotask` during the hook), fails at once even if no code awaits it. If nothing catches that error, it is an unhandled rejection, which ends the Node.js process. Await such a send and catch its error, or start it after the outer send returns.

The numbers 120 and 1024 are fixed, and cannot be configured in 1.0.

### Which nonce a send gets

On an http network, a send whose caller gives no `nonce` takes the highest of:

- the node's pending count for the account (`eth_getTransactionCount` with `"pending"`);
- one more than the highest nonce the node accepted from the account on the same connection;
- one more than any nonce handed to a [library account](library-accounts.md#sending)'s client on the same connection that still counts.

A `nonce` in the request is always used, even one that was already sent, so a replacement transaction with the same nonce and higher fees goes through, as Hardhat Ignition sends for a stuck transaction. On `edr-simulated` networks the plugin keeps no record of accepted nonces, because the node's pending count is always up to date there.

The send lock and the nonce memory have different scopes:

| Scope                              | Sends run one at a time | Nonces the plugin remembers   |
| ---------------------------------- | ----------------------- | ----------------------------- |
| One connection                     | Yes                     | Yes                           |
| Several connections in one process | Yes                     | No: one memory per connection |
| Several processes                  | No                      | No                            |

What this means for nonces:

- On one connection, each send gets a nonce above every nonce the node accepted from the account on that connection, even from a node whose pending count lags behind, such as a load-balanced RPC endpoint. Parallel sends on one connection therefore get distinct nonces, unless a broadcast got no answer ([Failed broadcasts](#failed-broadcasts)).
- Each `network.create()` call opens a new connection, with its own memory. Sends on two connections to the same chain still wait for each other, but a send on the second connection knows only the node's pending count and its own connection's nonces. If the node's pending count has not caught up with a send from the first connection, the second gets the same nonce. `network.getOrCreate()` returns the same connection on each call for a network, so a script that uses it has one connection per network and avoids this.
- Separate processes are not coordinated: two `hardhat run` commands that send from the same KMS key at the same time can choose the same nonce.

When two transactions share a nonce, at most one of them is mined. While the first is still in the pool, a second with fees at least 10 % higher (Geth's default) replaces it, and neither sender gets an error. With lower fees the second send fails with `replacement transaction underpriced`, and once the first is mined, with `nonce too low`.

### Failed broadcasts

When the node answers a broadcast with an error, such as a revert or "nonce too low", `eth_sendTransaction` fails with that error, unchanged, as it would for a local account. A reverted transaction keeps its revert data and `transactionHash`. A rate limit that outlasts Hardhat's own retries (HTTP 429) is such an answer too.

When Hardhat cannot connect to the node, nothing was sent, and `eth_sendTransaction` fails with Hardhat's "Cannot connect to the network" error, unchanged.

When no answer comes back, because the request times out or fails with an HTTP error status, the transaction may still be on its way. `eth_sendTransaction` then fails with JSON-RPC error code `-32000`. The error's `transactionHash` and `data.hash` are the transaction hash, so you can look the transaction up; Hardhat Ignition reads `transactionHash` and follows the transaction. A gateway's answer that its backend timed out (code `-32603`, or a message saying the request timed out or a deadline was exceeded) leaves the outcome open in the same way, but it is passed on unchanged, without the hash.

After either of these, if the same request, with the same params, is sent again on the same connection within 120 seconds, the plugin sends the same signed transaction again instead of signing a new one, and returns its hash. A node that answers "already known" counts as success, and so does a refusal of those bytes when the node turns out to have the transaction. Each such retry uses up the kept transaction; if the retry also gets no answer, a gateway's timeout answer or a refused connection, the transaction is kept again for another 120 seconds. If another send has used the transaction's nonce in the meantime and the node does not have it, the retry is signed afresh instead. A request that succeeded is never repeated this way, so sending the same transaction twice on purpose still sends two transactions. viem does not repeat `eth_sendTransaction` by itself, so only a caller that repeats the request gets this. The `wallet_sendTransaction` that viem sends once after a `-32000` error is refused for a KMS account (see above), so viem throws the `eth_sendTransaction` error; see [Recover from an uncertain transaction send](../guides/uncertain-sends.md#1-get-the-transaction-hash).

The plugin remembers the account's last uncertain transaction on the connection that sent it. The account's next send on that connection without a caller-supplied `nonce` first asks the node about it with `eth_getTransactionByHash`, so that the send does not reuse its nonce. If the node has it, the send takes a higher nonce. If the node does not have it, or the lookup itself fails, it counts as not known: the node's pending count decides as usual, and the send can take the same nonce. If the first transaction reaches the node after all, the two then share a nonce, as described above. The question is asked once; behind a load balancer it can reach a backend that does not have the transaction yet. A send with a `nonce` does not ask, a send on another connection never learns of the transaction, and on `edr-simulated` networks nothing is remembered.

To check whether such a transaction arrived, and to fill or replace a nonce, follow [Recover from an uncertain transaction send](../guides/uncertain-sends.md).

## Supported transaction types

| Type            | Status                                                  |
| --------------- | ------------------------------------------------------- |
| Legacy          | Supported, EIP-155 only.                                |
| EIP-2930        | Supported.                                              |
| EIP-1559        | Supported.                                              |
| EIP-7702        | Supported with a pre-signed `authorizationList`.        |
| EIP-4844 (blob) | Not supported. Hardhat core does not support it either. |

The fields decide the type, as in Hardhat: `authorizationList` gives EIP-7702, `maxFeePerGas` EIP-1559, `accessList` EIP-2930, and anything else legacy. With the network's default `gasPrice: "auto"`, a request without fee fields gets EIP-1559 fees when the node supports them. A transaction with `blobs` or `blobVersionedHashes` from a KMS account fails before any request to the node.

For EIP-7702 the RPC path does not sign unsigned authorization entries. No client emits that format, and Hardhat's schema requires signed tuples. To have the KMS key sign an authorization, run [`kms sign-auth`](tasks.md#kms-sign-auth), with `--self-broadcast` when the same key also sends the transaction, and put the JSON tuple it prints in the `authorizationList` of a raw `eth_sendTransaction`, sent with `provider.request`, as it is. viem and ethers take other shapes; see [sending the authorization](tasks.md#send-the-authorization). In library code, `connection.kms.getAccount(address)` returns a viem account whose `signAuthorization` signs with the KMS key ([Library accounts](library-accounts.md)).

An authorization's `r` and `s` may be 32-byte values or quantities, the form viem sends, which drops leading zero bytes (about one authorization in 85). For a KMS sender, the plugin sends them to the node's `eth_estimateGas` as quantities, the form the execution APIs specify and geth requires, and pads them to 32 bytes only to check and sign the transaction, so the signed bytes are the same either way. An `r` or `s` of 0, or of the secp256k1 curve order or more, is refused before any request to the node. Hardhat's own local accounts on an `http` network accept only 32-byte values.

When a KMS sender's transaction carries pre-signed tuples, the plugin lints them: each signature must be low-S, and an authority must recover from it over the EIP-7702 authorization hash, `keccak256(0x05 || rlp([chainId, address, nonce]))`. A tuple that fails either check prints a warning that names its index in `authorizationList`, and the transaction is still signed and sent. A node accepts such a transaction but skips the failing authorization.
