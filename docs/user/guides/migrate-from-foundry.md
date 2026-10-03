# Migrate from Foundry

Audience: Foundry users moving KMS signing to Hardhat.

`--kms` keys are added to the selected network and sign messages, typed data and transactions, with keys in AWS KMS, Google Cloud KMS or Azure Key Vault.

Foundry picks a KMS signer per command with `--aws` or `--gcp`, and reads the key from environment variables. hardhat-kms reads the same variables, in two ways. Both need the provider's package in `plugins`: `@hardhat-kms/aws` ([Set up an AWS KMS key](aws-kms-setup.md#3-install-the-plugin-and-configure-the-key)), `@hardhat-kms/gcp` ([Set up a Google Cloud KMS key](gcp-kms-setup.md#3-install-the-plugin-and-configure-the-key)) or `@hardhat-kms/azure` ([Set up an Azure Key Vault key](azure-key-vault-setup.md#4-install-the-plugin-and-configure-the-key)).

## From the command line, as in Foundry

Add `--kms` with the providers to load, and keep your environment as it is:

```sh
# Foundry
AWS_KMS_KEY_ID=alias/deployer forge script script/Deploy.s.sol --rpc-url "$SEPOLIA_RPC_URL" --aws --broadcast

# Hardhat
AWS_KMS_KEY_ID=alias/deployer npx hardhat run scripts/deploy.ts --network sepolia --kms aws
```

| `--kms` value | Variables read, as in Foundry                                                       |
| ------------- | ----------------------------------------------------------------------------------- |
| `aws`         | `AWS_KMS_KEY_IDS` (comma-separated) if set, else `AWS_KMS_KEY_ID`                   |
| `gcp`         | `GCP_PROJECT_ID`, `GCP_LOCATION`, `GCP_KEY_RING`, `GCP_KEY_NAME`, `GCP_KEY_VERSION` |
| `azure`       | `AZURE_KEY_VAULT_KEY_IDS` (comma-separated) if set, else `AZURE_KEY_VAULT_KEY_ID`   |

Foundry has no Azure Key Vault signer in a release yet: Foundry 1.8.4, the latest on 2026-10-03, has no `--azure`. The signer is proposed in [foundry-rs/foundry#17120](https://github.com/foundry-rs/foundry/pull/17120), a draft that was still open on that date. The `azure` variable names follow that proposal and may change before it ships.

- Several providers: `--kms aws,azure`.
- In CI, `HARDHAT_KMS=aws` does the same as the option. Hardhat reads it for every command, so do not leave it in a shell profile unless every Hardhat command there should load KMS keys.
- Nothing is read unless `--kms` names the provider.
- As in Foundry, the single variable can also hold a comma-separated list. An empty variable counts as unset, and `HARDHAT_KMS=` turns the option off.
- `npx hardhat --help` works even when `HARDHAT_KMS` is wrong.
- Hardhat reads and checks the variables when it starts, so a missing or malformed one fails before any task runs. The error names the variable and never shows its value:

  ```text
  Error in community plugin hardhat-kms: --kms gcp: GCP_PROJECT_ID is not set
  ```

- The keys sign on the `--network` you select, after any keys the config gives that network.
- `cast wallet address --aws` becomes `npx hardhat --kms aws kms address AWS_KMS_KEY_ID`: a task names a `--kms` key by its variable ([tasks reference](../reference/tasks.md#naming-a-key)). For `--kms gcp` the name is `GCP_KEY_*`, not `GCP_KEY_NAME`. Quote it, since zsh refuses an unquoted `*` that matches no file: `npx hardhat --kms gcp kms address 'GCP_KEY_*'`.
- `cast wallet sign --aws <message>` becomes `npx hardhat --kms aws kms sign AWS_KMS_KEY_ID <message>`, with the same `--data`, `--from-file` and `--no-hash` flags and the same output. Unlike cast, which also accepts 64 hex digits without a prefix, `--no-hash` needs the `0x` prefix. Typed data that names a chain also needs `--network`, `--chain` or `--allow-cross-chain`, which cast does not check ([`kms sign`](../reference/tasks.md#kms-sign)).
- `cast wallet verify --address <address> <message> <signature>` becomes `npx hardhat kms verify --address <address> <message> <signature>`, with the same `--data [--from-file]` flags. `--key <key>` checks against a KMS key's address instead. There is no `--no-hash` ([`kms verify`](../reference/tasks.md#kms-verify)).
- `cast wallet list --aws` becomes `npx hardhat --kms aws kms accounts`. It also lists the keys in the config and checks each `address` pin. A key that fails is shown next to its name and makes the command exit with code 1, where `cast wallet list` prints the error and exits 0 ([`kms accounts`](../reference/tasks.md#kms-accounts)).
- `cast mktx --aws --rpc-url <url> <to> --value 1` becomes `npx hardhat --kms aws --network <network> kms sign-tx AWS_KMS_KEY_ID tx.json`, with `{ "to": "<to>", "value": "0x1" }` in `tx.json`. As with cast, standard output holds only the raw transaction, so `cast publish $(npx hardhat ... kms sign-tx ...)` sends it; the hash goes to standard error. The task reads the transaction from a JSON file with `eth_sendTransaction` fields, so calldata goes in `data` already encoded, where `cast mktx` takes a function signature and arguments ([`kms sign-tx`](../reference/tasks.md#kms-sign-tx)).
- `cast wallet sign-auth --aws <address>` becomes `npx hardhat --kms aws kms sign-auth --network <name> AWS_KMS_KEY_ID <address>`, with the same `--nonce`, `--chain` and `--self-broadcast` flags. cast prints the RLP-encoded authorization; the task prints the JSON tuple that Hardhat's `authorizationList` takes. `--chain` takes numeric chain ids only, not names such as `mainnet`. Pass `--chain` or `--network`, not both: without `--network`, also pass `--nonce`. Chain 0 needs `--force`, which cast does not ask for ([`kms sign-auth`](../reference/tasks.md#kms-sign-auth)).

## In the config

To keep the choice in `hardhat.config.ts`, point each key at the same variables with `configVariable()`:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    keys: {
      deployer: { provider: "aws", keyId: configVariable("AWS_KMS_KEY_ID") },
    },
  },
  networks: {
    sepolia: { type: "http", url: configVariable("SEPOLIA_RPC_URL"), kmsAccounts: ["deployer"] },
  },
});
```

The [configuration reference](../reference/configuration.md) covers every key form. On AWS and Google Cloud, credentials come from the SDK's default chain in both cases, as in Foundry, with one difference on AWS: today, when `AWS_PROFILE` or a key's `profile` is set, the AWS SDK for JavaScript ignores `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, where Foundry uses them. The SDK's own warning says a future version may prefer the keys, so a CI job that exports access keys must not also set a profile ([Credentials](../reference/configuration.md#aws)). Azure uses the plugin's own chain, since no Foundry release has an Azure signer yet ([Credentials](../reference/configuration.md#azure)).
