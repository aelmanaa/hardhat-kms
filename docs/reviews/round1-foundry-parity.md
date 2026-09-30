# Foundry feature parity (round 1)

Sources: foundry-core `origin/main@d39598d` (crates/wallets), our Azure branches, alloy signer crates, cast/forge 1.8.1 `--help`.

## Foundry capabilities per provider
| Capability | AWS | GCP | Azure (our PR) | Turnkey |
|---|---|---|---|---|
| Key selection | `AWS_KMS_KEY_ID`; `AWS_KMS_KEY_IDS` (comma list) for scripts/list only; key id / ARN / alias / alias ARN | `GCP_PROJECT_ID`, `GCP_LOCATION`, `GCP_KEY_RING`, `GCP_KEY_NAME`, `GCP_KEY_VERSION` (u64); one key | `AZURE_KEY_VAULT_KEY_IDS`/`_ID` (full key-id URLs); N keys | `TURNKEY_API_PRIVATE_KEY`, `TURNKEY_ORGANIZATION_ID`, `TURNKEY_ADDRESS`; one key |
| Version/rotation | alias retarget → recovery fails | explicit version | optional version; resolved once + pinned; response version checked; Managed HSM | address trusted, never verified |
| Credentials | aws-config default chain; region from env/profile only | Google ADC | secret → workload → az/azd → managed identity (10 s timeout; `AZURE_CLIENT_ID` user-assigned) | API private key from env |
| Send legacy/2930/1559/4844/7702 | all (`--legacy`, `--access-list`, `--blob`, `--auth`) | all | all | all |
| Sign w/o sending | `cast mktx` | yes | yes | yes |
| EIP-191 / EIP-712 / raw hash (`--no-hash`) | `cast wallet sign [--data] [--no-hash]` | yes | yes | yes |
| 7702 authorization | `cast wallet sign-auth` (`--nonce`, `--self-broadcast`, `--chain`, chain 0 needs `--force`); `cast send --auth <addr>` | yes | yes | yes |
| Get address | `cast wallet address` | yes | yes | echo env |
| Get public key | no | no | no | no |
| List | configured ids only (no enumeration) | configured only | configured only | bug: prints nothing (fixed by our foundry#17169) |
| Multi-signer scripts | N keys, `from` matched; unmatched → "No associated wallet … Unlocked wallets" | 1 | N | 1 |
| Chain id | tx chain id; conflicting signer chain id rejected | same | same | same |
| Low-S / recovery | DIGEST, low-S, trial recovery | low-S, recovery, NO CRC32C | low-S, recovery, x-reduced ids rejected | trusts r/s/v, no recovery check, no low-S |
| Timeouts | none | none | MI 10 s | none |

## Gaps to close in hardhat-kms (priority order)
1. Foundry env-var migration: `kms.fromEnv` / helper expanding `AWS_KMS_KEY_IDS`, `GCP_*`, `AZURE_KEY_VAULT_KEY_IDS`, `TURNKEY_*` (comma-split, trimmed).
2. GCP component form (projectId/location/keyRing/keyName/keyVersion) and Azure single `keyId` URL form (versioned or not, Managed HSM hosts).
3. `kms` task namespace: `kms address`, `kms public-key` (Foundry lacks it), `kms sign <msg> [--typed-data file] [--no-hash]`, `kms sign-auth <addr> [--nonce] [--self-broadcast] [--chain] [--force for chain 0]`, optional `kms verify`.
4. Sign without sending: `eth_signTransaction` + `kms sign-tx` task.
5. 7702 with the sender's own key: unsigned `authorizationList` entry + KMS sender → sign with sender key (nonce+1), like `--auth <addr>`.
6. Azure credential order: replicate secret → workload → az/azd → managed identity (10 s) with `ChainedTokenCredential`, `AZURE_CLIENT_ID` for user-assigned.
7. AWS: honour `AWS_ENDPOINT_URL_KMS` (LocalStack), optional `profile`, default-chain region when `region` omitted.
8. Error parity: config errors at exact paths; unknown `from` → list loaded KMS addresses.
9. 4844: document as unsupported (Hardhat core doesn't support it either).
10. README "why switch": CRC32C, post-sign verification, timeouts, multiple GCP keys, working listing.

## Turnkey
Fits as a 4th adapter (roadmap, needs an account): `getPublicKey` optional when an `address` pin is required (verify by recovering the first signature); accept `{r,s,yParity}` (core re-normalizes + re-derives); structured `signTransaction`/`signTypedData` capabilities let Turnkey policies see recipient/value/calldata (better than Foundry's blind hash). `TURNKEY_API_PRIVATE_KEY` is a real secret → must be a `configVariable`, never displayed.

## Foundry bugs not to copy
`cast wallet list --turnkey` printed nothing (fixed in our PR #17169); single-signer commands ignore `AWS_KMS_KEY_IDS`; `--all` silently skips providers with unset env vars.
