# Design review round 2 — implementability, complexity, milestones

Verified against contrib-hardhat@738db95 + npm:
- Fill port unavoidable (our hook always runs before built-ins; hardhat-ledger throws MISSING_TX_PARAM_TO_SIGN_LOCALLY instead of filling, handler.ts:726-770); ~480 LOC to port.
- `@nomicfoundation/hardhat-test-utils` is private / not on npm → write our own helpers.
- Unsigned 7702 authorization entries over RPC are non-standard (`rpcAuthorizationListTuple` requires yParity/r/s; no client emits them).
- micro-eth-signer 0.19 does not export typed-data hashing → vendoring justified. `hardhat-kms` free on npm.

## Complexity decisions
| Item | Verdict |
|---|---|
| Fill port + drift watch | Keep port; replace blob-hash watch with the differential test run against floor and `hardhat@latest` (Dependabot bumps = drift alarm); file upstream issue at M0 |
| Send guard (lock + nonce high-water) | Keep (~60 LOC) |
| Idempotency cache | Simplify for v1: non-retryable numeric code (-32000) + local tx hash on every post-sign failure (viem retries only -1/-32005/-32603); prove with a hardhat-viem HTTP test injecting a timeout on sendRawTransaction; defer cache to v1.1 unless the test shows a retry path |
| `kms` hook category | Keep thin: `hre.hooks.runHandlerChain("kms","createKeyAdapter",…, registryDefault)`; `@experimental` until v1.1 |
| Vendored EIP-712 | Keep verbatim + equivalence test |
| Tasks (7) | Keep all; defer `accounts --balances/--check-sign` to v1.1 |
| RPC auto-sign unsigned 7702 | Defer; parity via `kms sign-auth --self-broadcast` + signed authorizationList, and v1.1 `getAccount().signAuthorization` |
| Foundry env helper, Azure chain | Keep (parity) |
| Stryker | Defer to post-M9 nightly |
| TS7 `.ts` specifiers in .d.ts | Keep; gate at M0 with consumer typecheck smoke test on TS 5.9 and 6 |
| GCP unref / `hardhat run` exits | Keep, test in M6 |

## Milestones
| M | Scope | Exit | Reviewers |
|---|---|---|---|
| M0 | Scaffolding, all gates, CI, Dependabot, docs skeleton, empty plugin, consumer typecheck smoke, upstream filler issue | gates green; empty plugin loads in fixture HRE; consumer tsc on TS 5.9/6 | toolchain/supply chain; Hardhat conventions |
| M1 | crypto/ + signer/ + vendored EIP-712 | vectors, fast-check, ≥95% coverage, 712 equivalence | crypto ×2; test quality |
| M2 | config, named keys, masking, Foundry helper, descriptors/registry, kms hook, errors, debug | exact-path config errors; descriptors import no SDK; hook seam works | Hardhat conventions; API/DX; security |
| M3 | AWS adapter + LocalStack | fake-client unit tests (DIGEST, ARN from GetPublicKey, key spec); LocalStack green incl. high-S | crypto; AWS; security |
| M4 | RPC accounts/messages/typed data/chain-id guard/dispatcher | message byte-equivalence; on-chain ecrecover on EDR | Hardhat conventions; crypto |
| M5 | Transactions: filler, send/signTransaction, send guard, error discipline, all tx types | raw tx byte-equivalence; differential vs floor/latest; parallel nonces; viem retry no double broadcast; viem/ethers/Ignition deploys | Hardhat internals; security/concurrency; test quality |
| M6 | GCP + Azure adapters | fake clients incl. corrupted CRC; `hardhat run` exits; Azure MI timeout | crypto; GCP/Azure; security |
| M7 | Tasks | integration test per task; `--no-hash` only in `kms sign`; chain 0 needs `--force` | DX; parity |
| M8 | Docs | jsdoc lint; docs-driven walkthrough | docs; security; parity |
| M9 | Live Sepolia (AWS/GCP/Azure) via GitHub OIDC | all tx types + signatures verified on chain; docs/live-proof.md | security (IAM); test quality |
| M10 | Release (changesets, trusted publishing, rc → 1.0.0) | dry-run publish; rc installs clean | supply chain |

Effort: M0 M · M1 M · M2 M · M3 M · M4 M · M5 L · M6 L · M7 M · M8 M · M9 M · M10 S. Critical path M0→M1→M2→M3→M4→M5→M9→M10; M6 after M3 in parallel; M9 infra (OIDC, keys) during M3–M5.

## Blocking decisions (recommended)
1. Tests in top-level `test/` mirroring `src/`, plus `test/helpers`, `test/fixture-projects`, `test/localstack`, `test/live`.
2. `.ts` import specifiers everywhere; lint-ban `.js` relative imports.
3. Own `test/helpers/assertions.ts` (~50 LOC); MIT notice if anything is copied.
4. Vendored code in `src/internal/vendor/micro-eth-signer/typed-data.ts` verbatim with SPDX MIT header + upstream URL/version; `THIRD_PARTY_NOTICES.md`; exempt from oxfmt/jsdoc, keep in coverage.
5. `declare module "hardhat/types/hooks" { interface HardhatHooks { kms: KmsHooks } }`; public types in `types.ts`, `@experimental`.
6. Peer `hardhat ^3.18.0`; CI floor + latest.
7. Package name reservation at M0 (NOTE: publishing requires the owner's OK).
8. Live-test infra owner (accounts, keys, OIDC, Sepolia funding) — start during M0.
