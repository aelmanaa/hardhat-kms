# Tasks reference

Audience: Users running the `kms` tasks.

Status: `kms address` and `kms public-key` are implemented ([#33](https://github.com/aelmanaa/hardhat-kms/issues/33)), and so is `kms sign` ([#34](https://github.com/aelmanaa/hardhat-kms/issues/34)). The other tasks are planned for M7.

## Tasks

All tasks live in the `kms` namespace, which is an `emptyTask` in the same style as the keystore plugin. `npx hardhat kms` lists the implemented ones.

| Task                                                                                   | Purpose                                                                                                            | Foundry equivalent                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `kms accounts [--network n] [--json] [--show-ids]`                                     | Every configured key with provider, pinned id and address. Checks access and prints ready-to-paste `address` pins. | `cast wallet list/address` (no access check)            |
| `kms address <key>` / `kms public-key <key>`                                           | The address, or the uncompressed public key.                                                                       | `cast wallet address`; no equivalent for the public key |
| `kms sign <key> <message> [--data [--from-file]] [--no-hash]`                          | EIP-191, EIP-712, or a raw 32-byte digest. `--no-hash` exists only here, as an explicit human action.              | `cast wallet sign [--data [--from-file]] [--no-hash]`   |
| `kms sign-auth <key> <delegate> --chain <id> [--nonce n] [--self-broadcast] [--force]` | EIP-7702 authorization. Chain 0 requires `--force`; `--self-broadcast` uses nonce+1.                               | `cast wallet sign-auth`                                 |
| `kms sign-tx <key> --network n <tx.json>`                                              | Filled and signed, not broadcast.                                                                                  | `cast mktx`                                             |
| `kms verify <address> <message> <signature>`                                           | Local signature verification.                                                                                      | `cast wallet verify`                                    |

## Naming a key

Tasks that take `<key>` accept the name of any key the plugin knows:

| Where the key is defined                    | Name to pass                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kms.keys`                                  | Its name in `kms.keys`, for example `deployer`.                                                                                                                                                                                                                                                                                                                    |
| An inline key in a network's `kmsAccounts`  | `<network>.kmsAccounts[<index>]`, for example `sepolia.kmsAccounts[1]`. A `kmsAccounts` entry that is a name refers to a key in `kms.keys`, so pass that name instead.                                                                                                                                                                                             |
| `--kms` ([configuration](configuration.md)) | The variable the key was read from. A list entry adds its 0-based index: `AWS_KMS_KEY_IDS[1]`, `AZURE_KEY_VAULT_KEY_IDS[0]`, and `AWS_KMS_KEY_ID[1]` or `AZURE_KEY_VAULT_KEY_ID[1]` when the single variable holds a comma-separated list. A single variable with one key id has no index: `AWS_KMS_KEY_ID`, `AZURE_KEY_VAULT_KEY_ID`. The GCP key is `GCP_KEY_*`. |

A `--kms` key can be named with or without `--network`. Quote names that contain `[` or `*`: zsh refuses them unquoted when no file matches.

```bash
npx hardhat kms address deployer
npx hardhat kms address 'sepolia.kmsAccounts[1]'
AWS_KMS_KEY_ID=alias/deployer npx hardhat --kms aws kms address AWS_KMS_KEY_ID
```

A name that matches no key fails with the names that do, and suggests a name that differs only in case. The list holds names only, never key ids:

```text
Error in community plugin hardhat-kms: unknown key "deployr". Known keys: deployer, ops, sepolia.kmsAccounts[1], AWS_KMS_KEY_ID.
```

A key in `kms.keys` can have the name of a `--kms` variable, such as `AWS_KMS_KEY_ID`. While `--kms` loads that variable, the name is ambiguous, and the task fails and asks you to rename the key in `kms.keys`.

## Output

A task prints its result alone on standard output, so a script can capture it with `$(npx hardhat kms address deployer)`. Status messages from the provider, such as a wait for a slow KMS, and notes from the task go to standard error with a `[hardhat-kms]` prefix. Errors go to standard error too, and the command exits with a non-zero code.

Each run creates its own KMS clients and closes them before it returns, so the command exits as soon as it has printed.

## `kms address`

```text
npx hardhat kms address <key>
```

Prints the key's address with its EIP-55 checksum:

```text
0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

The task asks the KMS for the key's public key and derives the address from it, even when the key has an `address` pin. If the pin differs from the derived address, the task fails with both addresses:

```text
Error in community plugin hardhat-kms: aws, check address, key aws:alias/deployer: the key derives to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, but the configured address is 0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826. If the key was rotated or an alias now points to another key, update the configuration.
```

AWS, Google Cloud and Azure keys all return a public key. A third-party provider may return only an address; the task then asks it for the address and checks the pin the same way. A provider that can return neither leaves only the pin: the task prints the pin and writes a note on standard error that it is not checked yet. The first signature checks it.

## `kms public-key`

```text
npx hardhat kms public-key <key>
```

Prints the key's uncompressed secp256k1 public key, 65 bytes: `0x04` followed by 128 lowercase hex digits.

```text
0x048318535b54105d4a7aae60c08fc45f9687181b4fdfc625bd1a753fa7397fed753547f11ca8696646f2f3acb08e31016afac23e630c5d11f59f61fef57b0d2aa5
```

The task checks the `address` pin as `kms address` does. A provider that returns only an address has no public key to print, so the task fails with `the provider returns only the key's address, not its public key`.

## `kms sign`

```text
npx hardhat kms sign <key> <message>
npx hardhat kms sign --data [--from-file] [--chain <id>] [--allow-cross-chain] <key> <typed-data>
npx hardhat kms sign --no-hash <key> <digest>
```

Prints the 65-byte signature `r || s || v` as `0x`-prefixed hex, with `v` 27 or 28, the form `personal_sign` and `cast wallet sign` return. For `kms sign deployer "hello world"` with the key of the examples above:

```text
0xa461f509887bd19e312c0c58467ce8ff8e300d3c1a90b608a760c5b80318eaf15fe57c96f9175d6cd4daad4663763baa7e78836e067d0163e9a2ccf2ff753f5b1b
```

Before it prints a signature, the task recovers the signer from it and checks that it is the key's address ([decision 0004](../../contributor/decisions/0004-verify-every-signature.md)).

| Input                 | What is signed                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `<message>`           | An EIP-191 message. A value that starts with `0x` is hex bytes; anything else is UTF-8 text, as in `cast`. |
| `--data <typed-data>` | EIP-712 typed data, as a JSON string, the format `eth_signTypedData_v4` takes.                             |
| `--data --from-file`  | EIP-712 typed data read from the JSON file `<typed-data>` names.                                           |
| `--no-hash <digest>`  | A raw 32-byte digest, `0x` and 64 hex digits, signed as it is. It cannot be combined with `--data`.        |

```bash
npx hardhat kms sign deployer "hello world"
npx hardhat kms sign deployer 0x68656c6c6f
npx hardhat kms sign --data --from-file --network sepolia deployer permit.json
```

### Typed data and chains

Typed data goes through the same chain check as `eth_signTypedData_v4` ([decision 0011](../../contributor/decisions/0011-typed-data-chain-check.md)). When `domain.chainId` is set, it must equal one of these, in this order:

1. `--chain <id>`, a decimal or `0x` hex chain id.
2. The chain of the `--network` connection, read with `eth_chainId`.

Without either, typed data that names a chain is refused, since there is nothing to compare it with:

```text
Error in community plugin hardhat-kms: kms sign: the typed data is for chain 1, and there is no chain to compare it with. Pass --network or --chain, or --allow-cross-chain to sign it for any chain
```

`--allow-cross-chain`, or `kms.allowCrossChainTypedData: true` in the config, signs typed data for any chain. Typed data without `domain.chainId` is signed with no check: the signature is valid on every chain. `--chain` and `--allow-cross-chain` apply only to `--data`.

### Raw digests

`--no-hash` signs any 32 bytes, and a digest can be the hash of a transaction or a permit. A dependency or script cannot reach this path: no RPC method signs a bare digest, and `kms sign --no-hash` is the only way ([decision 0003](../../contributor/decisions/0003-no-bare-digest-over-rpc.md)). Sign only a digest you computed yourself. The task prints a warning to standard error each time and refuses any value that is not exactly 32 bytes:

```text
[hardhat-kms] --no-hash signs the 32 bytes as they are, with no EIP-191 prefix. Sign only a digest you computed yourself: it can authorize a transaction or a permit.
```

## Details for the planned tasks

- `kms accounts` without `--network` lists every network, deduplicated by key. It never silently skips a provider: a failure is shown next to the key it affects.
- An address-pin mismatch prints both addresses and a hint about key rotation or a repointed alias, as in [`kms address`](#kms-address).
- `displayMessage` output appears only on the first resolution of a key or for KMS calls that take longer than 2 s.

`kms accounts --balances` and `--check-sign` are planned for v1.1.
