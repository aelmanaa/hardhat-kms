# 0014: The library account signs bare digests only when asked

Status: Accepted

Issue: #51

## Context

`connection.kms.getAccount(address)` returns a viem `LocalAccount`, so that viem's `signAuthorization`, smart-account SDKs and scripts outside a wallet client can use a KMS key. viem's `LocalAccount` type makes `sign({ hash })` optional; it signs a 32-byte digest as it is, with no prefix. Some owners need it: `toCoinbaseSmartAccount` calls `owner.sign` to sign user operations, and viem's `PrivateKeyAccount` type requires it.

[Decision 0003](0003-no-bare-digest-over-rpc.md) keeps bare digests off the RPC path, because any code in the project can call it and a bare digest can be the hash of a transaction or a permit for any chain. The account is a second path into the same keys, reachable by the same code.

## Decision

The account has no `sign` by default. `getAccount(address, { rawSign: true })` adds it, and prints a warning each time such an account is made. Every other method of the account signs a structured request, with the checks of the RPC path: EIP-191 messages, typed data whose chain is the network's unless `kms.allowCrossChainTypedData` is set, transactions of types 0, 1, 2 and 4 for the network's chain, and EIP-7702 authorizations for the network's chain, with chain 0 only under `allowChainZeroAuthorization: true`.

The public types follow: `getAccount(address)` returns `KmsAccount`, which has no `sign` and so is not a `PrivateKeyAccount`; `getAccount(address, { rawSign: true })` returns `KmsRawSignAccount`, which has it.

## Consequences

- An owner that needs `sign`, such as a Coinbase smart account, works only with the option, and the option shows in the code that asks for it.
- As with `kms sign --no-hash`, the option is not a barrier against code in the project: a script can ask for it. The warning makes the request visible in the output.
- The account's transactions go through viem's own send path, not the plugin's: viem fills them and sends `eth_sendRawTransaction` itself, so the send lock, the nonce high-water mark and the retry cache do not apply. Sends from a KMS account belong on `connection.viem.getWalletClient(address)`. The docs say so at the top of the reference page, and the first transaction an account signs in a process prints a warning that points there and to [#186](https://github.com/aelmanaa/hardhat-kms/issues/186). Since #186, the account has a viem `nonceManager` that chooses its nonces under the account's send lock, and the dispatcher orders its `eth_sendRawTransaction` with the plugin's sends when it comes through the connection ([Transactions](../transactions.md#library-accounts-nonces-and-raw-transactions)). The first-transaction warning is gone; a client with its own transport, the case that stays uncovered, gets a warning instead. The viem floor rose to 2.56.0 for this.
- viem is an optional peer dependency (`peerDependenciesMeta`), loaded only by `getAccount`. Hardhat's own peer check ignores `peerDependenciesMeta` ([decision 0005](0005-lazy-sdk-loading.md)), but it runs only after a hook handler or task action of the plugin fails to load. No module that Hardhat loads imports viem, so a project without viem loads the plugin, runs every task and fails only at `getAccount`, with a message that names viem. One effect remains: if a hook handler or task of the plugin fails to load for another reason in such a project, Hardhat reports viem as the missing peer dependency instead of the real cause. The same happens in a project that installs viem below the floor, 2.56.0: Hardhat's check also compares installed versions with the peer range, so such a failure reports `DEPENDENCY_VERSION_MISMATCH` for viem instead of the real cause.
