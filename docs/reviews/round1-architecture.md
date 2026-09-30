# Design review round 1 — Hardhat architecture & DX

Reviewer: independent agent, against `contrib-hardhat@738db95`. NM = `hardhat/src/internal/builtin-plugins/network-manager`.

## BLOCKER
- **B1 Re-entrancy rules / deadlock.** `next` shares one index (`hook-manager.ts:201-209`), so internal calls must use `provider.request`, which re-enters our hook; `AsyncMutex` is not re-entrant (`hardhat-utils/src/synchronization.ts:578-607`); ledger holds its init mutex on every request (`hardhat-ledger/.../network.ts:61-89`). Rules: (1) default pass-through, intercept only accounts + signing methods; (2) init mutex only guards plain object construction; (3) per-address lock only for `eth_sendTransaction`, inside it only reads + exactly one `next(eth_sendRawTransaction)`; (4) internal fill calls re-enter the hook — test N parallel sends + reads, no deadlock.
- **B2 Lifetime.** `closeConnection` only fires on explicit `connection.close()`; the CLI never calls `process.exit` (`cli/main.ts:183`) → an open GCP gRPC channel can hang `hardhat run`; one `network.create()` per test file → per-connection memo refetches pubkeys (GCP 300 read QPM). Cache clients + pubkeys per HRE (hook-factory closure) keyed by (provider, pinned id); unref/close idle; test that `hardhat run` exits after a GCP call.

## SHOULD
- **S1 Config.** Keep per-network `kmsAccounts`; add top-level `kms` with provider `defaults` and named `keys` referenced by name. One schema rooted at `HardhatUserConfig` via `validateUserConfigZodType`; `conditionalUnionType` on `provider`; `superRefine` named-key refs with path `["networks", n, "kmsAccounts", i]`. Warn when set on the `default` edr network.
- **S2 Identifiers vs `configVariable`.** Key ids aren't secrets: accept `string | ConfigurationVariable`; display variable-sourced ids as `<VAR_NAME>` unless `--show-ids`.
- **S3 Fill-logic port drift.** Faithful port impossible via public API (`InternalCallOutOfGasError` not exported; EDR duck-typing; partial 1559 handling; `multiplied-gas-estimation.ts` changed 3x recently). Put it behind a `TransactionFiller`, pinned to an upstream commit; differential test (HTTP network: key as local account vs fake KMS → identical filled fields + unsigned bytes); CI drift watch on upstream blob hashes; propose upstream an exported filler / post-fill sign stage.
- **S4 Providers + seam.** Light descriptor `{id, userSchema, resolve, sdk:{pkg,range}, load: () => import("./adapter.js")}` (config hooks import descriptors only); declaration-merged `KmsProviderUserConfigs` (like `VerificationProvidersConfig`, `hardhat-verify/src/type-extensions.ts:42`). Plugin-owned hook category `kms.createKeyAdapter(ctx, accountConfig, next)` → third-party provider plugins + test seam via `hre.hooks.registerHandlers("kms", …)` (`hardhat-viem/test/contracts.ts:276`). Contract: explicit signature format `{format:"der"|"compact", bytes} | {r,s,yParity?}` (yParity only a hint, still verified); optional `signTransaction(unsigned, digest)` / `signTypedData(payload, digest)` capabilities for policy engines/devices; `displayMessage` via deps; `describe()` → provider, pinned id, display id. Vault transit has no secp256k1 (don't list); PKCS#11 fits.
- **S5 EIP-712.** `ox` digest + runtime `verifyTyped` (micro-eth-signer 0.19, same path as core `local-accounts.ts:168-198`). Don't pin 0.14.
- **S6 `eth_signTransaction`.** Support (viem json-rpc `signTransaction`); fill the same way, no lock, no broadcast.
- **S7 Reads trigger KMS.** `AutomaticSenderHandler` calls `eth_accounts` for from-less `eth_call`/`eth_estimateGas` → read-only scripts need KMS creds unless addresses are pinned. Resolve keys in parallel, clear credential errors; `kms accounts` prints ready-to-paste pins.
- **S8 Chain-id safety.** Message/typed-data signing never reaches `ChainIdValidatorHandler`; if network config has `chainId`, check `eth_chainId` before the first KMS signature of any kind.
- **S9 7702 authorizations.** Expose lazily `connection.kms.getAccount(addr)` → viem-compatible `LocalAccount` with `signAuthorization`.
- **S10 A2 & types.** No named exports in `type-extensions.ts`; provider-author types via a `hardhat-kms/types` subpath; set `npmPackage`; SDK peers optional in `peerDependenciesMeta`.

## NICE
- `kms` as `emptyTask` namespace; `kms accounts` across all networks (dedup), `--check-sign`, `--balances`, `--json`.
- `displayMessage` only for slow (>2 s) KMS calls or first resolution; otherwise debug.
- Per-provider error table (403/PERMISSION_DENIED → exact permission + ARN; missing creds → login command; wrong key spec; pin mismatch → both addresses + rotation hint).
- Opt-in `kms.simulatedBalance` (`hardhat_setBalance` on `newConnection`).
- Nonce high-water mark per address inside the lock; always honour caller nonce (Ignition).
- Keep `hook-handlers` segment in debug namespaces (N2).
- Byte-equivalence approach is sound (`EXTRA_ENTROPY = false`, `local-accounts.ts:38`).
- Justify `ox` as a new direct dependency (DM1).
