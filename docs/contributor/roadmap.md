# Roadmap and milestones

Audience: Anyone planning work on the project.

Status: Live status is on the [GitHub milestones](https://github.com/aelmanaa/hardhat-kms/milestones).

## Roadmap

| Release        | Scope                                                                                                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1.1           | `connection.kms.getAccount(addr)`, a viem-compatible `LocalAccount` with `signAuthorization` for library use. An Alchemy Wallet APIs recipe in the docs. `kms accounts --balances` and `--check-sign`.                                                                                                                    |
| v1.1 or v1.2   | Turnkey provider: an address-pinned adapter with no public-key call. It returns `{r, s, v}`, which the core re-normalizes and verifies. It can use the structured `signTransaction`/`signTypedData` so Turnkey policies see the full request. `TURNKEY_API_PRIVATE_KEY` must be a config variable and is never displayed. |
| v1.3           | Fireblocks provider, with `broadcast` and `raw` modes.                                                                                                                                                                                                                                                                    |
| v2 (on demand) | An Alchemy or smart-account send mode.                                                                                                                                                                                                                                                                                    |

Other candidates are PKCS#11 HSMs, whose raw r‖s output fits the contract. HashiCorp Vault transit is not a candidate, because it has no secp256k1 support.

Upstream, the project proposes that Hardhat export its transaction filler or add a post-fill signing stage. If Hardhat accepts, the ported fill logic goes away. The issue is filed during milestone M5, once the port exists and the proposal can point at working code.

## Milestones

The critical path runs M0, M1, M2, M3, M4, M5, M9, M10. M6 can start after M3 and run in parallel. The live-test infrastructure for M9 (OIDC, keys, Sepolia funding) is set up during M3 to M5.

| Milestone | Scope                                                                                                                  | Exit criteria                                                                                                                                                                   | Effort |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M0        | Scaffolding, M0 gates, CI, Dependabot, docs skeleton, empty plugin, consumer typecheck                                 | Gates green; the plugin loads in an HRE from `createHardhatRuntimeEnvironment`; consumer `tsc` passes on TS 5.9, 6.0 and 7.0                                                    | M      |
| M1        | `crypto/`, `signer/`, vendored EIP-712                                                                                 | Vectors, fast-check properties, at least 95% coverage, EIP-712 equivalence                                                                                                      | M      |
| M2        | Config, named keys, masking, Foundry helper, descriptors and registry, `kms` hook, errors, debug                       | Config errors at the exact path; descriptors import no SDK; the hook seam works                                                                                                 | M      |
| M3        | AWS adapter and LocalStack                                                                                             | Fake-client unit tests (DIGEST, ARN from `GetPublicKey`, key spec); LocalStack green, including high-S                                                                          | M      |
| M4        | RPC accounts, messages, typed data, chain-id guard, dispatcher                                                         | Message byte equivalence; on-chain `ecrecover` on EDR                                                                                                                           | M      |
| M5        | Transactions: filler, `eth_sendTransaction`/`eth_signTransaction`, send guard, error discipline, all transaction types | Raw transaction byte equivalence; differential fill test on the Hardhat floor and latest; parallel nonces; no double broadcast on viem retry; viem, ethers and Ignition deploys | L      |
| M6        | GCP and Azure adapters                                                                                                 | Fake clients including corrupted CRC; `hardhat run` exits; Azure managed identity timeout                                                                                       | L      |
| M7        | Tasks                                                                                                                  | An integration test per task; `--no-hash` only in `kms sign`; chain 0 needs `--force`                                                                                           | M      |
| M8        | Docs                                                                                                                   | jsdoc lint passes; a walkthrough of the docs works end to end                                                                                                                   | M      |
| M9        | Live Sepolia tests (AWS, GCP, Azure) via GitHub OIDC                                                                   | All transaction types and signatures verified on chain; `docs/live-proof.md` written                                                                                            | M      |
| M10       | Release: changesets, trusted publishing, release candidate, then 1.0.0                                                 | Dry-run publish; the release candidate installs cleanly                                                                                                                         | S      |
