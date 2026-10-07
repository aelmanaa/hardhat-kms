# hardhat-kms docs

hardhat-kms is a Hardhat 3 plugin that signs transactions, messages and typed data with secp256k1 keys held in AWS KMS, Google Cloud KMS and Azure Key Vault. The private key never leaves the KMS.

Each page except the generated API reference opens with an `Audience:` line that names who it is for and what it assumes. [Release channels and versioning](user/explanation/versioning.md#channels) says which release to install and what a version promises.

## Start here

- I need a key and want a first deploy: First deploy on Sepolia with [AWS KMS](user/tutorials/first-deploy-aws.md), [Google Cloud KMS](user/tutorials/first-deploy-gcp.md) or [Azure Key Vault](user/tutorials/first-deploy-azure.md).
- I already have a secp256k1 key in a KMS: start at step 2 of the setup guide for [AWS KMS](user/guides/aws-kms-setup.md#2-allow-signing-and-nothing-else), [Google Cloud KMS](user/guides/gcp-kms-setup.md#2-allow-signing-and-nothing-else) or [Azure Key Vault](user/guides/azure-key-vault-setup.md#2-allow-get-and-sign-and-nothing-else).
- I want to deploy my contracts: [Deploy with Hardhat Ignition](user/guides/deploy-with-ignition.md).
- A command or script failed: [Errors](user/reference/errors.md) has every error with its cause and fix. Search the page for a fixed part of the message.
- I sent a transaction and do not know what happened: [After an uncertain send](user/guides/uncertain-sends.md).
- What does the plugin protect against: [Security model](user/explanation/security-model.md).
- Is the package I installed the real one: [Verify a release](user/guides/verify-a-release.md).
- I want a KMS account in my own code: [Library accounts](user/reference/library-accounts.md).

## Tutorials

| Page                                                                                 | Kind     |
| ------------------------------------------------------------------------------------ | -------- |
| [First deploy on Sepolia with AWS KMS](user/tutorials/first-deploy-aws.md)           | Tutorial |
| [First deploy on Sepolia with Google Cloud KMS](user/tutorials/first-deploy-gcp.md)  | Tutorial |
| [First deploy on Sepolia with Azure Key Vault](user/tutorials/first-deploy-azure.md) | Tutorial |

## Using the plugin

| Page                                                                          | Kind        |
| ----------------------------------------------------------------------------- | ----------- |
| [Configuration](user/reference/configuration.md)                              | Reference   |
| [RPC methods](user/reference/rpc-methods.md)                                  | Reference   |
| [Tasks](user/reference/tasks.md)                                              | Reference   |
| [Errors](user/reference/errors.md)                                            | Reference   |
| [Library accounts](user/reference/library-accounts.md)                        | Reference   |
| [Support](user/reference/support.md)                                          | Reference   |
| [API reference](user/reference/api/README.md)                                 | Reference   |
| [Install before the first npm release](user/guides/install-before-release.md) | How-to      |
| [Set up an AWS KMS key](user/guides/aws-kms-setup.md)                         | How-to      |
| [Set up an Azure Key Vault key](user/guides/azure-key-vault-setup.md)         | How-to      |
| [Set up a Google Cloud KMS key](user/guides/gcp-kms-setup.md)                 | How-to      |
| [Prevent and recover from losing a key](user/guides/key-loss.md)              | How-to      |
| [Rotate a key and pin its address](user/guides/key-rotation.md)               | How-to      |
| [Use several keys across networks](user/guides/multiple-keys.md)              | How-to      |
| [Debug output](user/guides/debug-output.md)                                   | How-to      |
| [Deploy with Hardhat Ignition](user/guides/deploy-with-ignition.md)           | How-to      |
| [After an uncertain send](user/guides/uncertain-sends.md)                     | How-to      |
| [Migrate from Foundry](user/guides/migrate-from-foundry.md)                   | How-to      |
| [Verify a release](user/guides/verify-a-release.md)                           | How-to      |
| [Comparison with Foundry](user/explanation/foundry-comparison.md)             | Explanation |
| [How hardhat-kms works](user/explanation/how-it-works.md)                     | Explanation |
| [How the plugin reaches your cloud](user/explanation/cloud-access.md)         | Explanation |
| [Security model](user/explanation/security-model.md)                          | Explanation |
| [Release channels and versioning](user/explanation/versioning.md)             | Explanation |

Runnable projects for viem, ethers and Ignition are in [examples/](../examples/README.md). The remaining guides are listed under [Planned pages](contributor/documentation.md#planned-pages).

## Contributing

| Page                                                             | What it covers                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| [CONTRIBUTING.md](../CONTRIBUTING.md)                            | Setup, commands, workflow, issue-first rule          |
| [Architecture](contributor/architecture.md)                      | Module map, code map, request flows, cloud access    |
| [Signing pipeline and security](contributor/signing-pipeline.md) | Signature checks, key pinning, threat model          |
| [Security review](contributor/security-review.md)                | The checklist for signing and sending changes        |
| [Provider contract](contributor/providers.md)                    | The adapter interface for KMS and HSM providers      |
| [Transactions](contributor/transactions.md)                      | Filling, nonces, the send lock, chain-id checks      |
| [Testing](contributor/testing.md)                                | Test layers and conventions                          |
| [Live proof](live-proof.md)                                      | Transactions of the latest live run on Sepolia       |
| [Tooling](contributor/tooling.md)                                | Quality gates, hooks, CI                             |
| [Releasing](contributor/releasing.md)                            | Who releases, the signed tag, staging and promotion  |
| [Documentation](contributor/documentation.md)                    | How the docs are organised and the rules for them    |
| [Decision records](contributor/decisions/README.md)              | Why the main decisions were made                     |
| [Signing prior art](contributor/research/signing-prior-art.md)   | How other signers compare, and why each check exists |
| [Roadmap](contributor/roadmap.md)                                | What ships in 1.0 and what comes after               |
| [SECURITY.md](../SECURITY.md)                                    | Reporting vulnerabilities                            |
| [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)                      | Contributor Covenant 2.1 and how to report a breach  |
