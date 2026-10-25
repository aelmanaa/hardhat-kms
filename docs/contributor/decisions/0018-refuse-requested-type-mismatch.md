# 0018: Refuse a requested type that disagrees with the caller's fee fields

Status: Accepted

Issue: #496

## Context

`eth_sendTransaction` and `eth_signTransaction` from a KMS account picked the transaction type from the fields and ignored `type`, except type 3 (#484). A request that asked for one type and carried the fee fields of another was signed as the other type with no error: `type: "0x2"` with `gasPrice` was signed as legacy, and `type: "0x0"` with `maxFeePerGas` as EIP-1559.

That is what the references do. Hardhat 3.18's `rpcTransactionRequest` schema has no `type` key and its local accounts pick the type from the fields; geth's `TransactionArgs` has no `Type` field; alloy keeps `transaction_type` for serialization but does not consult it. Parity alone says keep signing.

The plugin's other signing paths do not. `kms sign-tx` refuses a filled type that differs from the requested one (`core.task.tx-type-mismatch`), and `connection.kms.getAccount` signs through viem, which honours `type` and throws `Eip1559FeesNotSupportedError` for `legacy` with EIP-1559 fees. The plugin signs with production keys, and its rule is to refuse a request it cannot carry out as written (#435, #484).

A blanket "the signed type must equal `type`" rule would refuse working code: viem's JSON-RPC accounts send `type: "legacy"` with no fees as `type: "0x0"`, and the filler gives it EIP-1559 fees on a node with a base fee.

## Decision

Before any node request, after the type-3 check, the filler reads `type` as a number in the forms `isBlobType` accepts (a hex quantity in either case with any leading zeros, a decimal string, a non-negative integer or a bigint, trimmed). A number other than 0, 1, 2, 3 and 4 is refused with `core.tx.unsupported-type`, whatever the other fields. When the caller also set `gasPrice`, `maxFeePerGas` or `maxPriorityFeePerGas`, a type other than the one the fields give is refused with `core.tx.type-mismatch`; the fields give 4 with `authorizationList`, else 2 with an EIP-1559 fee field, else 1 with `accessList`, else 0. The message ends with what to change for the type asked for.

Type 1 with `gasPrice` and no `accessList` is not a mismatch. An EIP-2930 transaction with an empty access list is valid, and viem's `eip2930` and ethers' `type: 1` send exactly this request for `sendTransaction`, deploys and contract calls; viem's local accounts and ethers' `Wallet` sign it as type 1. The filler sets `accessList: []` on its copy and signs type 1. Refusing it would make users of both libraries add `accessList: []` by hand for a request that already says what it means.

A `type` with no fee field is not checked, a `type` that is not a number (`"legacy"`, `"eip1559"`) is ignored, as before, and a request whose fee or list field is `null` fails before the mismatch check, with `core.tx.null-field` ([#504](https://github.com/aelmanaa/hardhat-kms/issues/504)), where the schema refused it before. The exception is the one `null` the automatic fee fill replaces, as Hardhat does: a lone `null` `maxFeePerGas` or `maxPriorityFeePerGas` with no `gasPrice` and the other EIP-1559 field absent. It still signs, and counts as an EIP-1559 fee field for the check, so `type: "0x0"` with `maxFeePerGas: null`, which was signed as type 2, is a mismatch. There is no setting to turn the check off.

## Consequences

- Requests that signed before now fail: a contradictory `type` with the caller's fee fields, and a numeric `type` the plugin does not sign. The latter includes Celo's fee-currency type `0x7b` and zkSync's `0x71`, which viem's chain formatters send over `eth_sendTransaction`; before, they were signed as plain transactions without their chain-specific fields. Hence a minor release.
- One request changes its bytes: type 1 with `gasPrice` and no `accessList`, signed as legacy before and as EIP-2930 now. Every other request that still signs gives the same bytes.
- The differential test against Hardhat changed. It used to check that `gasPrice` with `type` `0x2` signs as legacy, as Hardhat does; that request is now refused, so the test covers only the cases that still match Hardhat: agreeing types 0, 1, 2 and 4, and types with no fee field. Type 1 with `gasPrice` and no `accessList` differs from Hardhat and is covered by unit and integration tests.
- The send path now agrees with `kms sign-tx` and the viem account on contradictory requests, and departs from Hardhat's local accounts; `docs/contributor/transactions.md` lists it among the deliberate differences.
- viem's names are not mapped to numbers; a `type: "legacy"` that a caller sends over raw JSON-RPC with EIP-1559 fees still signs as EIP-1559. viem's own clients send the number.
- Revisit if the filler starts honouring `type` when it fills fees (`gasPrice` for types 0 and 1, as viem's local accounts do), so that `type: "0x0"` with no fees signs as legacy. That changes the envelope of requests that sign today.
- Hardhat 3.19 (hardhat-zod-utils 3.0.7) adds `type` to `rpcTransactionRequest` as a strict quantity, and its local accounts refuse type 3 and any `type` not in that form (a number, leading zeros, `"legacy"`). They still pick the signed type from the fields. The filler keeps the forms this decision accepts: it removes `type` from the copy it validates with Hardhat's schema, after `applyRequestedType` has read it. The differential test sends Hardhat each type as a quantity and the plugin the same type in the other forms ([#580](https://github.com/aelmanaa/hardhat-kms/pull/580)).
