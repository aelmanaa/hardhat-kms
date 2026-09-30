# Tasks reference

Audience: Users running the `kms` tasks.

Status: Planned: M7.

## Tasks

All tasks live in the `kms` namespace, which is an `emptyTask` in the same style as the keystore plugin.

| Task                                                                                   | Purpose                                                                                                            | Foundry equivalent                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `kms accounts [--network n] [--json] [--show-ids]`                                     | Every configured key with provider, pinned id and address. Checks access and prints ready-to-paste `address` pins. | `cast wallet list/address` (no access check)            |
| `kms address <key>` / `kms public-key <key>`                                           | The address, or the uncompressed public key.                                                                       | `cast wallet address`; no equivalent for the public key |
| `kms sign <key> <message> [--typed-data file] [--no-hash]`                             | EIP-191, EIP-712, or a raw 32-byte digest. `--no-hash` exists only here, as an explicit human action.              | `cast wallet sign [--data] [--no-hash]`                 |
| `kms sign-auth <key> <delegate> --chain <id> [--nonce n] [--self-broadcast] [--force]` | EIP-7702 authorization. Chain 0 requires `--force`; `--self-broadcast` uses nonce+1.                               | `cast wallet sign-auth`                                 |
| `kms sign-tx <key> --network n <tx.json>`                                              | Filled and signed, not broadcast.                                                                                  | `cast mktx`                                             |
| `kms verify <address> <message> <signature>`                                           | Local signature verification.                                                                                      | `cast wallet verify`                                    |

Some task details matter for review:

- `kms accounts` without `--network` lists every network, deduplicated by key. It never silently skips a provider: a failure is shown next to the key it affects.
- `kms sign --typed-data` without `--network` has no connection to compare chain ids against, so it requires `--chain` or `--allow-cross-chain`.
- An address-pin mismatch prints both addresses and a hint about key rotation or a repointed alias.
- `displayMessage` output appears only on the first resolution of a key or for KMS calls that take longer than 2 s.

`kms accounts --balances` and `--check-sign` are planned for v1.1.
