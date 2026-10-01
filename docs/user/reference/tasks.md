# Tasks reference

Audience: Users running the `kms` tasks.

Status: `kms address` and `kms public-key` are implemented ([#33](https://github.com/aelmanaa/hardhat-kms/issues/33)). The other tasks are planned for M7.

## Tasks

All tasks live in the `kms` namespace, which is an `emptyTask` in the same style as the keystore plugin. `npx hardhat kms` lists the implemented ones.

| Task                                                                                   | Purpose                                                                                                            | Foundry equivalent                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `kms accounts [--network n] [--json] [--show-ids]`                                     | Every configured key with provider, pinned id and address. Checks access and prints ready-to-paste `address` pins. | `cast wallet list/address` (no access check)            |
| `kms address <key>` / `kms public-key <key>`                                           | The address, or the uncompressed public key.                                                                       | `cast wallet address`; no equivalent for the public key |
| `kms sign <key> <message> [--typed-data file] [--no-hash]`                             | EIP-191, EIP-712, or a raw 32-byte digest. `--no-hash` exists only here, as an explicit human action.              | `cast wallet sign [--data] [--no-hash]`                 |
| `kms sign-auth <key> <delegate> --chain <id> [--nonce n] [--self-broadcast] [--force]` | EIP-7702 authorization. Chain 0 requires `--force`; `--self-broadcast` uses nonce+1.                               | `cast wallet sign-auth`                                 |
| `kms sign-tx <key> --network n <tx.json>`                                              | Filled and signed, not broadcast.                                                                                  | `cast mktx`                                             |
| `kms verify <address> <message> <signature>`                                           | Local signature verification.                                                                                      | `cast wallet verify`                                    |

## Naming a key

Tasks that take `<key>` accept the name of any key the plugin knows:

| Where the key is defined                    | Name to pass                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kms.keys`                                  | Its name in `kms.keys`, for example `deployer`.                                                                                                                        |
| An inline key in a network's `kmsAccounts`  | `<network>.kmsAccounts[<index>]`, for example `sepolia.kmsAccounts[1]`. A `kmsAccounts` entry that is a name refers to a key in `kms.keys`, so pass that name instead. |
| `--kms` ([configuration](configuration.md)) | The variable the key was read from: `AWS_KMS_KEY_ID`, `AWS_KMS_KEY_IDS[1]`, `AZURE_KEY_VAULT_KEY_ID`, or `GCP_KEY_*` for the GCP key.                                  |

A `--kms` key can be named with or without `--network`. Quote names that contain `[` or `*`: zsh refuses them unquoted when no file matches.

```bash
npx hardhat kms address deployer
npx hardhat kms address 'sepolia.kmsAccounts[1]'
AWS_KMS_KEY_ID=alias/deployer npx hardhat --kms aws kms address AWS_KMS_KEY_ID
```

A name that matches no key fails with the names that do. The list holds names only, never key ids:

```text
Error in community plugin hardhat-kms: unknown key "deployr". Known keys: deployer, ops, sepolia.kmsAccounts[1], AWS_KMS_KEY_ID.
```

A key in `kms.keys` can have the name of a `--kms` variable, such as `AWS_KMS_KEY_ID`. While `--kms` loads that variable, the name is ambiguous, and the task fails and asks you to rename the key in `kms.keys`.

## Output

A task prints its result alone on standard output, so a script can capture it with `$(npx hardhat kms address deployer)`. Errors go to standard error, and the command exits with a non-zero code.

Each run creates its own KMS clients and closes them before it returns, so the command exits as soon as it has printed.

## `kms address`

```text
npx hardhat kms address <key>
```

Prints the key's address with its EIP-55 checksum:

```text
0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

The task asks the KMS for the public key and derives the address from it, even when the key has an `address` pin. If the pin differs from the derived address, the task fails with both addresses:

```text
Error in community plugin hardhat-kms: aws, check address, key aws:alias/deployer: the key derives to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, but the configured address is 0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826. If the key was rotated or an alias now points to another key, update the configuration.
```

AWS, Google Cloud and Azure keys all return a public key. A third-party provider may return only an address; for such a key with a pin, the task prints the pin, and the first signature checks it.

## `kms public-key`

```text
npx hardhat kms public-key <key>
```

Prints the key's uncompressed secp256k1 public key, 65 bytes: `0x04` followed by 128 lowercase hex digits.

```text
0x048318535b54105d4a7aae60c08fc45f9687181b4fdfc625bd1a753fa7397fed753547f11ca8696646f2f3acb08e31016afac23e630c5d11f59f61fef57b0d2aa5
```

The task checks the `address` pin as `kms address` does. A provider that returns only an address has no public key to print, so the task fails with `the provider returns only the key's address, not its public key`.

## Details for the planned tasks

- `kms accounts` without `--network` lists every network, deduplicated by key. It never silently skips a provider: a failure is shown next to the key it affects.
- `kms sign --typed-data` without `--network` has no connection to compare chain ids against, so it requires `--chain` or `--allow-cross-chain`.
- An address-pin mismatch prints both addresses and a hint about key rotation or a repointed alias, as in [`kms address`](#kms-address).
- `displayMessage` output appears only on the first resolution of a key or for KMS calls that take longer than 2 s.

`kms accounts --balances` and `--check-sign` are planned for v1.1.
