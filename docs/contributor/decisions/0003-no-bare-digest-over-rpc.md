# 0003: No RPC method signs a bare digest

Status: Accepted

## Context

A KMS key controls funds. Any script or dependency in a Hardhat project can send JSON-RPC requests to the connection. If one method signed an arbitrary 32-byte digest, that code could get the key to sign any transaction or permit it had built and hashed itself.

## Decision

Over RPC, the plugin signs only structured requests: transactions it filled itself, EIP-191 messages (always prefixed) and EIP-712 typed data. Signing a raw digest is possible only through the `kms sign --no-hash` task, which a person runs explicitly.

## Consequences

- `eth_sign` and `personal_sign` both use EIP-191, as Hardhat core does.
- Tools that expect raw digest signing over RPC do not work with KMS accounts, by design.
