# RPC methods reference

Audience: Users and library authors who want to know which JSON-RPC calls the plugin handles.

Status: M4 implements accounts, `eth_sign`, `personal_sign` and `eth_signTypedData_v4` ([#19](https://github.com/aelmanaa/hardhat-kms/issues/19)). The chain-id check for typed data is [#20](https://github.com/aelmanaa/hardhat-kms/issues/20). M5 signs `eth_sendTransaction` and `eth_signTransaction` ([#24](https://github.com/aelmanaa/hardhat-kms/issues/24)), and serializes sends from one KMS account, with a nonce high-water mark and one retry of a failed broadcast ([#25](https://github.com/aelmanaa/hardhat-kms/issues/25)).

## RPC behaviour

The plugin installs a network hook on every connection. On a connection whose network has no `kmsAccounts`, it passes every request through. Otherwise it behaves as follows:

- `eth_accounts` and `eth_requestAccounts` return the network's own accounts followed by the KMS addresses, without duplicates. `eth_requestAccounts` is passed on as `eth_accounts`, as Hardhat's local accounts do, since many nodes implement only that. If the downstream call fails, only the KMS addresses are returned.
- A KMS address comes from the `address` pin when one is set, with no KMS call. Otherwise it comes from a public-key lookup, run in parallel across keys on first use. A failed lookup is not cached; the next request retries it. Two keys that resolve to the same address are an error: `<key> and <key> are the same account (<address>); list each key once`.
- Five signing methods are intercepted, but only when the address is a KMS account: `eth_sendTransaction`, `eth_signTransaction`, `eth_sign`, `personal_sign` and `eth_signTypedData_v4`.
- `eth_sign` (`[address, data]`) and `personal_sign` (`[data, address]`) use EIP-191 with the message prefix, the same semantics as Hardhat core. Their params are checked with Hardhat's own validators: data must be strict hex (`0x` and an even number of digits).
- `eth_signTypedData_v4` (`[address, typedData]`) accepts the typed data as an object or a JSON string. Its shape is checked before any KMS call. When `domain.chainId` is set, it must equal the connection's chain (read with `eth_chainId`) unless `kms.allowCrossChainTypedData` is `true`, and a mismatch fails before any KMS signing call. A number, bigint, hex string with a lowercase `0x` prefix or decimal string is accepted, and `0` is checked like any other value. Typed data without `domain.chainId` is signed, as MetaMask, Hardhat and Foundry do; its signature is valid on every chain. See [decision 0011](../../contributor/decisions/0011-typed-data-chain-check.md).
- `eth_sendTransaction` fills the transaction the way Hardhat fills one for a local account (fees, gas, nonce, chain id), signs it with the KMS key and sends it to the node as `eth_sendRawTransaction`. It returns the transaction hash. The signed bytes are the ones Hardhat's local accounts produce for the same request and chain state.
- `eth_signTransaction` fills and signs the same way, and returns the signed raw transaction as hex without sending it, like `cast mktx` and viem's json-rpc `signTransaction`. The nonce is read from the node and not reserved: sending another transaction first makes the signed one stale. Hardhat's local accounts do not sign `eth_signTransaction`.
- A transaction's `chainId`, when set, must equal the connection's chain id (read with `eth_chainId`, and checked against the network's `chainId` when the config sets one). A mismatch fails before any KMS call.
- No RPC method signs a bare digest.
- Every other method passes through untouched.

When `from` (or the address param) is not a KMS address, the request passes through. If the sender turns out not to be a local account either, the resulting error lists the loaded KMS addresses (planned for M5).

An `eth_sendTransaction` or `eth_signTransaction` without `from` gets the sender Hardhat would give it: the network's `from` when the config sets one, otherwise the first address of `eth_accounts`, in the plugin's order (the network's own accounts, then the KMS addresses). The plugin sets `from` to that sender. When the sender is a KMS account, the plugin signs; otherwise the request passes on with `from` set, and Hardhat or the node signs it. A transaction therefore never reaches the node unsigned with a KMS address as its sender. Hardhat's sender handlers cover `eth_sendTransaction` but not `eth_signTransaction`; the plugin chooses the sender for both. When there is no sender (an empty or invalid `eth_accounts` answer), the request passes on unchanged.

The plugin copies a KMS account's transaction when the request arrives, so changing the request object after the call does not change what is signed. A KMS account's transaction that cannot be copied (one holding a function, for example) fails with `the transaction must be plain data`, and nothing is sent. Requests from other senders pass through as they came; for a transaction without `from`, only `from` is added, on a shallow copy.

`kmsAccounts` on the `default` network prints a warning, because tasks and tests use that network when no `--network` is given; see the [configuration reference](configuration.md#configuration).

## Parallel sends and failed broadcasts

`eth_sendTransaction` calls from one KMS account on one chain run one at a time within a process, so parallel sends get consecutive nonces. Sends from other accounts, or to other chains, do not wait for each other. `eth_signTransaction` does not wait for sends.

On an http network, a send whose caller gives no `nonce` uses the higher of the node's pending count and one more than the highest nonce the node accepted from that account on the same connection. A node whose pending count lags behind, such as a load-balanced RPC endpoint, therefore does not get a nonce twice. A `nonce` in the request is always used, also one that was already sent, so a replacement transaction with the same nonce and higher fees goes through, as Hardhat Ignition sends for a stuck transaction. On `edr-simulated` networks the node's pending count is used as it is.

Separate processes are not coordinated: two `hardhat run` commands that send from the same KMS key at the same time can choose the same nonce.

When the node does not confirm a broadcast, because it answers with an error or the request fails or times out, the transaction may still be on its way. `eth_sendTransaction` then fails with JSON-RPC error code `-32000`, which viem does not retry, and the error's `data.hash` is the transaction hash, so you can look the transaction up. If the same request, with the same params, is sent again on the same connection within 120 seconds, the plugin sends the same signed transaction again instead of signing a new one, and returns its hash. A node that answers "already known" counts as success. This happens once per failed broadcast; a request that succeeded is never repeated this way, so sending the same transaction twice on purpose still sends two transactions.

## Supported transaction types

| Type            | Status                                                  |
| --------------- | ------------------------------------------------------- |
| Legacy          | Supported, EIP-155 only.                                |
| EIP-2930        | Supported.                                              |
| EIP-1559        | Supported.                                              |
| EIP-7702        | Supported with a pre-signed `authorizationList`.        |
| EIP-4844 (blob) | Not supported. Hardhat core does not support it either. |

The fields decide the type, as in Hardhat: `authorizationList` gives EIP-7702, `maxFeePerGas` EIP-1559, `accessList` EIP-2930, and anything else legacy. With the network's default `gasPrice: "auto"`, a request without fee fields gets EIP-1559 fees when the node supports them. A transaction with `blobs` or `blobVersionedHashes` from a KMS account fails before any request to the node.

For EIP-7702 the RPC path does not sign unsigned authorization entries. No client emits that format, and Hardhat's schema requires signed tuples. A user who wants the KMS key to sign an authorization runs `kms sign-auth` (with `--self-broadcast` when the same key also sends the transaction) and puts the resulting signed tuple in a normal `authorizationList`. The planned `getAccount().signAuthorization` covers the library case.

When a KMS sender's transaction carries pre-signed tuples, the plugin lints them: each signature must be low-S, and an authority must recover from it over the EIP-7702 authorization hash, `keccak256(0x05 || rlp([chainId, address, nonce]))`. A tuple that fails either check prints a warning that names its index in `authorizationList`, and the transaction is still signed and sent. A node accepts such a transaction but skips the failing authorization.
