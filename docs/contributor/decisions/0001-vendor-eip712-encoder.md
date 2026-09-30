# 0001: Vendor the EIP-712 encoder from micro-eth-signer 0.19

Status: Accepted

## Context

The plugin must produce the same `eth_signTypedData_v4` signatures as Hardhat's local accounts. Hardhat core hashes typed data with micro-eth-signer 0.19, but that version does not export its typed-data hashing.

The alternative, `ox`, pulls in about 30 MB of transitive dependencies (zod 4, post-quantum cryptography, bip39) and silently accepts fields that are not declared in `types`.

## Decision

Copy `src/core/typed-data.ts` and `src/advanced/abi-mapper.ts` from micro-eth-signer 0.19.0 into `packages/hardhat-kms/src/internal/vendor/micro-eth-signer/`, changing only import paths. Keep the MIT notice in each file and in `THIRD_PARTY_NOTICES.md`. Declare `micro-packed`, which the copied code imports, as an explicit dependency.

## Consequences

- Typed-data digests match Hardhat's byte for byte, with the same validation.
- The vendored files are excluded from formatting, linting, knip and the coverage threshold, and compile under their own relaxed `tsconfig.vendor.json`.
- Dependabot ignores micro-eth-signer 0.20 and later, and micro-packed 0.10 and later. Moving to a new version means re-copying the files and re-running the equivalence tests.
