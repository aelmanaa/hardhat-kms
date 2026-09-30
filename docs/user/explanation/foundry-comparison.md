# Comparison with Foundry

Audience: Users choosing between Foundry and Hardhat for KMS signing.

Status: Planned for 1.0.

## Differences from Foundry

The README lists these so users can compare:

- GCP CRC32C integrity checks. Foundry has none.
- Post-sign verification of every signature. Foundry's Turnkey signer has none.
- Per-call timeouts on every provider.
- Multiple keys for every provider. Foundry allows one GCP key and one Turnkey key.
- An account listing that checks access.
- A `public-key` command.
- A chain-id guard on typed data.
- Protection against double broadcast when a client retries a send.
