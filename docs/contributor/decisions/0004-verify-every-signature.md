# 0004: Recover the parity against the known key and verify every signature

Status: Accepted

## Context

Cloud KMS services return signatures without a recovery bit, in different encodings (DER from AWS and GCP, 64-byte `r || s` from Azure), and they may return high-S values: about half of the signatures from LocalStack's AWS KMS emulation are high-S. A signature from the wrong key, or a guessed recovery bit, gives a transaction from a different sender or an invalid signature, and without a local check neither is caught before it reaches the chain.

## Decision

Every signature goes through one pipeline in `signer/`: strict parse, range check, low-S normalisation, trial recovery of the parity against the key's known public key (or pinned address), and a final verification. The parity is never guessed. A signature that fails any step gets one fresh attempt, then an error. Messages and typed data are checked again with micro-eth-signer's EIP-191 and EIP-712 verifiers, the library Hardhat's local accounts use.

## Consequences

- No signature leaves the plugin unless it recovers to the account's address.
- Each signature costs a few public-key recoveries and one verification, all local.
- Adapters stay thin: they translate wire formats and never decide whether a signature belongs to the key.
