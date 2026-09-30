# hardhat-kms docs

hardhat-kms is a Hardhat 3 plugin that signs transactions, messages and typed data with secp256k1 keys held in AWS KMS, Google Cloud KMS and Azure Key Vault. The private key never leaves the KMS.

The plugin is not released yet. Each page opens with a Status line that says what exists today and which milestone delivers the rest.

## Using the plugin

| Page                                                              | Kind        |
| ----------------------------------------------------------------- | ----------- |
| [Configuration](user/reference/configuration.md)                  | Reference   |
| [RPC methods](user/reference/rpc-methods.md)                      | Reference   |
| [Tasks](user/reference/tasks.md)                                  | Reference   |
| [Migrate from Foundry](user/guides/migrate-from-foundry.md)       | How-to      |
| [Comparison with Foundry](user/explanation/foundry-comparison.md) | Explanation |

Tutorials and the remaining guides are listed under [Planned pages](contributor/documentation.md#planned-pages).

## Contributing

| Page                                                             | What it covers                                    |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| [CONTRIBUTING.md](../CONTRIBUTING.md)                            | Setup, commands, workflow                         |
| [Architecture](contributor/architecture.md)                      | Module map, code map, request flows               |
| [Signing pipeline and security](contributor/signing-pipeline.md) | Signature checks, key pinning, threat model       |
| [Provider contract](contributor/providers.md)                    | The adapter interface for KMS and HSM providers   |
| [Transactions](contributor/transactions.md)                      | Filling, nonces, the send lock, chain-id checks   |
| [Testing](contributor/testing.md)                                | Test layers and conventions                       |
| [Tooling](contributor/tooling.md)                                | Quality gates, hooks, CI                          |
| [Documentation](contributor/documentation.md)                    | How the docs are organised and the rules for them |
| [Decision records](contributor/decisions/README.md)              | Why the main decisions were made                  |
| [Roadmap](contributor/roadmap.md)                                | Releases and milestones                           |
| [SECURITY.md](../SECURITY.md)                                    | Reporting vulnerabilities                         |
