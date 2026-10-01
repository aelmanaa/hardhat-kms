# Comparison with Foundry

Audience: Users choosing between Foundry and Hardhat for KMS signing.

Status: Implemented. Every difference below is on `main`.

## Differences from Foundry

What hardhat-kms adds over Foundry's KMS signers:

- GCP CRC32C integrity checks. Foundry has none.
- Post-sign verification of every signature. Foundry's Turnkey signer has none.
- Per-call timeouts on every provider.
- Multiple keys for every provider. Foundry allows one GCP key and one Turnkey key.
- An account listing that checks access.
- A `public-key` command.
- A chain-id guard on typed data.
- Protection against double broadcast when a client retries a send.
