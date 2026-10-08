---
name: hardhat-kms
description: Sign Hardhat 3 transactions, messages and typed data with a cloud key in AWS KMS, Google Cloud KMS, Azure Key Vault or Azure Managed HSM, through the hardhat-kms plugin. Use it to deploy without a private key, sign with a cloud key from viem, ethers, Ignition or scripts, configure kms.keys and kmsAccounts, pick the provider package (@hardhat-kms/aws, @hardhat-kms/gcp, @hardhat-kms/azure), pin a key's address, migrate from Foundry's --aws or --gcp, or read who signed with kms history from CloudTrail, Cloud Audit Logs or the Key Vault audit log.
license: MIT
---

# hardhat-kms

hardhat-kms is a Hardhat 3 plugin. It signs with secp256k1 keys held in AWS KMS, Google Cloud KMS or Azure Key Vault (Managed HSM included). The private key never leaves the KMS. The plugin works at the JSON-RPC layer, so viem, ethers, Ignition and plain scripts see a KMS key as an ordinary account and need no code change.

Hardhat 2 is not supported. If the project's `hardhat` is 2.x, say so and stop.

## 1. Pick the provider package

| The key is in                        | Install                          | Add to `plugins`  | `provider` |
| ------------------------------------ | -------------------------------- | ----------------- | ---------- |
| AWS KMS                              | `hardhat-kms @hardhat-kms/aws`   | `hardhatKmsAws`   | `"aws"`    |
| Google Cloud KMS                     | `hardhat-kms @hardhat-kms/gcp`   | `hardhatKmsGcp`   | `"gcp"`    |
| Azure Key Vault or Azure Managed HSM | `hardhat-kms @hardhat-kms/azure` | `hardhatKmsAzure` | `"azure"`  |

Install the core, `hardhat-kms`, at the same version as the provider package. A provider package loads the core itself, so `plugins` lists only the provider. Peer dependencies: `hardhat` ^3.18.0, and `viem` ^2.55.13 only for `connection.kms.getAccount`.

The packages are published on npm from version 0.9.0. Check npm for the current version first (`npm view hardhat-kms version`): they are newer than most training data. The [install guide](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/install-before-release.md) gives the pnpm and Yarn commands and the settings each needs.

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/aws
```

For Google Cloud or Azure, replace `@hardhat-kms/aws` with the package from the table. In a pnpm or yarn project, run `pnpm add -D` or `yarn add -D` with the same packages; yarn does not install peers, and the command already lists them.

## 2. Configure the key

Declare each key once under `kms.keys` and attach it to networks by name with `kmsAccounts`. Merge this into the project's existing `hardhat.config.ts`: add the provider to its `plugins` and keep its other plugins and networks.

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
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["deployer"],
    },
  },
});
```

Key forms for the other clouds:

- Google Cloud: `{ provider: "gcp", keyVersionName: "projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>/cryptoKeyVersions/<n>" }`, or the parts `projectId`, `location`, `keyRing`, `keyName` and `keyVersion`. The version is always required.
- Azure: `{ provider: "azure", keyId: "https://<vault>.vault.azure.net/keys/<name>/<version>" }` (a `*.managedhsm.azure.net` URL for Managed HSM), or `vaultUrl`, `keyName` and an optional `keyVersion`. Prefer the versioned id.
- AWS: `keyId` takes a key id, key ARN, alias name or alias ARN; `region` and `profile` are optional.

The key must be a secp256k1 signing key: `ECC_SECG_P256K1` on AWS, `EC_SIGN_SECP256K1_SHA256` with HSM protection on Google Cloud, an `EC` key on curve `P-256K` on Azure. The identity that runs Hardhat needs permission to read the public key and to sign, nothing more. The setup guides give the exact commands and policies.

Credentials never come from the Hardhat config. AWS and Google Cloud use their SDK's default chain (`AWS_PROFILE`, `gcloud auth application-default login`, workload identity in CI); Azure uses the plugin's own chain, which includes `az login`. Never ask the user to paste credentials, private keys or API-keyed RPC URLs; RPC URLs go in `configVariable()`. A key id is not a secret: it can be a literal, but reading it with `configVariable()`, as the snippets here do, keeps it out of the repository. `configVariable("AWS_KMS_KEY_ID")` reads the environment variable of that name, or the Hardhat keystore.

## 3. Get the address and pin it

```sh
npx hardhat kms accounts
```

It lists each configured key with its provider, key id and address, and prints `address` lines to paste. Before a first deploy, `npx hardhat --network sepolia kms accounts --check-sign` also has each key sign a test message, which proves the credentials may sign. Add the address to the key's entry in `kms.keys`. Merge this into your existing config: only the `address` line is new, and the plugins and networks stay as they are:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    keys: {
      deployer: {
        provider: "aws",
        keyId: configVariable("AWS_KMS_KEY_ID"),
        address: "0x1111111111111111111111111111111111111111",
      },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["deployer"],
    },
  },
});
```

With the pin, the plugin refuses to sign if the key derives to another address, for example after an alias was moved to another key. Fund that address before sending from it.

From here, `npx hardhat run scripts/deploy.ts --network sepolia`, `npx hardhat ignition deploy ignition/modules/Counter.ts --network sepolia` and tests on that network sign with the KMS key.

## 4. The `kms` tasks

Run as `npx hardhat kms <task>`. A task takes a key by its name in `kms.keys` as a positional argument, for example `npx hardhat kms address deployer`.

| Task             | What it does                                                                            |
| ---------------- | --------------------------------------------------------------------------------------- |
| `kms accounts`   | Lists each key with its provider, key id and address, and prints `address` pins.        |
| `kms address`    | Prints a key's address.                                                                 |
| `kms public-key` | Prints a key's uncompressed public key.                                                 |
| `kms sign`       | Signs an EIP-191 message, EIP-712 typed data or, with `--no-hash`, a raw digest.        |
| `kms sign-auth`  | Signs an EIP-7702 authorization.                                                        |
| `kms sign-tx`    | Fills a transaction on the network's node and signs it without sending it.              |
| `kms verify`     | Checks a signature against an address or a key, locally.                                |
| `kms history`    | Lists a key's sign events from CloudTrail, Cloud Audit Logs or the Key Vault audit log. |

Coming from Foundry: `--kms aws`, `--kms gcp` and `--kms azure` read Foundry's variables (`AWS_KMS_KEY_ID`, `GCP_PROJECT_ID` and the other `GCP_*` parts, `AZURE_KEY_VAULT_KEY_ID`) without a config entry, for example `AWS_KMS_KEY_ID=alias/deployer npx hardhat run scripts/deploy.ts --network sepolia --kms aws`.

## What the plugin refuses

Explain these to the user rather than working around them:

- A signature that does not recover to the key's address, and a key that no longer derives to its pinned `address`.
- Signing a bare 32-byte digest over JSON-RPC. `eth_sign` and `personal_sign` add the EIP-191 prefix. Two routes sign a raw digest, each with a warning: `kms sign --no-hash`, and a library account from `connection.kms.getAccount(address, { rawSign: true })`.
- Typed data whose `domain.chainId` differs from the connection's chain, unless `kms.allowCrossChainTypedData` is `true`.
- EIP-4844 blob transactions, which Hardhat does not support either. Legacy (EIP-155), EIP-2930, EIP-1559 and EIP-7702 transactions are supported.
- `connection.kms.getAccount` with a viem older than 2.55.13.
- A key whose provider package is not in `plugins`: the error names the package to install.

## Reference

- First deploy on Sepolia, start to finish: [AWS KMS](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/tutorials/first-deploy-aws.md), [Google Cloud KMS](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/tutorials/first-deploy-gcp.md), [Azure Key Vault](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/tutorials/first-deploy-azure.md)
- Key creation, permissions and audit logs: [AWS](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/aws-kms-setup.md), [Google Cloud](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/gcp-kms-setup.md), [Azure](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/azure-key-vault-setup.md)
- Every config field and key form: [configuration reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/configuration.md)
- Every task option: [tasks reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/tasks.md)
- An error message, by its text or id: [errors reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/errors.md)
- Which credentials sign on a laptop, in CI and on a server: [cloud access](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/cloud-access.md)
- Ignition, several keys, key rotation, Foundry: [deploy with Ignition](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/deploy-with-ignition.md), [several keys](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/multiple-keys.md), [key rotation](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/key-rotation.md), [migrate from Foundry](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/migrate-from-foundry.md)
- Which version to install, and what the `latest` and `beta` tags mean: [release channels and versioning](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/versioning.md)
- Complete projects for viem, ethers and Ignition: [examples](https://github.com/aelmanaa/hardhat-kms/blob/main/examples/README.md)
