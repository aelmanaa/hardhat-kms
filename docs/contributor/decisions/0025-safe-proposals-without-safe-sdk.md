# 0025: Propose Safe transactions from a separate package, without a Safe SDK

Status: Accepted (2026-11-02)

Issue: [#653](https://github.com/aelmanaa/hardhat-kms/issues/653)

## Context

Teams that deploy from a KMS key hand ownership to a Safe and send admin and upgrade calls through it. No Hardhat 3 tool proposes those calls to the Safe Transaction Service ([research](../research/smart-account-sends.md)). The spike for #653 measured what a proposer needs.

The Transaction Service:

- Base URL: `https://api.safe.global/tx-service/<shortName>`, with `sep` for Sepolia and `eth` for mainnet (api-kit 5.0.4, `dist/esm/index.mjs:87-153`). The legacy `https://safe-transaction-sepolia.safe.global` answers `308` to the gateway (one GET, 2026-11-02). The gateway does not serve every chain: Avalanche Fuji (43113) answers 404.
- A proposal is `POST /api/v2/safes/{safe}/multisig-transactions/` with the `SafeTx` fields, `contractTransactionHash`, `sender`, `signature` and `origin` (api-kit `index.mjs:655-682`). api-kit spreads protocol-kit's `SafeTransactionData`, whose amounts are decimal strings and whose `nonce` is a JSON number, in the key order of protocol-kit 8's `standardizeSafeTransactionData`. Every address, the one in the path included, must be EIP-55 checksummed. The service answers `201` with an empty body, or `422` with `{"nonFieldErrors": [...]}`.
- The service checks, in order (safe-transaction-service `1b78e0b8`, `history/serializers.py:207-325`): it recomputes the hash with the domain of the Safe's on-chain `VERSION()`; refuses a nonce only when a transaction it indexed as executed used it, with no check against the chain's nonce; requires the sender to be a current owner or a delegate; recovers each signature, where `v` 27/28 is EIP-712 and 31/32 is `eth_sign`; and requires the sender to be one of the signers.
- API key: `Authorization: Bearer <key>`, created at developer.safe.global. api-kit refuses to run without one for `api.safe.global` (`index.mjs:190-214`). The gateway answered an unkeyed GET with `x-ratelimit-limit: 5000` per 30 days. Safe's announcement puts unkeyed callers at 2 requests per second and keyed ones at 5 per second per chain. Whether an unkeyed POST is accepted was not tested.

The `SafeTx` type hash is the same from 1.0.0 to 1.5.0 (`0xbb8310d4…86d8`). The domain is `{verifyingContract}` before 1.3.0 and `{chainId, verifyingContract}` from 1.3.0 on (`DOMAIN_SEPARATOR_TYPEHASH` in each `Safe.sol`; protocol-kit 8.0.11 `getEip712TxTypes`). 1.5.0 was released on 2025-07-03 and does not change the type. viem's `hashTypedData` reproduces safe-eth-py's fixed vectors for 1.0.0 and 1.3.0.

The spike proved the signing path end to end, all of it local. A secp256k1 key in LocalStack's AWS KMS, used through `@hardhat-kms/aws`, owns 1-of-1 and 2-of-3 Safes 1.3.0, 1.4.1 and 1.5.0. Their runtime code hashes match the canonical `codeHash` in `@safe-global/safe-deployments` 1.37.66. The plugin's `eth_signTypedData_v4` signature:

- passes each Safe's `checkNSignatures`;
- is accepted by a fake service that applies the checks above;
- executes the 1-of-1 Safe's transaction alone;
- executes the 2-of-3 Safe's transaction together with a second owner's signature.

The SDK option: `@safe-global/api-kit` 5.0.4 with `protocol-kit` 8.0.11 installs 32 packages and 92 MB, 62 MB of it viem. api-kit sends requests with `node-fetch` 2 (`index.mjs:11`), not the global `fetch`, so it takes no `AbortSignal` and no timeout. `node-fetch` 2 also brings `tr46` 0.0.3, which loads the deprecated `punycode` module. protocol-kit adds `@peculiar/asn1-schema` for passkeys and the full `safe-deployments` table.

## Decision

- **A separate package, `@hardhat-kms/safe`.** It is a Hardhat plugin that loads hardhat-kms through `dependencies` and adds `kms safe propose`. Hardhat 3.20 inserts a plugin's tasks after its dependencies' tasks, so a subtask under `kms` works (`task-manager.js` `#insertTask`). It is released with the core at the same version, in the changesets `fixed` group, as decision 0009 sets for the provider packages. A `hardhat-kms/safe` subpath was rejected: a subpath cannot register a task unless the core registers it for everyone, and the core would then talk to a third-party HTTP API. `hardhat-kms/alchemy` is a pure check with no network and no task, so it is not a precedent here.
- **No Safe SDK**, as for Turnkey (decision 0019). The package has its own client for the two calls it makes: the highest queued nonce and the proposal. The client uses the global `fetch` with a timeout (`kmsSafe.timeoutMs`, 30 seconds by default) and an optional `AbortSignal`, and `redirect: "manual"`, so a redirect cannot carry the API key or the signed body to another host. It accepts only an https URL, or http on localhost, with no credentials, query or fragment. `viem` is a required peer dependency, for ABI encoding and an independent `hashTypedData`; the core already has viem as an optional peer. `@safe-global/api-kit` 5.0.4 is a devDependency only, for a conformance test: for the same SafeTx, the client's method, path, headers and body bytes equal api-kit's, its queued-transactions query equals api-kit's `getPendingTransactions` URL, and its chain table equals api-kit's.
- **What the key signs.** The `SafeTx` is EIP-712 typed data, signed with `eth_signTypedData_v4` through the connection, so the core's checks apply unchanged:
  - the typed-data chain check of decision 0011, since the domain names the chain;
  - the signature check of decision 0004.

  It is never a raw digest, so decisions 0003, 0014 and 0021 do not apply, and the package never asks for `rawSign`. The `eth_sign` form (`v + 4`) is not used.

- **Which key signs.** `--key` names it, as the core's `kms` tasks take a key. Without `--key`, the task uses the network's only KMS account, and refuses a network with none or several. `eth_accounts` alone cannot tell a node's own accounts from KMS accounts, so the core exports `kmsKeyAddress` from `hardhat-kms/provider-utils` (experimental). The task then refuses a key whose address is not among the connection's accounts.
- **Checks before the KMS signs.** Each one fails before any sign request:
  - The node's `eth_chainId` is a hex quantity, and equals the network's configured `chainId` when it has one.
  - Safe's hosted service serves the chain, or `kmsSafe.services` names a service for it. The hosted service needs `kmsSafe.apiKey`.
  - The Safe has code on that chain.
  - `VERSION()` is 1.3.0, 1.4.1 or 1.5.0, read before anything else of the Safe. Older Safes are refused: their domain has no `chainId`, so a signature also holds for a Safe at the same address on another chain.
  - The key is in `getOwners()` at `latest`.
  - The nonce is not below the Safe's `nonce()`, a check the service does not make, and not above 2^53 - 1, since the body carries it as a JSON number. By default the nonce is the highest queued nonce plus one, or the Safe's nonce when nothing is queued, as api-kit's `getNextNonce` does. The query asks for one result, ordered by nonce, from the Safe's on-chain nonce on. The service is trusted only to raise the nonce, by at most 50 (`MAX_QUEUE_AHEAD`); beyond that the task refuses and asks for `--nonce`, so a lying service cannot make the key sign for a far-future nonce. A service that hides a queued transaction can still make the key sign a second one at the same nonce; the other owners see both, and only one can run.
  - The refund fields (`safeTxGas`, `baseGas`, `gasPrice`, `gasToken`, `refundReceiver`) are zero. The input type has no field for them, so no caller can set them.
  - `operation` is the number 0, or 1 with `--delegatecall` (`allowDelegateCall` in the library); any other value, such as the string `"1"`, is refused. `value` is a bigint in the uint256 range and `to` an address, checked at run time for JavaScript callers.
  - Integers in `--args` are safe-integer JSON numbers or decimal or hex strings; a larger JSON number is refused, since `JSON.parse` has rounded it. The summary shows the function and each argument.
  - The hash computed with viem equals the Safe's own `getTransactionHash`.
- **Checks after it signs.** The signature is 65 bytes, `v` is 27 or 28, it recovers to the key, and an `eth_call` of the Safe's `checkNSignatures(hash, 0x, signature, 1)` passes. A revert and a failed call give different errors; both post nothing. Only then is the proposal posted.
- **One chain id.** The task reads `eth_chainId` once, checks it against the network's `chainId`, chooses the service for it, and passes it to the signing step, which refuses a node that answers another chain.
- **Threshold 1.** When the key's signature alone meets the threshold, posting it publishes a signature that anyone can execute. The task then shows the Safe, its owners, the call and the hash and asks at a terminal with the confirmation helper of decision 0023, which the core exports from `hardhat-kms/provider-utils`. Only `y` or `yes` signs. Without a terminal it refuses unless `--yes` is passed. Above threshold 1 it prints the same summary on standard error and does not ask.
- **The API key** is `kmsSafe.apiKey`, a `configVariable()`, never a literal: config validation refuses any other value. The docs name the variable `SAFE_TRANSACTION_SERVICE_API_KEY`. It is read only when a proposal goes to Safe's hosted service, sent only there as `Bearer`, and never logged or put in an error; a reason the service echoes is redacted. A self-hosted service can be set per chain id in `kmsSafe.services`; it gets no key, so a self-hosted service that needs one is not supported. The client reads at most 1 MiB of an answer.
- **Errors.** Every refusal comes from the package's catalogue (`safe.*`). HTTP answers map to catalogue errors: 401 and 403 to the API key, 400 and 422 to the service's reasons, 429 to the quota, 5xx to the service, and any other status, a redirect included, to an unexpected status. A 422 shows only allow-listed text: up to three `nonFieldErrors` and the `message`, cut to printable ASCII and a length, and the names of the fields the service refused. A failed request shows only its system error code, such as `ECONNREFUSED`. After the key signed, the error says whether the service may have stored the proposal. The client does not retry.
- **What the task prints.** On standard output: the SafeTx hash, the Safe, chain and nonce, the threshold and owners, the signer, and the Safe app link (`https://app.safe.global/transactions/tx?safe=<shortName>:<safe>&id=multisig_<safe>_<hash>`) for a chain of the hosted service. The Safe app's chain prefix is taken to be the service's short name.
- **A library helper**, `proposeSafeTransaction({ provider, sender, safe, call, service, nonce?, allowDelegateCall?, expectedChainId?, origin?, approve?, signal? })`, takes any EIP-1193 connection and a `TransactionServiceClient`. It runs the same checks, and asks no one: `approve` is called after the checks and before the key signs. A hardhat-deploy 2.x integration can call it from `onUnknownSigner` later; that is a separate issue. Ignition needs a strategy inside Ignition, which plugins cannot add, so it is out of scope until the Hardhat team answers.

## Consequences

- A project that does not install the package gets no change. A project that installs it gets one package with no runtime dependency, and peers it has or adds: Hardhat, hardhat-kms and viem.
- The plugin owns its copy of the Transaction Service API. A change to the v2 body or to the error shape breaks proposals until the package follows. The conformance test catches a change in api-kit when its devDependency is updated; a change in the service itself shows only against the live service.
- Owners and the threshold are read at `latest` on the user's RPC, as the service reads them. An owner change between the check and the service's check makes the service refuse the proposal; nothing is signed twice. If the owners later lower the threshold, a signed proposal can become executable with fewer signatures; that is inherent to signing a SafeTx.
- Without `--yes`, a 1-of-N Safe needs a person to propose, because each such proposal is an executable authorization. CI that proposes to a 1-of-N Safe must pass `--yes`, and that shows in the workflow.
- Only Safes 1.3.0 to 1.5.0 are supported, which leaves out Safes from before 2021 and zkSync's own deployments. Each new Safe version needs a new entry, a test against its bytecode, and checks that the type hash and the domain are unchanged.
- The chain table follows api-kit 5.0.4. A chain Safe adds later needs a table update or `kmsSafe.services`.
- Revisit if the package needs much more of the API, such as confirming other owners' proposals, delegates, messages or multi-send batches, where typed SDK bodies would pay for the dependency. Revisit too if Safe changes the `SafeTx` type or makes proposals require something the client does not send.

## Still open

- One real proposal on Sepolia, which needs a Safe owned by the test KMS key and a Safe API key in the owner's environment. The issue's acceptance criteria require it; the owner runs it.
- Whether an unkeyed POST is accepted. Until it is measured, the hosted service needs an API key, as api-kit requires.
- Whether the Safe app's chain prefix equals the service's short name on every chain. The link is not checked against the live app; the Sepolia proposal checks it for `sep`.
