---
title: Tasks reference
description: "hardhat kms history: who signed, from CloudTrail, Cloud Audit Logs or Azure Monitor, and the other kms tasks that list keys, sign and verify."
---

# Tasks reference

Audience: Users running the `kms` tasks.

Run `npx hardhat kms --help` to list the commands, and `npx hardhat kms <command> --help` for one command's options.

## Tasks

All tasks live in the `kms` namespace. Each command's section below gives its purpose, a basic example, its options, its output, and what it needs and how it fails, then advanced use.

| Task                                                                                                    | Purpose                                                                                                                                                                      | Foundry equivalent                                      |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `kms accounts [--network n] [--json] [--show-ids]`                                                      | Each configured key with its provider, key id and address. Checks access and prints ready-to-paste `address` pins.                                                           | `cast wallet list`; exits 0 when a source fails         |
| `kms address <key>` / `kms public-key <key>`                                                            | The address, or the uncompressed public key.                                                                                                                                 | `cast wallet address`; no equivalent for the public key |
| `kms sign <key> <message> [--data [--from-file]] [--no-hash]`                                           | EIP-191, EIP-712, or a raw 32-byte digest. Raw digest signing requires the explicit `--no-hash` option, which only this task has.                                            | `cast wallet sign [--data [--from-file]] [--no-hash]`   |
| `kms verify (--address a \| --key k) <message> <signature> [--data [--from-file]]`                      | Local signature verification against an address or a key. No `--no-hash`.                                                                                                    | `cast wallet verify [--data [--from-file]]`             |
| `kms sign-tx <key> <tx.json> --network n`                                                               | Filled on the network's node and signed, never sent. Prints the raw transaction, and its hash on standard error.                                                             | `cast mktx`                                             |
| `kms sign-auth <key> <delegate> (--chain <id> \| --network n) [--nonce n] [--self-broadcast] [--force]` | EIP-7702 authorization, as the JSON tuple `authorizationList` takes. Chain 0 requires `--force`; `--self-broadcast` signs for the pending nonce + 1. The task sends nothing. | `cast wallet sign-auth`                                 |
| `kms history <key> [--since t] [--until t] [--limit n] [--json] [--show-ids]`                           | The key's sign events, read from the provider's audit log.                                                                                                                   | none                                                    |

## Which commands need a network

`--network` is Hardhat's global option, and it can also come from the `HARDHAT_NETWORK` environment variable. A task that connects to the network runs the network hook, which can call the KMS, for example to fund the accounts of an `edr-simulated` network.

| Command          | `--network`                            | What the task does with it                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kms accounts`   | Optional; required by `--balances`     | Lists that network's keys instead of every key. Connects only for `--balances`, to read the balances.                                                                                                                                            |
| `kms address`    | Not used                               | Asks the KMS only.                                                                                                                                                                                                                               |
| `kms public-key` | Not used                               | Asks the KMS only.                                                                                                                                                                                                                               |
| `kms sign`       | Only for typed data that names a chain | With `--data`, compares the typed data's `domain.chainId` with the network's chain, unless `--chain` or `--allow-cross-chain` is given. Connects only when the config sets no `chainId` for the network. Messages and raw digests do not use it. |
| `kms verify`     | Not used                               | Checks the signature locally.                                                                                                                                                                                                                    |
| `kms sign-tx`    | Required                               | Fills the transaction on the network's node and checks its chain id.                                                                                                                                                                             |
| `kms sign-auth`  | Required unless `--chain` is given     | Signs for the network's chain. Connects to read the key's pending nonce when `--nonce` is not given, or the chain id when the config sets none. `--chain` without `--network` also needs `--nonce`.                                              |
| `kms history`    | Not used                               | Reads the provider's audit log.                                                                                                                                                                                                                  |

## Naming a key

Tasks that take `<key>` accept the name of any key the plugin knows. For keys in the config:

| Where the key is defined                   | Name to pass                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kms.keys`                                 | Its name in `kms.keys`, for example `deployer`.                                                                                                                        |
| An inline key in a network's `kmsAccounts` | `<network>.kmsAccounts[<index>]`, for example `sepolia.kmsAccounts[1]`. A `kmsAccounts` entry that is a name refers to a key in `kms.keys`, so pass that name instead. |

**Keys from `--kms`.** For environment-based workflows and for a migration from Foundry, the global option `--kms aws`, `--kms gcp`, `--kms azure` or a comma-separated list reads keys from environment variables, with no config entry ([Keys from the command line](configuration.md#keys-from-the-command-line)). `--kms` replaces the config entry, not the provider package: the provider package must still be in `plugins`, or the key fails when it is first used, as the `AWS_KMS_KEY_ID` row of the [`kms accounts`](#kms-accounts) example shows. A `--kms` key's name is the variable it was read from. A list entry adds its 0-based index: `AWS_KMS_KEY_IDS[1]`, `AZURE_KEY_VAULT_KEY_IDS[0]`, and `AWS_KMS_KEY_ID[1]` or `AZURE_KEY_VAULT_KEY_ID[1]` when the single variable holds a comma-separated list. A single variable with one key id has no index: `AWS_KMS_KEY_ID`, `AZURE_KEY_VAULT_KEY_ID`. The GCP key is `GCP_KEY_*`. A `--kms` key can be named with or without `--network`.

Quote names that contain `[` or `*`: zsh refuses them unquoted when no file matches.

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

## Provider differences

The tasks work the same way for every provider. What differs is how a key is named in the config, where credentials come from, which variables `--kms` reads, and what `kms history` needs:

| Provider         | Key id in `kms.keys`                                                              | Credentials                                                                          | `--kms` variables                                                                   | `kms history` setup                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS KMS          | `keyId`: a key id, key ARN, alias name or alias ARN                               | The AWS SDK's chain; a key's `profile` selects a profile ([AWS](credentials.md#aws)) | `AWS_KMS_KEY_IDS` (comma-separated) if set, else `AWS_KMS_KEY_ID`                   | Nothing to turn on: CloudTrail event history ([AWS guide](../guides/aws-kms-setup.md#audit-logs))                                                                           |
| Google Cloud KMS | `keyVersionName`, or its components; the version is always required               | Application Default Credentials ([Google Cloud](credentials.md#google-cloud))        | `GCP_PROJECT_ID`, `GCP_LOCATION`, `GCP_KEY_RING`, `GCP_KEY_NAME`, `GCP_KEY_VERSION` | Data Access logs for Cloud KMS, off by default ([Google Cloud guide](../guides/gcp-kms-setup.md#audit-logs))                                                                |
| Azure Key Vault  | `keyId`, the key's URL, or `vaultUrl` with `keyName` and an optional `keyVersion` | The plugin's own chain ([Azure](credentials.md#azure))                               | `AZURE_KEY_VAULT_KEY_IDS` (comma-separated) if set, else `AZURE_KEY_VAULT_KEY_ID`   | A diagnostic setting that sends audit events to a Log Analytics workspace, and `kms.audit.azure.workspaceId` ([Azure guide](../guides/azure-key-vault-setup.md#audit-logs)) |

The [configuration reference](configuration.md#key-forms-per-provider) lists every key form, and the setup guides take a key from creation to its first signature: [AWS KMS](../guides/aws-kms-setup.md), [Google Cloud KMS](../guides/gcp-kms-setup.md), [Azure Key Vault](../guides/azure-key-vault-setup.md).

## Output

A task prints its result alone on standard output, so a script can capture it with `$(npx hardhat kms address deployer)`. Status messages from the provider, such as a wait for a slow KMS, and notes from the task go to standard error with a `[hardhat-kms]` prefix. Errors go to standard error too, and the command exits with a non-zero code.

Each run creates its own KMS clients and closes them before it returns, so the command exits as soon as it has printed.

## `kms accounts`

Lists the KMS keys, asks the KMS for each key's address and checks it against the key's `address` pin. Run it to check that your credentials reach every key, and to get the `address` pins to paste into the config.

```text
npx hardhat [--network <name>] kms accounts [--json] [--show-ids] [--balances] [--check-sign]
```

Each row shows the key's name, its provider, where it is defined, its address, the state of its pin and its key id:

```text
NAME                    PROVIDER  SOURCE       ADDRESS                                     PIN      KEY ID
deployer                aws       kms.keys     0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  matches  aws:alias/deployer
sepolia.kmsAccounts[1]  gcp       kmsAccounts  0x70997970C51812dc3A010C7d01b50e0d17dc79C8  none     gcp:<GCP_KEY_VERSION_NAME>
  also: mainnet.kmsAccounts[0]
AWS_KMS_KEY_ID          aws       --kms        FAILED                                      -        aws:<AWS_KMS_KEY_ID>
  error: aws, create adapter, key aws:<AWS_KMS_KEY_ID>: AWS KMS keys need the @hardhat-kms/aws plugin. Install it with `npm install --save-dev @hardhat-kms/aws` and add it to `plugins` in your Hardhat config

Address pins to add to each key's config:
  networks.sepolia.kmsAccounts[1]: address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  networks.mainnet.kmsAccounts[0]: address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
```

**Options**

| Option             | What it does                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--network <name>` | Lists that network's keys only. Required by `--balances`.                                                                               |
| `--balances`       | Adds each address's balance on the `--network` network ([Check keys before a deploy](#check-keys-before-a-deploy)).                     |
| `--check-sign`     | Has each key sign a random message, to check that the credentials may sign ([Check keys before a deploy](#check-keys-before-a-deploy)). |
| `--json`           | Prints the list as JSON instead of the table ([JSON output of `kms accounts`](#json-output-of-kms-accounts)).                           |
| `--show-ids`       | Shows key ids in full, including values read from configuration variables, after a warning on standard error.                           |

**Output**

- **Which keys.** With `--network`, the task lists that network's `kmsAccounts` in order, then the `--kms` keys, which belong to the selected network. A `--kms` key that names the same KMS key as one of the network's entries gets a note on standard error, because a connection to that network refuses two entries for one key. Without `--network`, the task lists every key a task can name ([Naming a key](#naming-a-key)). A KMS key that several entries name, such as a key in `kms.keys`, an inline copy of it and a `--kms` variable that holds the same id, is listed once, under its first name, with the other names on an `also:` line under it. Entries count as the same key when they have the same provider, the same key id (for an AWS key id or alias, also the same region, profile and endpoint, compared by value, so a variable and a literal that hold the same profile match) and the same pin. A third-party provider's keys are never merged.
- **Pins.** The `PIN` column shows `matches` when the KMS confirmed the pin, `none` when the key has no pin, and `not checked` when the provider can report neither a public key nor an address, so the address shown is the pin. When a key works and has no pin, the task prints an `address` line for each of its entries in `kms.keys` or a network's `kmsAccounts`, including the entries on its `also:` line. A `--kms` key has no config to paste into.
- **Key ids.** An identifier read from a configuration variable or a `--kms` variable shows as `<VARIABLE_NAME>`, as in errors and debug output. `--show-ids` shows the values instead and first prints a warning on standard error. A literal identifier in the config is shown either way. A merged row shows the id of its first entry, so when a variable's key merges with a literal key listed before it, the row shows that literal id, and with it the value the variable holds. A third-party provider's key shows its display id.
- **AWS keys looked up in different places.** When rows read the same key id but their AWS keys differ in region, profile or endpoint, each of those rows shows the settings that differ after the id, for example `aws:alias/deployer (region eu-west-1, profile default, default endpoint)`. An endpoint shows only as `custom endpoint` or `default endpoint`, since it can be an internal URL; `--show-ids` shows the URL.

**Requirements and failures**

- **Access.** Every key is tried, up to 8 at a time, and none is skipped. A key that fails shows `FAILED` and the error on the line under it. A pin that differs from the key's address fails with both addresses, as in [`kms address`](#kms-address). If any key fails, the command exits with code 1 after printing the whole list.
- **Error text.** The failure messages are the plugin's own, or Hardhat's for a configuration variable that is not set. Any other error is reduced to its class name, because its text can carry request details.
- **Checks on a failed key.** `--balances` and `--check-sign` run only for a key whose address was found. A key that fails first shows `-` in their columns. Each check fails only its own row: the other keys are still checked, and if any row fails, the command exits with code 1 after printing the whole list. When both checks fail on one key, its error holds both messages, separated by `; `.

### Check keys before a deploy

Before a deploy, check that each key can sign and that its account holds funds. Here the second key's credentials may read its public key but not sign:

```text
npx hardhat --network sepolia kms accounts --balances --check-sign
NAME                    PROVIDER  SOURCE       ADDRESS                                     PIN      BALANCE (ETH)  SIGN    KEY ID
sepolia.kmsAccounts[0]  aws       kmsAccounts  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  matches  0.25           ok      aws:alias/deployer
sepolia.kmsAccounts[1]  aws       kmsAccounts  0x70997970C51812dc3A010C7d01b50e0d17dc79C8  matches  0              FAILED  aws:alias/ops
  error: the sign check failed: aws, sign, key aws:alias/ops: the provider call failed (AccessDeniedException)
```

- **`--balances`.** Adds a `BALANCE (ETH)` column with each address's balance on the `--network` network, read with `eth_getBalance` at the latest block and written in ether units (the network's native token, 18 decimals). It needs `--network`; without it the task fails before it opens any key, with `--balances reads balances on one network: pass --network <name>`. On an `edr-simulated` network with `kms.simulatedBalance`, opening the connection gives each KMS account that balance first, as for any connection. Funding needs every key, so there one broken key fails every row's balance. A balance that cannot be read fails its row with `could not read the balance:` and the reason, and the table shows `FAILED` in the column.
- **`--check-sign`.** Each key signs the EIP-191 message `hardhat-kms check-sign <64 hex digits>`, made of 32 random bytes drawn for each key, through the same signer as every other signature: the signature must recover to the key's address. Reading a public key and signing need different permissions (for example `kms:GetPublicKey` and `kms:Sign` on AWS), so this proves the credentials may sign, which the plain listing does not. `--check-sign` adds one sign call per key; the public key read for the address also checks the signature. As for every signature, the signer asks once more if the KMS returns a signature that does not verify, and fails the row if the second one does not verify either. The signature is never printed or returned. A `SIGN` column shows `ok`, or `FAILED` with `the sign check failed:` and the reason on the line under the row. A pin that showed `not checked` shows `matches` once its key signs, since the signature recovered to it.

### JSON output of `kms accounts`

`--json` prints `{ "version": 1, "accounts": [...] }` instead of the table. Each entry has `name`, `source` (`kms.keys`, `kmsAccounts` or `--kms`), `otherNames` (a list of `{ name, source }`), `provider`, `keyId`, `address`, `pin`, `pinStatus` (`match`, `none` or `unchecked`) and `error`. An AWS key also has `region` and `profile`, `null` when not set. A value from a configuration variable shows as `<VARIABLE_NAME>` (a region that falls back to `kms.defaults.aws.region` as `<AWS_KMS_REGION> or us-east-1`); with `--show-ids` it shows the value, and `null` when that is empty. With `--show-ids` the entry also has its `endpoint`. With `--balances`, each entry has `balance`, the balance in wei as a decimal string, and with `--check-sign` it has `signCheck`, `"ok"`; both are `null` when the key or the check failed, and absent without their option. A failed key has `address` and `pinStatus` set to `null`, and `error` set to the message. The types are `AccountsReport` and `AccountEntry` in `hardhat-kms/types`.

`hre.tasks.getTask(["kms", "accounts"]).run({ json: false, showIds: false, balances: false, checkSign: false })` returns a Hardhat `Result` holding the same `{ version, accounts }` report: a successful one when every key works, a failed one otherwise.

## `kms address`

Prints a key's address with its EIP-55 checksum.

```text
npx hardhat kms address <key>
```

```text
0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

The task takes no options. It asks the KMS for the key's public key and derives the address from it, even when the key has an `address` pin. If the pin differs from the derived address, the task fails with both addresses:

```text
Error in community plugin hardhat-kms: aws, check address, key aws:alias/deployer: the key derives to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, but the configured address is 0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826, so nothing was signed. The key id may now name the wrong key or a substituted one, or the pin may be wrong. Do not change the pin to match until you know why the key changed; see "When the pin fails" in the key rotation guide, which also covers a deliberate move to a new key.
```

AWS, Google Cloud and Azure keys all return a public key. A third-party provider may return only an address; the task then asks it for the address and checks the pin the same way. A provider that can return neither leaves only the pin: the task prints the pin and writes a note on standard error that it is not checked yet. The first signature checks it.

## `kms public-key`

Prints a key's uncompressed secp256k1 public key, 65 bytes: `0x04` followed by 128 lowercase hex digits.

```text
npx hardhat kms public-key <key>
```

```text
0x048318535b54105d4a7aae60c08fc45f9687181b4fdfc625bd1a753fa7397fed753547f11ca8696646f2f3acb08e31016afac23e630c5d11f59f61fef57b0d2aa5
```

The task takes no options, and checks the `address` pin as `kms address` does. A provider that returns only an address has no public key to print, so the task fails with `the provider returns only the key's address, not its public key`.

## `kms sign`

Signs an EIP-191 message, EIP-712 typed data or a raw 32-byte digest with a key, and prints the signature.

```text
npx hardhat kms sign <key> <message>
npx hardhat kms sign --data [--from-file] [--chain <id>] [--allow-cross-chain] <key> <typed-data>
npx hardhat kms sign --no-hash <key> <digest>
```

```bash
npx hardhat kms sign deployer "hello world"
npx hardhat kms sign deployer 0x68656c6c6f
npx hardhat kms sign --data --from-file --network sepolia deployer permit.json
```

**Inputs and options**

| Input                 | What is signed                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `<message>`           | An EIP-191 message. A value that starts with `0x` is hex bytes; anything else is UTF-8 text, as in `cast`. |
| `--data <typed-data>` | EIP-712 typed data, as a JSON string, the format `eth_signTypedData_v4` takes.                             |
| `--data --from-file`  | EIP-712 typed data read from the JSON file `<typed-data>` names.                                           |

`--chain <id>` and `--allow-cross-chain` set the chain that typed data must be for ([Typed data and chains](#typed-data-and-chains)). `--no-hash` signs a raw digest; [Raw digests](#raw-digests) describes it next to its warning.

**Output**

The task prints the 65-byte signature `r || s || v` as `0x`-prefixed hex, with `v` 27 or 28, the form `personal_sign` and `cast wallet sign` return. For `kms sign deployer "hello world"` with the key of the examples above:

```text
0xa461f509887bd19e312c0c58467ce8ff8e300d3c1a90b608a760c5b80318eaf15fe57c96f9175d6cd4daad4663763baa7e78836e067d0163e9a2ccf2ff753f5b1b
```

**Requirements and failures**

- Before it prints a signature, the task recovers the signer from it and checks that it is the key's address. This catches a wrong or substituted signature from the signer. It is not a second check of the digest, which the task computes with the same code as the signer.
- `--from-file` requires `--data`. `--chain` and `--allow-cross-chain` apply only to `--data`. `--no-hash` cannot be combined with `--data`.
- Typed data that names a chain needs `--network`, `--chain` or `--allow-cross-chain` ([Typed data and chains](#typed-data-and-chains)).
- JSON numbers above 2^53 - 1 are refused, since `JSON.parse` would round them; write such values as strings.

### Typed data and chains

Typed data goes through the same chain check as `eth_signTypedData_v4` ([Security model](../explanation/security-model.md#typed-data-checks-its-chain)). When `domain.chainId` is set, it must equal the chain given by one of these, which cannot be combined:

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

### Raw digests

| Input                | What is signed                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `--no-hash <digest>` | A raw 32-byte digest, `0x` and 64 hex digits, signed as it is. It cannot be combined with `--data`. |

`--no-hash` signs any 32 bytes, and a digest can be the hash of a transaction or a permit. No RPC method signs a bare digest. `--no-hash` is reachable only through the task, from the CLI or from code that runs the task. Sign only a digest you computed yourself. The task prints a warning to standard error each time and refuses any value that is not exactly 32 bytes:

```text
[hardhat-kms] --no-hash signs the 32 bytes as they are, with no EIP-191 prefix. Sign only a digest you computed yourself: it can authorize a transaction or a permit.
```

## `kms verify`

Recovers the address that signed a message or typed data and compares it with the expected signer. The check runs locally.

```text
npx hardhat kms verify --address <address> <message> <signature>
npx hardhat kms verify --key <key> <message> <signature>
npx hardhat kms verify --data [--from-file] (--address <address> | --key <key>) <typed-data> <signature>
```

A message that starts with `-` goes after `--`, so that Hardhat does not read it as an option:

```bash
npx hardhat kms verify --address 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 "hello world" 0xa461…5b1b
npx hardhat kms verify --data --from-file --key deployer permit.json 0x…
npx hardhat kms verify --address 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 -- "-1 ETH" 0x…
```

**Options**

Name the expected signer with exactly one of these options:

- `--address` takes the address to expect, and no KMS is contacted. An all-lowercase or all-uppercase address is accepted; a mixed-case one must have a correct EIP-55 checksum.
- `--key` takes a key name, as in [Naming a key](#naming-a-key), and gets the key's address as [`kms address`](#kms-address) does: from the public key, or from the address an address-only provider reports, checked against an `address` pin. The KMS never signs. If the provider can report neither, the signature is checked against the `address` pin, with a note on standard error that the pin itself is not confirmed.

The message and typed data are read as in [`kms sign`](#kms-sign):

| Input                 | What is verified                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `<message>`           | An EIP-191 message. A value that starts with `0x` is hex bytes; anything else is UTF-8 text, as in `cast`. |
| `--data <typed-data>` | EIP-712 typed data, as a JSON string, the format `eth_signTypedData_v4` takes.                             |
| `--data --from-file`  | EIP-712 typed data read from the JSON file `<typed-data>` names.                                           |

**Output**

On a match the task prints one line to standard output and exits with code 0:

```text
Valid: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 signed this message.
```

On a mismatch it prints both addresses to standard error and exits with code 1:

```text
Invalid: the signature over this message recovers to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, not to the expected signer 0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826.
```

From a script, `hre.tasks.getTask(["kms", "verify"]).run({ message, signature, address })` returns Hardhat's result object, `{ success: true, value: { address } }` or `{ success: false, error: { recovered, expected } }`, and throws only on invalid input.

**Requirements and failures**

- Invalid input also exits with code 1, with an `Error in community plugin hardhat-kms: kms verify:` message. As in cast, the exit code does not tell a mismatch from invalid input.
- `--from-file` requires `--data`. JSON numbers above 2^53 - 1 are refused, since `JSON.parse` would round them; write such values as strings.
- Verifying typed data checks no chain: the domain's `chainId` is part of the signed digest, so a signature for another chain does not match.

### Signature forms

The signature is 65 bytes, `r || s || v`, as `kms sign`, `personal_sign` and `eth_signTypedData_v4` return it. The task reads it as cast does, through alloy:

- `v` may be 27 or 28, the bare recovery bit 0 or 1, or an EIP-155 value of 35 or more, whose recovery bit is `(v - 35) % 2`. Any other `v` is refused.
- A high-S signature, the malleable twin of the low-S one, is accepted: it recovers the same address. On a match the task adds a note to standard error, since OpenZeppelin's `ECDSA.recover` rejects the high-S form, and gives the low-S form to use instead.
- A value that is not `0x`-prefixed hex, is not 65 bytes, or has `r` or `s` outside 1 to n - 1 is refused with an error that says which.

### Compared with `cast wallet verify`

- The message, `--data` and `--from-file`, the `v` values and the high-S handling are the same.
- There is no `--no-hash`, on purpose. Only `kms sign` handles raw 32-byte digests, and only with the explicit `--no-hash` option.
- `--key` checks against a KMS key without copying its address.
- Only EOA signatures are checked. A smart-contract wallet's EIP-1271 `isValidSignature` is not called.

## `kms sign-tx`

Fills a transaction on the network's node, signs it with the key, and prints the raw signed transaction on standard output, as `cast mktx` does. The task never sends the transaction.

```text
npx hardhat --network <network> kms sign-tx <key> <tx.json>
```

`tx.json` holds one JSON object with the field names of `eth_sendTransaction`: `from`, `to`, `gas`, `gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`, `value`, `data`, `nonce`, `chainId`, `accessList` and `authorizationList`, plus an optional `type`. Quantities are hex strings, as in JSON-RPC, and an address in mixed case must carry a valid EIP-55 checksum.

```json
{ "to": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "value": "0x1" }
```

The task takes no options of its own. `--network` is required, because the fill reads the node and the chain id is checked against it. Like any Hardhat global option, `--network` can also follow the task's arguments.

**Output**

Standard output:

```text
0x02f86c827a6980843b9aca00844201eab38252099470997970c51812dc3a010c7d01b50e0d17dc79c80180c001a0b85916a088d886f91c1d2f0139bd231af8842ffa0e8232f46e70d543bb223af8a00ca045d1a2ebbe1dd49bc220f8714e0d6e9581e0ffc5edeee87b3b2ba2eaf031
```

Standard error, with the transaction hash:

```text
[hardhat-kms] hash 0x0da9e0b9ede9b780554f62432d41e2d4df3540fb1fe37264b5ceff45f4d0d4e6
```

To send the transaction later, pass it to `eth_sendRawTransaction`, for example `cast publish $(npx hardhat --network sepolia kms sign-tx deployer tx.json)`. A file without `to` creates a contract, and the task says so on standard error.

**Requirements and failures**

The task fails, and the KMS signs nothing, when:

- `--network` is not given.
- `from` is set and is not the key's address. Leave `from` out to sign from the key.
- `chainId` is set and is not the network's chain id.
- The file asks for a blob transaction (EIP-4844): `type` `0x3`, `blobs`, `blobVersionedHashes` or `maxFeePerBlobGas`. KMS accounts do not sign them.
- The file has a field that `eth_sendTransaction` does not, such as `gasLimit` or `input`. Hardhat would ignore it and sign without it, so the task names the field instead:

  ```text
  Error in community plugin hardhat-kms: kms sign-tx: unknown transaction field gasLimit (use gas instead of gasLimit). The fields are those of eth_sendTransaction: from, to, gas, gasPrice, maxFeePerGas, maxPriorityFeePerGas, value, data, nonce, chainId, accessList, authorizationList, type.
  ```

- An address in mixed case has a wrong EIP-55 checksum, which usually means a typo: `to`, `from`, or an address in `accessList` or `authorizationList`. All-lowercase and all-uppercase addresses carry no checksum and are accepted.
- A quantity (`value`, `gas`, `gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`, `nonce`, `chainId`) is not a `0x` hex string, such as a JSON number. The task says so before it reads the node.
- The file cannot be read, is not valid JSON, or does not hold one JSON object.
- The file's `type` differs from the type its fields give ([Transaction type](#transaction-type)).

### How the task fills the transaction

The task fills what the file leaves out as [`eth_signTransaction`](rpc-methods.md) does for a KMS account: fees, gas, the chain id and the nonce. For the same request, key and chain state, the bytes are the same as those `eth_signTransaction` returns. The nonce is the node's pending count, and nothing reserves it: if the key sends another transaction first, the signed one is stale.

### Transaction type

The fields decide the transaction type: `authorizationList` gives EIP-7702 (`0x4`), `maxFeePerGas` EIP-1559 (`0x2`), `accessList` EIP-2930 (`0x1`), and `gasPrice` alone a legacy transaction (`0x0`). Without a fee field, the network's `gasPrice` setting decides. With `"auto"`, a node that has a base fee and answers `eth_feeHistory` gets EIP-1559; otherwise the task falls back to a legacy transaction with the node's `eth_gasPrice`. A fixed `gasPrice` gives a legacy transaction. A `type` in the file states what you expect: when the fields give another type, the task fails before the KMS signs.

## `kms sign-auth`

Signs an EIP-7702 authorization that delegates the key's account to the code at `<delegate>`, and prints the signed tuple as one line of JSON. It is the entry an `eth_sendTransaction` request takes in its `authorizationList`. The task sends nothing.

```text
npx hardhat kms sign-auth --chain <id> --nonce <n> [--force] <key> <delegate>
npx hardhat kms sign-auth --network <name> [--nonce <n> | --self-broadcast] [--force] <key> <delegate>
```

For `kms sign-auth --chain 1 --nonce 0 deployer 0x5FbDB2315678afecb367f032d93F642f64180aa3` with the key of the examples above:

```text
{"chainId":"0x1","address":"0x5FbDB2315678afecb367f032d93F642f64180aa3","nonce":"0x0","yParity":"0x1","r":"0x3d3184060a9a58823c738a84e7df168975ac5d5dfc8fc6af423d0ac72392ab5e","s":"0x2e3ba5f338b5ad32bff79c15b8fe264f465026e2d2a3f1d2c2a04e0a0244881b"}
```

**Options**

| Option             | What it does                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--chain <id>`     | The chain to sign for, decimal or `0x` hex. Required unless `--network` is given, and not combined with it.                                                                    |
| `--network <name>` | Signs for the network's `chainId` from the config, else the chain the node reports. When the config sets `chainId` and the task connects, the node must report the same chain. |
| `--nonce <n>`      | The authority's nonce, decimal or `0x` hex, below 2^64 - 1. Without it, the task reads the key's pending nonce from the `--network` node, so `--chain` alone needs `--nonce`.  |
| `--self-broadcast` | Signs for the pending nonce + 1, for when this key sends the transaction that carries the authorization, which takes the pending nonce. The task sends nothing.                |
| `--force`          | Allows chain 0.                                                                                                                                                                |

**Output**

Each number is a `0x` hex quantity, `r` and `s` are 32 bytes each, and `address` is the delegate with its EIP-55 checksum. Hardhat's `authorizationList` schema refuses decimal strings, so the tuple can go into a request as printed. The signed message is `keccak256(0x05 || rlp([chainId, address, nonce]))`. The task also writes [notes on standard error](#notes-on-standard-error).

**Requirements and failures**

- Before it prints the tuple, the task reads it back, recovers the authority from it, and checks that it is the key's address and that `s` is low. Nodes skip an authorization with a high `s`.
- `--nonce` and `--self-broadcast` cannot be combined, as in cast.
- The task opens a connection to `--network` only to read what the command line and the config do not give: the pending nonce, or a chain id the config does not set. Opening it runs the network hook, which can call the KMS, for example to fund the accounts of an `edr-simulated` network. `--network` can also come from the `HARDHAT_NETWORK` environment variable, so `--chain` fails while it is set.

### Notes on standard error

Before it calls the KMS, the task writes one line that says what it signs:

```text
[hardhat-kms] authority 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, chain 1 (from --chain), nonce 0, delegate 0x5FbDB2315678afecb367f032d93F642f64180aa3
```

The chain is followed by `(from --chain)` or `(from --network <name>)`. Other notes:

- With `--self-broadcast`, the nonce to send the transaction with: `the authorization uses nonce 1: send it in a transaction from this key with nonce 0`.
- With `--network`, when the task has connected to the node and the delegate has no code there: `the delegate 0x… has no code on network sepolia: check that it is the address for this chain`. A delegate copied from another chain is the usual cause. The task still signs, since the code may be deployed later.
- For chain 0, which the task refuses unless `--force` is given: `this authorization is for chain 0: it is replayable on every chain where this account's nonce is 5`.
- For the delegate `0x0000000000000000000000000000000000000000`, which clears the account's delegation: `the delegate is the zero address: this authorization clears the delegation`.

### Keep the tuple private until it is used

Treat a printed tuple as a credential until a transaction uses it or the account's nonce moves past it. Anyone who holds it can submit it, from any account, and delegate the key's account to the code it names. To cancel a tuple you no longer want, send any transaction from the key: that uses the nonce, and the tuple can no longer apply. A chain-0 tuple applies on every chain where the account has that nonce, so it stays usable on each chain until the nonce moves past it there.

### Send the authorization

Put the tuple as printed in the `authorizationList` of a raw `eth_sendTransaction`, sent with `provider.request`. Here the key sends it itself, so it was signed with `--self-broadcast`, and the transaction passes the nonce from the task's note:

```ts
import { readFile } from "node:fs/promises";

import { network } from "hardhat";

// auth.json holds the output of
// npx hardhat kms sign-auth --network sepolia --self-broadcast deployer 0x5FbDB2315678afecb367f032d93F642f64180aa3
// which wrote on standard error: the authorization uses nonce 8: send it in a transaction from this key with nonce 7
const authorization: unknown = JSON.parse(await readFile("auth.json", "utf8"));
// The key's address, from `npx hardhat kms address deployer`.
const from = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const { provider } = await network.create("sepolia");
await provider.request({
  method: "eth_sendTransaction",
  params: [{ from, to: from, nonce: "0x7", authorizationList: [authorization] }],
});
```

Once the transaction is mined, the account's code is `0xef0100` followed by the delegate's address. If the authority's nonce does not match the tuple's when the transaction runs, the transaction is still mined, but nodes skip the authorization and the code does not change.

Libraries take other shapes, and a tuple passed to them as printed fails or loses its signature:

| Library                                       | Shape                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider.request` with `eth_sendTransaction` | The tuple as printed. This is the recommended way.                                                                                                                                                                                                                                                                                                                             |
| viem (`SignedAuthorization`)                  | `chainId`, `nonce` and `yParity` as numbers, for example `Number(tuple.chainId)`; `address`, `r` and `s` as printed. viem drops leading zero bytes from `r` and `s`; when a KMS account sends the transaction, the plugin pads them back to 32 bytes before it signs. From an account in the network's `accounts`, Hardhat refuses a short `r` or `s`; use `provider.request`. |
| ethers (`AuthorizationLike`)                  | `{ address, nonce, chainId, signature: { r, s, yParity } }`. ethers reads the signature only from `signature`, so a flat tuple goes out with a zero signature and no error.                                                                                                                                                                                                    |

## `kms history`

Lists the key's sign events from its provider's audit log, newest first. It answers "who else signed with this key?".

```text
npx hardhat kms history <key> [--since <time>] [--until <time>] [--limit <n>] [--json] [--show-ids]
```

```text
Sign events of deployer (aws:alias/deployer), from cloudtrail-event-history
2026-10-01T10:00:00.000Z to 2026-10-02T10:00:00.000Z, newest first
Scope: account <hidden>, us-east-1
Not logged by this provider: key version, digest

TIME                      OPERATION  OUTCOME                         PRINCIPAL                                SOURCE IP
2026-10-02T09:14:03.512Z  Sign       success                         arn:aws:iam::111122223333:role/deployer  203.0.113.7
  user agent (client-reported): aws-sdk-js/3.1000.0 ... hardhat-kms/1.0.0
  request id: 11111111-2222-3333-4444-555555555555
2026-10-02T08:02:11.004Z  Sign       failed (AccessDeniedException)  arn:aws:iam::111122223333:user/ci        198.51.100.4
  user agent (client-reported): aws-cli/2.17.0 ...
  request id: 66666666-7777-8888-9999-000000000000
```

The events come only from the log: the plugin stores nothing about the signatures it makes and adds nothing the log does not hold. Anyone with read access to the log gets the same list from any machine. The list includes sign requests made outside the plugin, for example from the provider's CLI or console. The history covers the whole key: every version, even when the config pins one, with the version that signed in its own column where the provider logs it. [Audit logs](../explanation/security-model.md#audit-logs) lists what each provider records.

**Options**

- **`<key>`.** Named as in [Naming a key](#naming-a-key), including `--kms` variables.
- **`--since` and `--until`.** An ISO 8601 time with a time zone, such as `2026-10-02T09:00:00Z` or `2026-10-02T11:00:00+02:00`; a date, which means midnight UTC; or a duration before now: `45s`, `30m`, `6h`, `7d`. A time without a time zone, or an `--until` more than 5 minutes after now, is refused. `--until` defaults to now, and `--since` to 24 hours before `--until`. The task reads whole seconds: it rounds `--since` down and `--until` up, and prints the range it read.
- **`--limit`.** At most this many events, the newest ones. From 1 to 1000; default 100. When the log holds more events in the range, or the reader stopped before reading the whole range, the task says so on standard error. Narrow the range to see older ones. If the reader stopped before it found any event, the table says "No sign events found before the reader stopped" instead of "No sign events in <source>".
- **`--json`.** Prints the report as JSON instead of the table ([JSON output of `kms history`](#json-output-of-kms-history)).
- **`--show-ids`.** Shows key ids, provider id fields and error messages in full, after a warning on standard error ([Ids and sensitive output](#ids-and-sensitive-output)).

**Output**

Each row is one log entry, copied as it was logged. One signature can show as several entries, because the plugin and the provider SDKs retry ([How many sign requests one call can send](../explanation/security-model.md#how-many-sign-requests-one-call-can-send)).

- **Not logged and empty.** A field the provider never records has no column or line, and the header names it. A field the provider records but left empty in this entry shows as `-`.
- **User agent.** The client chooses it, so any tool can claim to be the plugin. Treat it as a hint, never as proof.
- **Scope.** The header says which part of the log the read covered, when the reader says, such as one AWS account and Region. Ids in it show as `<hidden>`.

The task adds these notes to standard error, and to `notes` in the JSON, each with a stable code:

| Code                           | When                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `logging-not-confirmed`        | The log returned no events, and the reader cannot confirm that it sees every sign request on the key. Zero rows does not show that the key signed nothing: logging may be off or routed elsewhere, or the read may not see every request, such as AWS calls recorded in another account or Region. The task never reports "no signatures". |
| `recent-events-may-be-missing` | The range ends within 15 minutes of now, or within the provider's documented delay if that is longer. Events take minutes to reach the log.                                                                                                                                                                                                |
| `before-retention`             | The range starts before the oldest event the log keeps, for providers whose retention does not depend on your settings.                                                                                                                                                                                                                    |

A reader can add notes of its own, with other codes.

**Requirements and failures**

- **Provider setup.** The log must hold the events; [Provider differences](#provider-differences) says what each provider needs. The task makes no sign call. On AWS it reads the key's public key to find the key ARN of an alias or a bare key id, which CloudTrail logs as a `GetPublicKey` event; [Audit logs](../guides/aws-kms-setup.md#audit-logs) in the AWS guide covers the permission and how the read works. On Azure it reads the workspace set in `kms.audit.azure.workspaceId`, which a diagnostic setting on the vault must send audit events to; see [Audit logs](../guides/azure-key-vault-setup.md#audit-logs) in the Azure guide. It does not need `--network`.
- **Readers.** Each provider package reads its own provider's log. A provider without a reader fails with an error that names it. A third-party provider adds one through the `kms` hook (optional, for provider authors: [History readers](../../contributor/providers.md#history-readers) in the contributor docs).
- **Time limit.** The task waits 120 seconds for the reader, then fails with `core.history.timed-out`. Narrow the range if a long range hits it.
- **A log it cannot read.** The task fails with exit code 1 and prints nothing on standard output. A refused read names the permission to grant. The task never shows an empty history for a log it could not read. The text of a reader's error is masked like the output, and anything in it shaped like an ARN, an Azure vault URL, a Google Cloud resource name, a GUID or an AWS account id shows as `<hidden>`. The errors it wraps are not shown, even with `--show-stack-traces`.

### Ids and sensitive output

- **Ids.** Key ARNs, resource names and key URLs from the log show as the key's display id, wherever they appear and in any case, with the parts that name the key on their own, such as an AWS key id. Other values that must not print show as `<hidden>`: an Azure vault host and name, a Google Cloud key ring, the Azure workspace id, the value of each configuration variable part of a key, provider id fields such as the AWS access key id, and scope ids. Their URL-encoded and `\/`-escaped forms are masked too. A failed request shows only its error code, since provider error messages can name accounts and keys. `--show-ids` shows key ids, provider id fields and error messages in full, after a warning on standard error.
- **Principals.** Principals are shown either way, so an AWS principal ARN shows its account id by design. Scope ids are not masked in principals. A key value, or a hidden configuration variable value such as a Google Cloud project id, is masked there too, so a service account email can show as `signer@<hidden>.iam.gserviceaccount.com`. This is accepted: the variable exists to keep the project out of the output.
- **Sensitive output.** Principals, IP addresses and user agents are shown by default, because an incident review needs them. Treat the output as sensitive, and do not paste it into public issues.

### JSON output of `kms history`

`--json` prints the report instead of the table:

```json
{
  "version": 1,
  "key": { "name": "deployer", "provider": "aws", "displayId": "aws:alias/deployer" },
  "source": "cloudtrail-event-history",
  "range": { "since": "2026-10-01T10:00:00.000Z", "until": "2026-10-02T10:00:00.000Z" },
  "scope": "account <hidden>, us-east-1",
  "notLogged": ["keyVersion", "digest"],
  "events": [
    {
      "time": "2026-10-02T09:14:03.512Z",
      "operation": "Sign",
      "outcome": "success",
      "error": null,
      "principal": "arn:aws:iam::111122223333:role/deployer",
      "sourceIp": "203.0.113.7",
      "userAgent": "aws-sdk-js/3.1000.0 ... hardhat-kms/1.0.0",
      "requestId": "11111111-2222-3333-4444-555555555555",
      "keyVersion": null,
      "digest": null,
      "keyResource": "aws:alias/deployer",
      "extra": {}
    }
  ],
  "truncated": false,
  "truncatedReason": null,
  "notes": []
}
```

Times are UTC, to the millisecond. `scope` is `null` when the reader does not say what it covered. `truncatedReason` is `limit` when the log holds more events than `--limit`, `scan-limit` when the reader stopped before reading the whole range, and `null` otherwise. `error` is `null` for a request that succeeded, and `{ "code": ..., "message": null }` for one that failed; `--show-ids` fills in `message`. `keyResource` is the key as the log names it, shown as the display id without `--show-ids`. `extra` holds the provider's other fields. A field in `notLogged` is `null` in every event. The types are `KmsHistoryReport` and `KmsHistoryEntry` in `hardhat-kms/types`, and `hre.tasks.getTask(["kms", "history"]).run({ key, limit: 100, json: false, showIds: false })` returns the same report.
