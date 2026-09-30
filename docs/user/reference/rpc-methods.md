# RPC methods reference

Audience: Users and library authors who want to know which JSON-RPC calls the plugin handles.

Status: Planned: M4 (accounts, messages) and M5 (transactions).

## RPC behaviour

The plugin installs a network hook. It behaves as follows:

- `eth_accounts` and `eth_requestAccounts` return the network's own accounts followed by the KMS addresses. If the downstream call fails, only the KMS addresses are returned.
- A KMS address comes from the `address` pin when one is set, with no KMS call. Otherwise it comes from a public-key lookup, run in parallel across keys and cached per HRE.
- Five signing methods are intercepted, but only when the address is a KMS account: `eth_sendTransaction`, `eth_signTransaction`, `eth_sign`, `personal_sign` and `eth_signTypedData_v4`.
- `eth_sign` and `personal_sign` use EIP-191 with the message prefix, the same semantics as Hardhat core. Their data must be strict hex.
- `eth_signTransaction` fills and signs without broadcasting, like `cast mktx` and viem's json-rpc `signTransaction`. It is on by default.
- No RPC method signs a bare digest.
- Every other method passes through untouched.

When `from` is not a KMS address, the request passes through. If the sender turns out not to be a local account either, the resulting error lists the loaded KMS addresses.

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
