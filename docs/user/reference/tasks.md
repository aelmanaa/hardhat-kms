# Tasks reference

Audience: Users running the `kms` tasks.

Status: `kms address` and `kms public-key` are implemented ([#33](https://github.com/aelmanaa/hardhat-kms/issues/33)), and so are `kms sign` ([#34](https://github.com/aelmanaa/hardhat-kms/issues/34)) and `kms verify` ([#37](https://github.com/aelmanaa/hardhat-kms/issues/37)). The other tasks are planned for M7.

## Tasks

All tasks live in the `kms` namespace, which is an `emptyTask` in the same style as the keystore plugin. `npx hardhat kms` lists the implemented ones.

| Task                                                                                   | Purpose                                                                                                            | Foundry equivalent                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `kms accounts [--network n] [--json] [--show-ids]`                                     | Every configured key with provider, pinned id and address. Checks access and prints ready-to-paste `address` pins. | `cast wallet list/address` (no access check)            |
| `kms address <key>` / `kms public-key <key>`                                           | The address, or the uncompressed public key.                                                                       | `cast wallet address`; no equivalent for the public key |
| `kms sign <key> <message> [--data [--from-file]] [--no-hash]`                          | EIP-191, EIP-712, or a raw 32-byte digest. `--no-hash` exists only here, as an explicit human action.              | `cast wallet sign [--data [--from-file]] [--no-hash]`   |
| `kms sign-auth <key> <delegate> --chain <id> [--nonce n] [--self-broadcast] [--force]` | EIP-7702 authorization. Chain 0 requires `--force`; `--self-broadcast` uses nonce+1.                               | `cast wallet sign-auth`                                 |
| `kms sign-tx <key> --network n <tx.json>`                                              | Filled and signed, not broadcast.                                                                                  | `cast mktx`                                             |
| `kms verify (--address a \| --key k) <message> <signature> [--data [--from-file]]`     | Local signature verification against an address or a key. No `--no-hash`.                                          | `cast wallet verify [--data [--from-file]]`             |

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

Before it prints a signature, the task recovers the signer from it and checks that it is the key's address ([decision 0004](../../contributor/decisions/0004-verify-every-signature.md)). This catches a wrong or substituted signature from the signer. It is not a second check of the digest, which the task computes with the same code as the signer.

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

Typed data goes through the same chain check as `eth_signTypedData_v4` ([decision 0011](../../contributor/decisions/0011-typed-data-chain-check.md)). When `domain.chainId` is set, it must equal the chain given by one of these, which cannot be combined:

- `--chain <id>`, a decimal or `0x` hex chain id.
- `--network <name>`: the network's `chainId` in the config. When the config sets none, the task connects to the network and reads `eth_chainId`. Creating the connection runs the network hook, which can call the KMS, for example to fund the accounts of an `edr-simulated` network.

Without either, typed data that names a chain is refused, since there is nothing to compare it with:

```text
Error in community plugin hardhat-kms: kms sign: the typed data is for chain 1, and there is no chain to compare it with. Pass --network or --chain, or --allow-cross-chain to sign it for any chain
```

`--allow-cross-chain` signs typed data for any chain, and so does a project-wide `kms.allowCrossChainTypedData: true`: the config setting also applies to this task. Typed data without `domain.chainId` is signed with no check, and the task prints a note to standard error:

```text
[hardhat-kms] this typed data has no chain id: the signature is valid on every chain
```

`--chain` and `--allow-cross-chain` apply only to `--data`. JSON numbers above 2^53 - 1 are refused, since `JSON.parse` would round them; write such values as strings.

### Raw digests

`--no-hash` signs any 32 bytes, and a digest can be the hash of a transaction or a permit. No RPC method signs a bare digest. `--no-hash` is reachable only through the task, from the CLI or from code that runs the task ([decision 0003](../../contributor/decisions/0003-no-bare-digest-over-rpc.md)). Sign only a digest you computed yourself. The task prints a warning to standard error each time and refuses any value that is not exactly 32 bytes:

```text
[hardhat-kms] --no-hash signs the 32 bytes as they are, with no EIP-191 prefix. Sign only a digest you computed yourself: it can authorize a transaction or a permit.
```

## `kms verify`

```text
npx hardhat kms verify --address <address> <message> <signature>
npx hardhat kms verify --key <key> <message> <signature>
npx hardhat kms verify --data [--from-file] (--address <address> | --key <key>) <typed-data> <signature>
```

Recovers the address that signed the message or typed data and compares it with the expected signer. The check runs locally. Name the expected signer with exactly one of these options:

- `--address` takes the address to expect, and no KMS is contacted. An all-lowercase or all-uppercase address is accepted; a mixed-case one must have a correct EIP-55 checksum.
- `--key` takes a key name, as in [Naming a key](#naming-a-key), and gets the key's address as [`kms address`](#kms-address) does: from the public key, or from the address an address-only provider reports, checked against an `address` pin. The KMS never signs. If the provider can report neither, the signature is checked against the `address` pin, with a note on standard error that the pin itself is not confirmed.

The message and typed data are read as in [`kms sign`](#kms-sign):

| Input                 | What is verified                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `<message>`           | An EIP-191 message. A value that starts with `0x` is hex bytes; anything else is UTF-8 text, as in `cast`. |
| `--data <typed-data>` | EIP-712 typed data, as a JSON string, the format `eth_signTypedData_v4` takes.                             |
| `--data --from-file`  | EIP-712 typed data read from the JSON file `<typed-data>` names.                                           |

`--from-file` requires `--data`. JSON numbers above 2^53 - 1 are refused, since `JSON.parse` would round them; write such values as strings. Verifying typed data checks no chain: the domain's `chainId` is part of the signed digest, so a signature for another chain does not match. A message that starts with `-` goes after `--`, so that Hardhat does not read it as an option:

```bash
npx hardhat kms verify --address 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 "hello world" 0xa461…5b1b
npx hardhat kms verify --data --from-file --key deployer permit.json 0x…
npx hardhat kms verify --address 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 -- "-1 ETH" 0x…
```

The signature is 65 bytes, `r || s || v`, as `kms sign`, `personal_sign` and `eth_signTypedData_v4` return it. The task reads it as cast does, through alloy:

- `v` may be 27 or 28, the bare recovery bit 0 or 1, or an EIP-155 value of 35 or more, whose recovery bit is `(v - 35) % 2`. Any other `v` is refused.
- A high-S signature, the malleable twin of the low-S one, is accepted: it recovers the same address. On a match the task adds a note to standard error, since OpenZeppelin's `ECDSA.recover` rejects the high-S form, and gives the low-S form to use instead.
- A value that is not `0x`-prefixed hex, is not 65 bytes, or has `r` or `s` outside 1 to n - 1 is refused with an error that says which.

On a match the task prints one line to standard output and exits with code 0:

```text
Valid: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 signed this message.
```

On a mismatch it prints both addresses to standard error and exits with code 1:

```text
Invalid: the signature over this message recovers to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, not to the expected signer 0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826.
```

Invalid input also exits with code 1, with an `Error in community plugin hardhat-kms: kms verify:` message. As in cast, the exit code does not tell a mismatch from invalid input. From a script, `hre.tasks.getTask(["kms", "verify"]).run({ message, signature, address })` returns Hardhat's result object, `{ success: true, value: { address } }` or `{ success: false, error: { recovered, expected } }`, and throws only on invalid input.

Compared with `cast wallet verify`:

- The message, `--data` and `--from-file`, the `v` values and the high-S handling are the same.
- There is no `--no-hash`, on purpose. Only `kms sign --no-hash` handles raw 32-byte digests, as an explicit human action ([decision 0003](../../contributor/decisions/0003-no-bare-digest-over-rpc.md)). Verifying a signature over a raw digest may come later if users ask for it ([#31](https://github.com/aelmanaa/hardhat-kms/issues/31)).
- `--key` checks against a KMS key without copying its address.
- Only EOA signatures are checked. A smart-contract wallet's EIP-1271 `isValidSignature` is not called.

## Details for the planned tasks

- `kms accounts` without `--network` lists every network, deduplicated by key. It never silently skips a provider: a failure is shown next to the key it affects.
- An address-pin mismatch prints both addresses and a hint about key rotation or a repointed alias, as in [`kms address`](#kms-address).
- `displayMessage` output appears only on the first resolution of a key or for KMS calls that take longer than 2 s.

`kms accounts --balances` and `--check-sign` are planned for v1.1.
