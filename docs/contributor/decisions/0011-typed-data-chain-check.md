# 0011: Check typed data's chain only when it names one

Status: Accepted (2026-10-01)

Issue: [#20](https://github.com/aelmanaa/hardhat-kms/issues/20)

## Context

A typed-data signature made for one chain can be replayed on another if the verifying contract exists there too. `kms.allowCrossChainTypedData` (default `false`) already promised a check. What it should do when `domain.chainId` is absent was open. EIP-712 allows a domain without `chainId`, and off-chain and cross-chain schemes use such domains.

## Evidence

Read in the code of each signer:

| Signer                                                   | Compares `domain.chainId` with the chain | Without `domain.chainId` | Encodings read                                   |
| -------------------------------------------------------- | ---------------------------------------- | ------------------------ | ------------------------------------------------ |
| Hardhat 3.18 local accounts                              | No                                       | Signs                    | number, bigint, hex or decimal string            |
| Foundry: anvil, `cast wallet sign --data`, alloy signers | No                                       | Signs                    | number, hex or decimal string                    |
| MetaMask                                                 | Yes; a mismatch is an error              | Signs (check skipped)    | number; string as hex if `0x`, otherwise decimal |

- Hardhat: `local-accounts.js` parses the JSON and calls micro-eth-signer's `signTyped` without a chain comparison; micro-eth-signer drops an absent `chainId` from the domain type.
- Foundry: anvil's `sign.rs` clears the signer's chain id before `sign_dynamic_typed_data`; alloy documents that the chain id does not affect typed-data signing.
- MetaMask: `MetaMask/core`, `packages/signature-controller/src/utils/validation.ts`, compares only `if (chainId)`, so `0` is skipped too, and parses strings with `parseInt`.

## Decision

hardhat-kms follows MetaMask, the one signer that checks, and makes the check stricter where MetaMask is loose:

- When `domain.chainId` is present, it must equal the connection's chain, unless `kms.allowCrossChainTypedData` is `true`. A mismatch fails before any KMS signing call, with both chain ids in the message.
- When `domain.chainId` is absent, the typed data is signed, as by every signer above. The debug output notes that the signature is valid on every chain.
- `chainId: 0` is checked, not skipped. Numbers, bigints, hex strings with a lowercase `0x` prefix and decimal strings are read exactly; anything else is refused.
- The typed data is copied once, with `structuredClone`, before any check. The check, the digest and the signature all use that copy, so a caller that changes its object while the request runs cannot get a signature for other values than the checked ones.
- The connection's chain id is read with `eth_chainId` once per connection, as Hardhat's own chain-id validator does, not kept after a failure, and must equal the network config's `chainId` when one is set. The node's answer must be a hex quantity.

## Consequences

- Typed data that names a chain cannot be signed for the wrong network by mistake, which Hardhat and Foundry allow.
- Typed data without a chain still signs; refusing it would break valid EIP-712 that every other signer accepts.
- Signing typed data that names a chain now needs `eth_chainId` to answer. Messages (`eth_sign`, `personal_sign`) do not read the chain, since it is not part of their signature.
- A domain that names its chain field anything but `chainId` (for example `chainID`) is, for EIP-712, a domain without a chain id: it is signed without a check.
- The check reads `domain.chainId` whatever type `EIP712Domain` declares for it. With a type other than `uint256`, such as `string` with `"1"`, the check can pass while the digest does not bind the chain in the standard way. This is not a bypass: a verifier that declares `uint256 chainId` has another type hash, so the signature does not verify there. A passing check alone does not prove the standard chain binding.
- Revisit if wallets start refusing domains without `chainId`, or if a standard asks signers to.
