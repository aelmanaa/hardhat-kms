# hardhat-kms docs

hardhat-kms is a Hardhat 3 plugin that signs transactions, messages and typed data with secp256k1 keys held in AWS KMS, Google Cloud KMS and Azure Key Vault. The private key never leaves the KMS.

The plugin is not released yet. Each page opens with a Status line that says what exists today and which milestone delivers the rest.

## Tutorials

| Page                                                                       | Kind     |
| -------------------------------------------------------------------------- | -------- |
| [First deploy on Sepolia with AWS KMS](user/tutorials/first-deploy-aws.md) | Tutorial |

## Using the plugin

| Page                                                                  | Kind        |
| --------------------------------------------------------------------- | ----------- |
| [Configuration](user/reference/configuration.md)                      | Reference   |
| [RPC methods](user/reference/rpc-methods.md)                          | Reference   |
| [Tasks](user/reference/tasks.md)                                      | Reference   |
| [Set up an AWS KMS key](user/guides/aws-kms-setup.md)                 | How-to      |
| [Set up an Azure Key Vault key](user/guides/azure-key-vault-setup.md) | How-to      |
| [Set up a Google Cloud KMS key](user/guides/gcp-kms-setup.md)         | How-to      |
| [Prevent and recover from losing a key](user/guides/key-loss.md)      | How-to      |
| [Rotate a key and pin its address](user/guides/key-rotation.md)       | How-to      |
| [Use several keys across networks](user/guides/multiple-keys.md)      | How-to      |
| [Debug output](user/guides/debug-output.md)                           | How-to      |
| [Deploy with Hardhat Ignition](user/guides/deploy-with-ignition.md)   | How-to      |
| [Migrate from Foundry](user/guides/migrate-from-foundry.md)           | How-to      |
| [Comparison with Foundry](user/explanation/foundry-comparison.md)     | Explanation |
| [How hardhat-kms works](user/explanation/how-it-works.md)             | Explanation |
| [Security model](user/explanation/security-model.md)                  | Explanation |

Runnable projects for viem, ethers and Ignition are in [examples/](../examples/README.md). The remaining tutorials and guides are listed under [Planned pages](contributor/documentation.md#planned-pages).

## Contributing

| Page                                                             | What it covers                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| [CONTRIBUTING.md](../CONTRIBUTING.md)                            | Setup, commands, workflow, issue-first rule          |
| [Architecture](contributor/architecture.md)                      | Module map, code map, request flows                  |
| [Signing pipeline and security](contributor/signing-pipeline.md) | Signature checks, key pinning, threat model          |
| [Provider contract](contributor/providers.md)                    | The adapter interface for KMS and HSM providers      |
| [Transactions](contributor/transactions.md)                      | Filling, nonces, the send lock, chain-id checks      |
| [Testing](contributor/testing.md)                                | Test layers and conventions                          |
| [Live proof](live-proof.md)                                      | Transactions of the latest live run on Sepolia       |
| [Tooling](contributor/tooling.md)                                | Quality gates, hooks, CI                             |
| [Documentation](contributor/documentation.md)                    | How the docs are organised and the rules for them    |
| [Decision records](contributor/decisions/README.md)              | Why the main decisions were made                     |
| [Signing prior art](contributor/research/signing-prior-art.md)   | How other signers compare, and why each check exists |
| [Roadmap](contributor/roadmap.md)                                | Releases and milestones                              |
| [SECURITY.md](../SECURITY.md)                                    | Reporting vulnerabilities                            |
