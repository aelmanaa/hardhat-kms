# Migrate from Foundry

Audience: Foundry users moving KMS signing to Hardhat.

Status: Planned ([#84](https://github.com/aelmanaa/hardhat-kms/issues/84)). The design is settled in [decision 0008](../../contributor/decisions/0008-kms-command-line-option.md); the option does not exist yet.

Foundry picks a KMS signer per command with `--aws`, `--gcp` or `--azure`, and reads the key from environment variables. hardhat-kms reads the same variables, in two ways.

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

- Several providers: `--kms aws,azure`. In CI, `HARDHAT_KMS=aws` does the same as the option.
- Nothing is read unless `--kms` names the provider.
- The keys sign on the `--network` you select, after any keys the config gives that network.

## In the config

To keep the choice in `hardhat.config.ts`, point each key at the same variables with `configVariable()`:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKms from "hardhat-kms";

export default defineConfig({
  plugins: [hardhatKms],
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
