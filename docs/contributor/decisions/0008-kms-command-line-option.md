# 0008: Choose KMS keys from the command line with `--kms`

Status: Accepted (2026-09-30)

Issue: [#84](https://github.com/aelmanaa/hardhat-kms/issues/84)

## Context

Foundry users pick a KMS signer per command, with a flag and environment variables, and never write a config file for it. hardhat-kms reads keys only from `kms.keys` and `networks.<name>.kmsAccounts` in `hardhat.config.ts`. One-off runs and CI jobs then need a config edit, and a Foundry user has to learn a config format before signing anything.

### What Foundry does

Sources: `foundry-rs/foundry-core@6228965` (`crates/wallets/src`), `foundry-rs/foundry@336712c` (`crates`), and the Azure signer PRs [foundry-core#228](https://github.com/foundry-rs/foundry-core/pull/228) and [foundry#17120](https://github.com/foundry-rs/foundry/pull/17120), both open on 2026-09-30.

| Flag        | Single-key commands read                                                                                | Multi-key commands read                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `--aws`     | `AWS_KMS_KEY_ID` (`opts.rs:199-201`)                                                                    | `AWS_KMS_KEY_IDS`, else `AWS_KMS_KEY_ID`, comma-split (`wallet_multi/mod.rs:431-449`)              |
| `--gcp`     | `GCP_PROJECT_ID`, `GCP_LOCATION`, `GCP_KEY_RING`, `GCP_KEY_NAME`, `GCP_KEY_VERSION` (`opts.rs:202-210`) | the same five variables, one key only (`wallet_multi/mod.rs:462-487`)                              |
| `--turnkey` | `TURNKEY_API_PRIVATE_KEY`, `TURNKEY_ORGANIZATION_ID`, `TURNKEY_ADDRESS` (`opts.rs:211-218`)             | the same, one key (`wallet_multi/mod.rs:489-501`)                                                  |
| `--azure`   | `AZURE_KEY_VAULT_KEY_ID` (PR branch `opts.rs:230-232`)                                                  | `AZURE_KEY_VAULT_KEY_IDS`, else `AZURE_KEY_VAULT_KEY_ID` (PR branch `wallet_multi/mod.rs:517-525`) |

- The flags are booleans. The key identifiers come only from the environment, and a missing variable fails with `<NAME> environment variable is required for signer` (`opts.rs:190-193`).
- Single-key commands (`cast send`, `cast mktx`, `forge create`, `cast wallet address`, `sign`, `sign-auth`, `public-key`) flatten `WalletOpts` (`cli/src/opts/rpc.rs:182-190`, `cast/src/tx.rs:56`, `cast/src/cmd/wallet/mod.rs:121-345`). `forge script` flattens `MultiWalletOpts` (`script/src/lib.rs:297`), which concatenates every signer source into one wallet list (`wallet_multi/mod.rs:255-295`).
- `forge script` uses `--sender` to pick among the loaded wallets. Without it, a single loaded signer becomes the sender (`script/src/lib.rs:364-373`). A transaction from an address with no loaded wallet fails with `No associated wallet for addresses` (`script/src/broadcast.rs:427`).
- On single-key commands, `--from` (or `ETH_FROM`) must equal the signer's address, or the command fails (`cast/src/tx.rs:231-261`).
- On `master`, `AWS_KMS_KEY_IDS` is split on commas without trimming (`wallet_multi/mod.rs:435-438`). The Azure PR adds `key_ids_from_env`, which trims and drops blank entries, and uses it for AWS too (PR branch `wallet_multi/mod.rs:553-556`).
- Foundry reads the environment only when a flag is set. `cast wallet list --all` is the exception: it lists every configured source (`cast/src/cmd/wallet/list.rs:58-81`).

### What Hardhat 3 offers

Sources: `hardhat@3.18.0`, the version this plugin develops against.

- A plugin declares `globalOptions` with `globalOption`, `globalFlag` or `globalLevel` (`src/internal/core/config.ts:106-145`). Option types are `STRING`, `BOOLEAN`, `FLAG`, `INT`, `LEVEL`, `BIGINT`, `FLOAT`, `FILE` and their `_WITHOUT_DEFAULT` forms, with no list type (`src/types/arguments.ts:6-17`). An option cannot be repeated on one command line (`src/internal/cli/parser.ts:338-356`).
- Every global option has an environment form, `HARDHAT_<NAME_IN_SNAKE_CASE>` (`@nomicfoundation/hardhat-utils@4.3.0 src/env.ts:31-33`). The command line wins over the environment, which wins over the default (`src/internal/core/global-options.ts:150-188`). Scripts run with plain `node` get global options from the environment only.
- Two plugins that define the same global option name fail at load with `GLOBAL_OPTION_ALREADY_DEFINED` (`global-options.ts:43-70`). A task option whose name equals any global option fails with `TASK_OPTION_ALREADY_DEFINED` (`src/internal/core/tasks/task-manager.ts:211-251`). Hardhat's own global options are `config`, `help`, `init`, `showStackTraces`, `verbosity`, `version`, `network`, `buildProfile`, `coverage`, `gasStats` and `gasStatsJson`.
- Hardhat resolves the config (`src/internal/core/hre.ts:89`) before the global options (`hre.ts:128`), so config hooks cannot see a global option. Network hooks receive a `HookContext`, which is the runtime minus `tasks` (`src/types/hooks.ts:35`), so `context.globalOptions` is available there. Built-in precedents: the network manager reads `hre.globalOptions.network` (`network-manager/hook-handlers/hre.ts:70`), and gas analytics reads `context.globalOptions.gasStats` in its `hre` hook (`gas-analytics/hook-handlers/hre.ts:12`).
- `hre.network.create({ override })` merges the override into the user config and runs full validation and resolution again (`network-manager/network-manager.ts:480-503`). Arrays are replaced, not merged (`@nomicfoundation/hardhat-utils src/internal/lang.ts:35-40`, `src/lang.ts:70-74`). The override type derives from the network user config (`network-manager/type-extensions/config.ts:55-66`), which hardhat-kms extends with `kmsAccounts`. A script can therefore set `override: { kmsAccounts: [...] }` today, with no new API.

### What other tools do

| Tool                                | How a run picks its signer                                                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundry keystores                   | `--account <name>` or `ETH_KEYSTORE_ACCOUNT` (`foundry-core crates/wallets/src/opts.rs:50-58`)                                                                                                                  |
| Ape                                 | A script opts in with the `account_option()` decorator, which takes an alias or index and prompts when absent ([ape.cli docs](https://docs.apeworx.io/ape/stable/methoddocs/cli.html))                          |
| Brownie                             | `--network` on the command line; the script calls `accounts.load(id)` ([Brownie account management](https://eth-brownie.readthedocs.io/en/stable/account-management.html))                                      |
| `@nomicfoundation/hardhat-ledger`   | Config only: `networks.<name>.ledgerAccounts` (`hardhat3-src packages/hardhat-ledger/src/type-extensions.ts:5`). Its addresses follow the network's own in `eth_accounts` (`hook-handlers/network.ts:114-117`). |
| `@nomicfoundation/hardhat-keystore` | Config variables resolved from an encrypted store; its flags (`--dev`) choose the store, not a signer (`packages/hardhat-keystore/src/index.ts:30-110`)                                                         |
| Hardhat Ignition                    | Uses `eth_accounts`; `--default-sender` picks one, otherwise the first account (`packages/hardhat-ignition/src/index.ts:42-47`, `src/internal/tasks/deploy.ts:187,228-231`)                                     |
| viem and ethers scripts             | The script reads its own environment variable, usually a private key                                                                                                                                            |

Two patterns cover every tool: a named selection on the command line with an environment fallback (Foundry, Ape), or selection in config and code (Brownie, the Hardhat plugins, plain scripts). None of them loads a signer because an environment variable happens to be set.

## Decision

Add one string global option, `--kms <providers>`, with the environment form `HARDHAT_KMS`. Its value is a comma-separated list of built-in provider ids: `aws`, `gcp`, `azure`. Each id loads the keys named by Foundry's environment variables for that provider and adds them to the selected network's KMS accounts, after the keys from the config.

### Option and variables

The option is `globalOption({ name: "kms", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })`, the same shape as `--network`. hardhat-kms augments `GlobalOptions` with `kms?: string`.

| `--kms` id | Variables read                                                                      | Keys built                                                                   |
| ---------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `aws`      | `AWS_KMS_KEY_IDS` if set, else `AWS_KMS_KEY_ID`                                     | One `{ provider: "aws", keyId }` per entry                                   |
| `gcp`      | `GCP_PROJECT_ID`, `GCP_LOCATION`, `GCP_KEY_RING`, `GCP_KEY_NAME`, `GCP_KEY_VERSION` | One `{ provider: "gcp", projectId, location, keyRing, keyName, keyVersion }` |
| `azure`    | `AZURE_KEY_VAULT_KEY_IDS` if set, else `AZURE_KEY_VAULT_KEY_ID`                     | One `{ provider: "azure", keyId }` per entry                                 |

- The names and the `_IDS`-before-`_ID` precedence are Foundry's. The Azure names follow foundry-core#228; if that PR renames them before it merges, this table follows.
- List variables are split on commas, each entry is trimmed, and blank entries are dropped, as in the Azure PR. A list that ends up empty is an error.
- GCP loads one key, as in Foundry. More GCP keys go in the config.
- The plugin reads these variables from `process.env` directly. It does not go through configuration variables, so `hardhat-keystore` never supplies them. A Foundry user's `.env` works unchanged.
- Only the variables listed for the ids in `--kms` are read. Setting `AWS_KMS_KEY_ID` without `--kms aws` loads nothing. There is no `all` value and no auto-detection.
- Turnkey and other third-party providers are out of scope. An id that is not built in is an error, with the existing did-you-mean check for misspelled built-in ids (`src/internal/config/schema.ts:43-58`). A later decision can let a `kms` hook handler declare its own variables.

### Checks and names

- Each key goes through the same zod schema and the same provider `resolve()` as a config key, and inherits `kms.defaults` (AWS region, `timeoutMs`). Identifier checks (`src/internal/config/identifiers.ts`) run on the variable's value.
- A command-line key is named after its variable: `AWS_KMS_KEY_ID`, `AWS_KMS_KEY_IDS[1]` (0-based, like `kmsAccounts[<index>]`), `GCP_KEY_*`, `AZURE_KEY_VAULT_KEY_ID`. Its `displayId` shows the variable, never the value: `aws:<AWS_KMS_KEY_IDS[1]>`.
- Errors name the option and the variable, never the value:

  ```text
  --kms gcp: GCP_KEY_RING is not set
  invalid value for --kms azure (<AZURE_KEY_VAULT_KEY_ID>): expected an https URL on an Azure Key Vault or Managed HSM host (for example `*.vault.azure.net`) with the path /keys/<name> or /keys/<name>/<version>
  ```

- The plugin parses `--kms` and checks every variable in an `hre` `created` hook handler, before any task runs. This step does no I/O and loads no SDK (0005). A task that opens no connection, such as `compile`, makes no KMS call.

### Networks and config keys

- The network hook reads `context.globalOptions.kms` and `context.globalOptions.network`. It adds the command-line keys to connections to the selected network only: the `--network` value, or `default` when none is given. A script that connects to a second network by name gets that network's config keys only. This keeps Foundry's rule that one flag signs against one RPC target.
- The selected network must be `http` or `edr-simulated`, the same rule as `kmsAccounts`. The planned warning for KMS keys on the `default` network covers command-line keys too.
- Command-line keys come after the network's config `kmsAccounts`, in variable order, as Foundry's multi-wallet appends each source (`wallet_multi/mod.rs:255-295`). `eth_accounts` keeps its documented order: the network's own accounts, then the KMS addresses (`docs/user/reference/rpc-methods.md:11`).
- A command-line key whose provider and identifier value equal a config key on the same network is an error that names both, for example `AWS_KMS_KEY_ID is already networks.sepolia.kmsAccounts[0] ("deployer")`. Two keys that derive to the same address are an error when addresses are first resolved.
- Command-line keys are not written into `hre.config`, because the config is resolved before global options exist. The `kms accounts` task (M7) lists them with their source.

### Issue #13

Close [#13](https://github.com/aelmanaa/hardhat-kms/issues/13) as superseded. The Foundry variable mapping lives in one internal module (`src/internal/config/env-keys.ts`), used by `--kms`. The Foundry migration guide shows the `--kms` form and the equivalent hand-written config, where each identifier is a `configVariable()` with the Foundry name. No `hardhat-kms/foundry` export ships in 1.0.

## Consequences

- A Foundry command maps to one Hardhat command with no config edit. Foundry:

  ```bash
  AWS_KMS_KEY_ID=alias/deployer forge script script/Deploy.s.sol --rpc-url "$SEPOLIA_RPC_URL" --aws --broadcast
  ```

  Hardhat, with a `sepolia` network that has no `kmsAccounts`:

  ```bash
  AWS_KMS_KEY_ID=alias/deployer npx hardhat run scripts/deploy.ts --network sepolia --kms aws
  ```

- CI sets the signer through the environment alone. Before, each key needed a `kms.keys` entry and a `kmsAccounts` list per network. After:

  ```bash
  export HARDHAT_KMS=aws
  export AWS_KMS_KEY_IDS="alias/deployer, alias/ops"
  npx hardhat ignition deploy ignition/modules/Token.ts --network sepolia --default-sender 0x…
  ```

- Config and command-line keys combine. With `kmsAccounts: ["deployer"]` on `sepolia`:

  ```bash
  AZURE_KEY_VAULT_KEY_ID=https://ops.vault.azure.net/keys/ops/0123abcd \
    npx hardhat run scripts/rotate.ts --network sepolia --kms azure
  # eth_accounts: [<local accounts>, <deployer>, <AZURE_KEY_VAULT_KEY_ID>]
  ```

- `HARDHAT_KMS` left in a shell profile or CI environment turns KMS signing on for every Hardhat command in it. Hardhat gives every global option this form, so the plugin cannot opt out; the docs say so next to the option.
- Command-line keys come after local and config accounts, so Ignition's default sender and `getWalletClients()[0]` are not the `--kms` key when the network has other accounts. Users pass `--default-sender` or pick the account in the script. A Foundry user with no other accounts on the network gets the `--kms` key first.
- Command-line keys have no address pin, as in Foundry, so the first use costs one public-key call per key. Users who want a pin move the key to the config.
- The name `kms` is now a global option. No task in any loaded plugin can define a `--kms` option; the plugin's own `kms` tasks take none.
- Switching from append to replace later would change which accounts a command signs with, so it needs a new decision. Revisit this one if foundry-core#228 renames the Azure variables, if Foundry adds multi-key GCP variables, or if a third-party provider asks for a command-line mapping.

Options not taken:

- `--aws`, `--gcp`, `--azure` as global flags, spelled like Foundry. Three generic names would block any other plugin from using them as global or task options, and each new provider would add another. `--kms aws` keeps one name and reads the same in a Foundry user's history.
- A `--kms` task option on each task. It would not reach `hardhat run` scripts, Ignition or tests, and tasks from other plugins would not get it.
- Replacing the network's config keys with the command-line keys. Useful for "use this key instead", but a network whose config lists several keys would lose them silently. Appending with a duplicate check keeps both visible.
- Loading keys whenever Foundry's variables are set. A leftover `AWS_KMS_KEY_ID` would then change who signs.
- Attaching command-line keys to every connection in the process. A script that connects to a second network would sign there with a key chosen for the first.

## Clarifications

Added on 2026-09-30, while implementing the first part of [#84](https://github.com/aelmanaa/hardhat-kms/issues/84). They settle details the decision left open, without changing it.

- **Empty values.** An empty or blank `--kms` or `HARDHAT_KMS` turns the option off, so `HARDHAT_KMS=` works as it does for other settings. An empty or blank list variable counts as unset, and the single variable is read instead. A list of only commas and spaces is an error.
- **The single variable is split on commas too**, as Foundry's multi-key path does. `AWS_KMS_KEY_ID=alias/a,alias/b` loads two keys, named `AWS_KMS_KEY_ID[0]` and `AWS_KMS_KEY_ID[1]`. A single entry keeps the plain name.
- **Repeated key ids** in one variable are an error when Hardhat starts, for example `--kms aws: AWS_KMS_KEY_IDS[2] repeats AWS_KMS_KEY_IDS[0]`.
- **Help always works.** With `--help`, the option is not read, so a wrong `HARDHAT_KMS` cannot hide the help that explains it. Every other command, including a bare `npx hardhat`, reads and checks it.
- **Error paths name the field**, as for config keys: `invalid value for --kms azure.keyId (<AZURE_KEY_VAULT_KEY_ID>): …`. A bad GCP value names the variable at fault, for example `--kms gcp.keyRing (<GCP_KEY_RING>)`.
- **Typing.** `GlobalOptions.kms` is `string | undefined`, as Hardhat declares its own options without defaults.
- **Hook contexts.** The keys are found from the runtime or from any hook context, which Hardhat builds with the runtime as its prototype. The network hook in M4 relies on this.
- **ARN regions.** A `--kms` AWS key id is always read from the environment, so its region is taken from the ARN when the key is first used, as for configuration variables. The AWS adapter tests this case ([#16](https://github.com/aelmanaa/hardhat-kms/issues/16)).
