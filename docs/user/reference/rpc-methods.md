# RPC methods reference

Audience: Users and library authors who want to know which JSON-RPC calls the plugin handles.

Status: M4 implements accounts, `eth_sign`, `personal_sign` and `eth_signTypedData_v4` ([#19](https://github.com/aelmanaa/hardhat-kms/issues/19)). The chain-id check for typed data is [#20](https://github.com/aelmanaa/hardhat-kms/issues/20). Transactions are planned for M5 ([#24](https://github.com/aelmanaa/hardhat-kms/issues/24)); until then, `eth_sendTransaction` and `eth_signTransaction` from a KMS account fail with an error that says so.

## RPC behaviour

The plugin installs a network hook on every connection. On a connection whose network has no `kmsAccounts`, it passes every request through. Otherwise it behaves as follows:

- `eth_accounts` and `eth_requestAccounts` return the network's own accounts followed by the KMS addresses, without duplicates. `eth_requestAccounts` is passed on as `eth_accounts`, as Hardhat's local accounts do, since many nodes implement only that. If the downstream call fails, only the KMS addresses are returned.
- A KMS address comes from the `address` pin when one is set, with no KMS call. Otherwise it comes from a public-key lookup, run in parallel across keys on first use. A failed lookup is not cached; the next request retries it. Two keys that resolve to the same address are an error: `<key> and <key> are the same account (<address>); list each key once`.
- Five signing methods are intercepted, but only when the address is a KMS account: `eth_sendTransaction`, `eth_signTransaction`, `eth_sign`, `personal_sign` and `eth_signTypedData_v4`.
- `eth_sign` (`[address, data]`) and `personal_sign` (`[data, address]`) use EIP-191 with the message prefix, the same semantics as Hardhat core. Their params are checked with Hardhat's own validators: data must be strict hex (`0x` and an even number of digits).
- `eth_signTypedData_v4` (`[address, typedData]`) accepts the typed data as an object or a JSON string. Its shape is checked before any KMS call. When `domain.chainId` is set, it must equal the connection's chain (read with `eth_chainId`) unless `kms.allowCrossChainTypedData` is `true`, and a mismatch fails before any KMS signing call. A number, bigint, hex string with a lowercase `0x` prefix or decimal string is accepted, and `0` is checked like any other value. Typed data without `domain.chainId` is signed, as MetaMask, Hardhat and Foundry do; its signature is valid on every chain. See [decision 0011](../../contributor/decisions/0011-typed-data-chain-check.md).
- `eth_signTransaction` fills and signs without broadcasting, like `cast mktx` and viem's json-rpc `signTransaction`. It is on by default. (Planned for M5.)
- No RPC method signs a bare digest.
- Every other method passes through untouched.

When `from` (or the address param) is not a KMS address, the request passes through. If the sender turns out not to be a local account either, the resulting error lists the loaded KMS addresses (planned for M5).

`kmsAccounts` on the `default` network prints a warning, because tasks and tests use that network when no `--network` is given; see the [configuration reference](configuration.md#configuration).

## Supported transaction types

| Type            | Status                                                  |
| --------------- | ------------------------------------------------------- |
| Legacy          | Supported, EIP-155 only.                                |
| EIP-2930        | Supported.                                              |
| EIP-1559        | Supported.                                              |
| EIP-7702        | Supported with a pre-signed `authorizationList`.        |
| EIP-4844 (blob) | Not supported. Hardhat core does not support it either. |

For EIP-7702 the RPC path does not sign unsigned authorization entries. No client emits that format, and Hardhat's schema requires signed tuples. A user who wants the KMS key to sign an authorization runs `kms sign-auth` (with `--self-broadcast` when the same key also sends the transaction) and puts the resulting signed tuple in a normal `authorizationList`. The planned `getAccount().signAuthorization` covers the library case.

When a KMS sender's transaction carries pre-signed tuples, the plugin lints them: each signature must be low-S and its authority must recover. A tuple that fails either check produces a warning, not an error.
