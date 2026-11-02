# 0025: Propose Safe transactions from a separate package, without a Safe SDK

Status: Proposed (spike, 2026-11-02)

Issue: [#653](https://github.com/aelmanaa/hardhat-kms/issues/653)

## Context

Teams that deploy from a KMS key hand ownership to a Safe and send admin and upgrade calls through it. No Hardhat 3 tool proposes those calls to the Safe Transaction Service ([research](../research/smart-account-sends.md)). The spike for #653 measured what a proposer needs.

The Transaction Service:

- Base URL: `https://api.safe.global/tx-service/<shortName>`, with `sep` for Sepolia and `eth` for mainnet (api-kit 5.0.4, `dist/esm/index.mjs:87-153`). The legacy `https://safe-transaction-sepolia.safe.global` answers `308` to the gateway (one GET, 2026-11-02).
- A proposal is `POST /api/v2/safes/{safe}/multisig-transactions/` with the `SafeTx` fields, `contractTransactionHash`, `sender`, `signature` and `origin` (api-kit `index.mjs:655-682`). Numbers are sent as decimal strings, and every address, the one in the path included, must be EIP-55 checksummed. The service answers `201` with an empty body, or `422` with `{"nonFieldErrors": [...]}`.
- The service checks, in order (safe-transaction-service `1b78e0b8`, `history/serializers.py:207-325`): it recomputes the hash with the domain of the Safe's on-chain `VERSION()`; refuses a nonce only when a transaction it indexed as executed used it, with no check against the chain's nonce; requires the sender to be a current owner or a delegate; recovers each signature, where `v` 27/28 is EIP-712 and 31/32 is `eth_sign`; and requires the sender to be one of the signers.
- API key: `Authorization: Bearer <key>`, created at developer.safe.global. api-kit refuses to run without one for `api.safe.global` (`index.mjs:190-214`). The gateway answered an unkeyed GET with `x-ratelimit-limit: 5000` per 30 days. Safe's announcement puts unkeyed callers at 2 requests per second and keyed ones at 5 per second per chain. Whether an unkeyed POST is accepted was not tested.

The `SafeTx` type hash is the same from 1.0.0 to 1.5.0 (`0xbb8310d4…86d8`). The domain is `{verifyingContract}` before 1.3.0 and `{chainId, verifyingContract}` from 1.3.0 on (`DOMAIN_SEPARATOR_TYPEHASH` in each `Safe.sol`; protocol-kit 8.0.11 `getEip712TxTypes`). 1.5.0 was released on 2025-07-03 and does not change the type. The plugin's own EIP-712 encoder (`typedDataDigest`) reproduces safe-eth-py's fixed vectors for 1.0.0 and 1.3.0.

The spike proved the signing path end to end, all of it local. A secp256k1 key in LocalStack's AWS KMS, used through `@hardhat-kms/aws`, owns 1-of-1 and 2-of-3 Safes 1.3.0, 1.4.1 and 1.5.0 on anvil. Their runtime code hashes match the canonical `codeHash` in `@safe-global/safe-deployments` 1.37.66. The plugin's `eth_signTypedData_v4` signature:

- passes each Safe's `checkNSignatures`;
- is accepted by a fake service that applies the checks above;
- executes the 1-of-1 Safe's transaction alone;
- executes the 2-of-3 Safe's transaction together with a second owner's signature.

The SDK option: `@safe-global/api-kit` 5.0.4 with `protocol-kit` 8.0.11 installs 32 packages and 92 MB, 62 MB of it viem. api-kit sends requests with `node-fetch` 2 (`index.mjs:11`), not the global `fetch`, so it takes no `AbortSignal` and no timeout. `node-fetch` 2 also brings `tr46` 0.0.3, which loads the deprecated `punycode` module. protocol-kit adds `@peculiar/asn1-schema` for passkeys and the full `safe-deployments` table.

## Decision

- **A separate package, `@hardhat-kms/safe`.** It is a Hardhat plugin that loads hardhat-kms through `dependencies` and adds `kms safe propose`. Hardhat 3.20 inserts a plugin's tasks after its dependencies' tasks, so a subtask under `kms` works (`task-manager.js` `#insertTask`; the spike runs it). It is released with the core at the same version, as decision 0009 sets for the provider packages. A `hardhat-kms/safe` subpath was rejected: a subpath cannot register a task unless the core registers it for everyone, and the core would then talk to a third-party HTTP API. `hardhat-kms/alchemy` is a pure check with no network and no task, so it is not a precedent here.
- **No Safe SDK**, as for Turnkey (decision 0019). The package has its own client, about 150 lines, for the three calls it makes: the Safe lookup, the pending transactions and the proposal. The client uses the global `fetch` with a timeout and `redirect: "manual"`, so a redirect cannot carry the API key or the signed body to another host. `viem` is a peer dependency, for ABI encoding and an independent `hashTypedData`; the core already has viem as an optional peer. `@safe-global/api-kit` and `protocol-kit` become devDependencies only, for a conformance test: the body and the hash the package builds must equal theirs for the same inputs.
- **What the key signs.** The `SafeTx` is EIP-712 typed data, signed with `eth_signTypedData_v4` through the connection, so the core's checks apply unchanged:
  - the typed-data chain check of decision 0011, since the domain names the chain;
  - the signature check of decision 0004.

  It is never a raw digest, so decisions 0003, 0014 and 0021 do not apply, and the package never asks for `rawSign`. The `eth_sign` form (`v + 4`) is not used.

- **Checks before the KMS signs.** Each one fails before any KMS call:
  - The connection's chain.
  - The Safe has code on that chain.
  - `VERSION()` is 1.3.0, 1.4.1 or 1.5.0. Older Safes are refused: their domain has no `chainId`, so a signature also holds for a Safe at the same address on another chain.
  - The key is in `getOwners()` at `latest`.
  - The nonce is not below the Safe's `nonce()`, a check the service does not make. By default the nonce is the highest queued nonce plus one, or the Safe's nonce when nothing is queued, as api-kit's `getNextNonce` does.
  - The refund fields (`safeTxGas`, `baseGas`, `gasPrice`, `gasToken`, `refundReceiver`) are zero.
  - `operation` is 0, unless `--delegatecall` is passed.
  - The hash computed with viem equals the Safe's own `getTransactionHash`.
- **Checks after it signs.** `v` is 27 or 28, the signature recovers to the key, and an `eth_call` of the Safe's `checkNSignatures(hash, 0x, signature, 1)` passes. Only then is the proposal posted.
- **What the task prints.** The Safe, its version, threshold and owners, the transaction, the SafeTx hash, the signer and the Safe app link (`https://app.safe.global/transactions/tx?safe=<shortName>:<safe>&id=multisig_<safe>_<hash>`). When the key's signature alone meets the threshold, posting it publishes a signature that anyone can execute. In that case the task asks at a terminal first, with the confirmation helper of decision 0023, unless `--yes` is passed. Without a terminal it refuses unless `--yes` is passed.
- **The API key** is `configVariable("SAFE_API_KEY")` in the package's config section, never a literal: config validation refuses a string. It is sent only as `Bearer` to the configured service, and is never logged or put in an error. A self-hosted service can be set per chain id, and then needs no key. Errors show the HTTP status and the service's `nonFieldErrors` text, which names only on-chain owners and hashes. A 429 says that the quota ran out.
- **A library helper**, `proposeSafeTransaction({ provider, sender, safe, call, service })`, takes any EIP-1193 connection. A hardhat-deploy 2.x integration can call it from `onUnknownSigner` later; that is a separate issue. Ignition needs a strategy inside Ignition, which plugins cannot add, so it is out of scope until the Hardhat team answers.

## Consequences

- A project that does not install the package gets no change. A project that installs it gets one package whose only runtime dependency is a peer the user has.
- The plugin owns its copy of the Transaction Service API. A change to the v2 body or to the error shape breaks proposals until the package follows. The conformance test against api-kit catches a change in api-kit when its devDependency is updated; a change in the service itself shows only against the live service.
- Owners and the threshold are read at `latest` on the user's RPC, as the service reads them. An owner change between the check and the service's check makes the service refuse the proposal; nothing is signed twice.
- Without `--yes`, a 1-of-N Safe needs a person to propose, because each such proposal is an executable authorization. CI that proposes to a 1-of-N Safe must pass `--yes`, and that shows in the workflow.
- Only Safes 1.3.0 to 1.5.0 are supported, which leaves out Safes from before 2021 and zkSync's own deployments. Each new Safe version needs a new entry, a test against its bytecode, and checks that the type hash and the domain are unchanged.
- Revisit if the package needs much more of the API, such as confirming other owners' proposals, delegates, messages or multi-send batches, where typed SDK bodies would pay for the dependency. Revisit too if Safe changes the `SafeTx` type or makes proposals require something the client does not send.

## Still open after the spike

- One real proposal on Sepolia, which needs a Safe owned by the test KMS key and a Safe API key in the owner's environment. The issue's acceptance criteria require it.
- Whether an unkeyed POST is accepted. This decides whether the API key is required or recommended.
- Whether the live service accepts the client's body byte for byte as api-kit's: the conformance test is not written yet.
