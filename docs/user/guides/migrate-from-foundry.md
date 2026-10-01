# Migrate from Foundry

Audience: Foundry users moving KMS signing to Hardhat.

Status: In progress ([#84](https://github.com/aelmanaa/hardhat-kms/issues/84)), following [decision 0008](../../contributor/decisions/0008-kms-command-line-option.md). Hardhat accepts `--kms` and checks its variables, but nothing signs with the keys yet: the network hook (M4) signs with a network's `kmsAccounts`, and adding `--kms` keys to the selected network is [#84](https://github.com/aelmanaa/hardhat-kms/issues/84). The AWS adapter is implemented (M3); Google Cloud and Azure come in M6.

Foundry picks a KMS signer per command with `--aws`, `--gcp` or `--azure`, and reads the key from environment variables. hardhat-kms reads the same variables, in two ways. Both need the provider's package in `plugins`: for AWS keys, install `hardhat-kms-aws` as shown in [Set up an AWS KMS key](aws-kms-setup.md#3-install-the-plugin-and-configure-the-key).

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

## In the config

To keep the choice in `hardhat.config.ts`, point each key at the same variables with `configVariable()`:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "hardhat-kms-aws";

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

The [configuration reference](../reference/configuration.md) covers every key form. Cloud credentials come from each provider's SDK in both cases, as in Foundry.
