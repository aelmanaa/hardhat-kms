# 0003: No RPC method signs a bare digest

Status: Accepted

## Context

A KMS key controls funds. Any script or dependency in a Hardhat project can send JSON-RPC requests to the connection. If one method signed an arbitrary 32-byte digest, that code could get the key to sign any transaction or permit it had built and hashed itself.

## Decision

Over RPC, the plugin signs only structured requests: transactions it filled itself, EIP-191 messages (always prefixed) and EIP-712 typed data. Signing a raw digest is possible only through the `kms sign --no-hash` task, which a person runs explicitly.

## Consequences

- `eth_sign` and `personal_sign` both use EIP-191, as Hardhat core does.
- Tools that expect raw digest signing over RPC do not work with KMS accounts, by design.
- The task is not a barrier against code in the project: a script or dependency can run it with `hre.tasks.getTask(["kms", "sign"]).run({ noHash: true, ... })`. No RPC method signs a bare digest; `--no-hash` is reachable only through the task, from the CLI or from code that runs the task. It prints a warning to standard error each time and asks for no confirmation, as `cast wallet sign --no-hash` does, so that it works in CI.

## Later change

Noted on 2026-10-07. [0014](0014-library-account-raw-sign.md) adds a second route, so this record's "only through the task" no longer holds. A library account created with `connection.kms.getAccount(address, { rawSign: true })` also signs a raw digest, with a warning each time such an account is made. No RPC method signs one.
