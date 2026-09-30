# Design review round 2 — traceability audit of DESIGN v1

Legend A addressed · P partial · N not · R rejected (reason given) · D deferred. Checked against contrib-hardhat@738db95.

## Gaps (P/N) per review

- Architecture: S4 third-party provider ids can't pass the built-in `conditionalUnionType` (P); S6 `eth_signTransaction` placed under the lock (contradicts "no lock") (P); S10 `npmPackage` never mentioned (P); `kms accounts` with no network undefined (P); `displayMessage` >2 s policy missing (N); pin-mismatch message content missing (P); `simulatedBalance` trigger unspecified (P).
- Security: B1 cache design creates a silent-drop bug (P); B2 "separate processes not coordinated" doc line missing + high-water unsafe on EDR (P); S1 no 7702-authorization final check (P); S3 strict hex decoding not stated, pre-signed 7702 tuple lint missing (P); S5 "narrow credential chains" not in docs (P); S6 GCP `Promise.race` missing (P); S7 exact micro-eth-signer pin / vectors vs installed Hardhat (P); N1 SDK floor/max CI job missing (P); N2 `eth_signTransaction` on by default without reason (N).
- Toolchain: 9 random LocalStack port (P); 10 coverage excludes (P); 11 missing negative tests (wrong-key adapter, pin mismatch, AbortSignal via injected clock, no retry after send) (P); 12 fresh connect per test / concurrency:false / quoted globs (P).
- Parity: env helper omits TURNKEY_* (D), returns literals (defeats masking), clashes with `node/no-process-env` (P); Azure chain composition + AWS region precedence unspecified; Foundry "`--all` silently skips" not guarded (N).

## Contradictions

1. High-water/idempotency keyed by chainId but process-global/per-HRE: all EDR instances are 31337 → future nonces hang tests; forks share chain ids with real networks.
2. Idempotency cache records every send → deliberate identical sends within 120 s silently dropped.
3. 7702 self-auth (auth nonce N+1) leaves account at N+2 but high-water advances to N; lock allow-list says "the KMS signature" (singular) but self-auth + retries need several.
4. `eth_signTransaction` under the lock vs A-S6/S-N2.
5. Clients closed on `closeConnection` but shared per HRE → one close kills others.
6. Turnkey: optional `getPublicKey` vs pipeline requiring a cached public key.
7. Third-party providers vs `conditionalUnionType` over the internal registry.
8. No SDK peer dep vs runtime `import()` → fails under pnpm strict / Yarn PnP; `semver` not a dependency.
9. `sdk {pkg, range}` vs `packageName` naming drift.
10. `kms.allowCrossChainTypedData` / `kms.simulatedBalance` not in config docs/schema.
11. "Bypasses ChainIdValidator" only true for message signing (fill reads re-enter and trigger it on http networks).

## Proposed rules

- Idempotency: create an entry ONLY when an error is thrown after `next(eth_sendRawTransaction)`; consume on first hit; TTL 120 s; key (connection, chainId, from, canonical JSON of caller params); successes never recorded.
- High-water: key (connection, from); disabled on `edr-simulated`; after send `hw = max(hw, usedNonce + selfAuthCount)`; caller nonce sets `hw = max(hw, nonce)`; lock stays process-global on `chainId:from`.
- Chain-id check: memoized promise per NetworkConnection (WeakMap), before the first KMS signature incl. pin check; fail closed, never cache failure; `kms sign --typed-data` without `--network` needs `--chain` or `--allow-cross-chain`.
- Masking: `ResolvedConfigurationVariable` has no `name` → descriptors capture `ConfigurationVariable.name` into `{value, maskedAs}`; derived ids inherit masks; Foundry helper emits `configVariable(...)` for single-value vars.
- Azure: `ChainedTokenCredential(EnvironmentCredential, WorkloadIdentityCredential, AzureCliCredential, AzureDeveloperCliCredential, ManagedIdentityCredential({clientId}))`, MI `getToken` wrapped in 10 s timeout; missing env → CredentialUnavailableError.
- GCP: refcount + idle close (~5 s, `unref`), lazy re-create; or `{fallback: true}` (REST).
- AWS region precedence: ARN region > key.region > defaults.aws.region > SDK chain; conflict with ARN → fail; leave `AWS_ENDPOINT_URL_KMS` to the SDK.
- Key cache key: (provider, configured canonical id after `.get()`) + secondary index by resolved ARN/version.
- SDK resolution: `createRequire(<project root>/package.json).resolve(pkg)`; version by walking up from the resolved path.
- 7702 auto-sign: tx chainId (never 0) + `getAuthority === from` + low-S.

## Verification

emptyTask ✔ (config.ts:87; keystore index.ts:19); micro-eth-signer 0.19 `core/typed-data.js` MIT, 327 lines, BUT imports `../advanced/abi-mapper.js` (179 lines, needs `micro-packed`) → vendoring closure ~500 lines; `conditionalUnionType` ✔ (:84), `validateUserConfigZodType` ✔ (:206); plugin-owned hook categories feasible (HardhatHooks mergeable; HookManager iterates any key) but no community plugin does it; `hre.hooks.registerHandlers` ✔ (types/hooks.ts:286); ChainIdValidatorHandler validates once on the first non-eth_chainId/net_version request.
