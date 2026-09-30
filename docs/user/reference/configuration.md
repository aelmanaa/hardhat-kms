# Configuration reference

Audience: Users configuring the plugin.

Status: M2 implements validation and resolution of this config, and M3 the AWS adapter ([set up an AWS KMS key](../guides/aws-kms-setup.md)). Signing from scripts and tasks needs the network hook (M4); the Google Cloud and Azure adapters come in M6.

## Configuration

Keys are declared once under `kms.keys` and referenced by name from any network:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKms from "hardhat-kms";

export default defineConfig({
  plugins: [hardhatKms],
  kms: {
    defaults: { aws: { region: "eu-west-1" }, timeoutMs: 30_000 },
    keys: {
      deployer: { provider: "aws", keyId: "alias/deployer", address: "0x1234…" }, // address pin: optional, recommended
      ops: { provider: "azure", keyId: "https://ops.vault.azure.net/keys/ops/0123abcd" },
      treasury: {
        provider: "gcp",
        keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/3",
      },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["deployer", "ops"],
    },
    arbitrum: {
      type: "http",
      url: configVariable("ARB_RPC_URL"),
      chainId: 42161,
      kmsAccounts: ["deployer"],
    },
    fork: {
      type: "edr-simulated",
      forking: { url: configVariable("SEPOLIA_RPC_URL") },
      kmsAccounts: ["deployer"],
    },
  },
});
```

A network's `kmsAccounts` lists key names or inline key objects. The full set of plugin config fields:

| Field                          | Meaning                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `kms.keys`                     | Named keys, reused across networks.                                                                                               |
| `kms.defaults.aws.region`      | Default AWS region (see the region precedence below).                                                                             |
| `kms.defaults.timeoutMs`       | Default per-call timeout. Default 30 s.                                                                                           |
| `kms.allowCrossChainTypedData` | Allow typed data whose `domain.chainId` differs from the connection's chain. Default `false`.                                     |
| `kms.simulatedBalance`         | A bigint in wei. On `edr-simulated` networks only, the plugin calls `hardhat_setBalance` for each KMS address on `newConnection`. |
| `networks.<name>.kmsAccounts`  | Key names or inline key objects for that network, on http and `edr-simulated` networks.                                           |
| `address` (per key)            | Optional address pin. Recommended: it avoids a KMS call to learn the address and guards against key substitution.                 |
| `timeoutMs` (per key)          | Overrides the default timeout for that key.                                                                                       |
| `approvalTimeoutMs`            | Timeout for providers with asynchronous approval flows, set alongside `timeoutMs`.                                                |

The plugin will warn when `kmsAccounts` is set on the `default` network (planned for M4).

## Keys from the command line

Keys can also come from Foundry's environment variables with `--kms aws`, `--kms gcp`, `--kms azure` or a comma-separated list, without a config entry. These keys inherit `kms.defaults` and pass the same checks as config keys. See [Migrate from Foundry](../guides/migrate-from-foundry.md#from-the-command-line-as-in-foundry) and [decision 0008](../../contributor/decisions/0008-kms-command-line-option.md).

## Validation rules

Hardhat validates the config when it loads, and reports every problem with its path from the config root:

```text
HHE15: Invalid config:
	* Config error in config.kms.keys.deployer.keyId: Expected an https URL on an Azure Key Vault or Managed HSM host (for example `*.vault.azure.net`) with the path /keys/<name> or /keys/<name>/<version>
	* Config error in config.networks.sepolia.kmsAccounts.0: Unknown key "deployr". Known keys: deployer.
```

The rules:

- **Key names** in `kms.keys` start with a letter and have at most 64 characters: letters, digits, `_` or `-`. They are kept simple because tasks will take them as command-line arguments.
- **`kmsAccounts`** entries are key names from `kms.keys` or inline key objects. A name must exist in `kms.keys`, and a network cannot list the same name twice. Errors and resolved configs call an inline key `<network>.kmsAccounts[<index>]`.
- **`provider`** is `aws`, `gcp`, `azure` or a third-party provider's id. An id that looks like a misspelled built-in one, such as `AWS` or `azrue`, is an error rather than a third-party provider.
- **Unknown fields** in the `kms` section and in built-in providers' keys are errors, so a typo such as `keyID` is caught. For a third-party provider's key, the plugin checks only `provider`, `address`, `timeoutMs` and `approvalTimeoutMs`.
- **`address`** is a `0x`-prefixed 20-byte address, all lowercase, all uppercase, or mixed case with a valid EIP-55 checksum.
- **`timeoutMs`** and **`approvalTimeoutMs`** are whole numbers of milliseconds from 1 to 2147483647, the largest delay Node.js timers accept.
- **`simulatedBalance`** is a non-negative `bigint`, for example `10n ** 18n`.

Key identifiers are checked against the formats below. A literal value is checked when the config loads. A value from a configuration variable is read only when the key is first used, and is checked then, with the same rules; the error names the config path and the variable, never its value:

```text
invalid value for kms.keys.ops.keyId (<AZURE_KEY_ID>): expected an https URL on an Azure Key Vault or Managed HSM host (for example `*.vault.azure.net`) with the path /keys/<name> or /keys/<name>/<version>
```

| Field                | Accepted format                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS `keyId`          | A key id (lowercase `1234abcd-…` or `mrk-…`), an alias name (`alias/…`), a key ARN or an alias ARN. ARNs may use any AWS partition, such as `aws`, `aws-cn` or `aws-us-gov`.                                               |
| AWS `region`         | Must match the region inside an ARN `keyId` when both are set.                                                                                                                                                             |
| GCP `keyVersionName` | `projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>/cryptoKeyVersions/<n>`, where `<n>` is a positive integer.                                                                                                         |
| GCP components       | `projectId`, `location`, `keyRing` and `keyName` use letters, digits, `_`, `.`, `:` or `-`, and cannot be `.` or `..`. `keyVersion` is a positive integer, as a number or a string. Set either the name or the components. |
| Azure `keyId`        | `https://<vault>/keys/<name>` or `https://<vault>/keys/<name>/<version>`.                                                                                                                                                  |
| Azure `vaultUrl`     | `https://<vault>` with no path. Set either `keyId`, or `vaultUrl` with `keyName` and an optional `keyVersion`.                                                                                                             |

An Azure key name has 1 to 127 letters, digits or `-`, and a key version has letters and digits only. `<vault>` must be a Key Vault or Managed HSM host in the public cloud or a sovereign cloud: `*.vault.azure.net`, `*.managedhsm.azure.net`, `*.vault.azure.cn`, `*.managedhsm.azure.cn`, `*.vault.usgovcloudapi.net`, `*.managedhsm.usgovcloudapi.net`, `*.vault.microsoftazure.de` or `*.managedhsm.microsoftazure.de`. The plugin rejects other hosts, non-default ports, `http`, backslashes, and URLs with credentials, a query or a fragment, so a key id cannot send signing requests to another server. This applies to values from configuration variables too.

## Resolved config

After loading, `hre.config.kms` holds the resolved section. Every network's config gets a `kmsAccounts` array of resolved keys, empty when none are configured. A key listed by name resolves to the same settings as its entry in `hre.config.kms.keys`.

Each resolved key has a `displayId` that is safe to print: the provider id and the key identifier, such as `aws:alias/deployer`. An identifier read from a configuration variable shows as the variable's name, for example `aws:<AWS_KMS_KEY_ID>`, and its value is read only when the key is used. A third-party provider's key shows as `<provider>:<key name>`, and its `userConfig` holds the key's fields with configuration variables resolved, as Hardhat does for its own config.

The resolved types are exported from `hardhat-kms/types`. Narrow a resolved key on its `provider` field; a third-party provider adds its resolved type to `KmsProviderConfigs`.

## Key forms per provider

The accepted key forms are a superset of Foundry's.

| Provider | Key forms                                                                                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws`    | `keyId` as a key id, key ARN, alias name or alias ARN. Optional `region`, `profile`, `endpoint`.                                                                                                                 |
| `gcp`    | Either `keyVersionName`, or the components `projectId`, `location`, `keyRing`, `keyName`, `keyVersion`. The version is always required and never auto-selected.                                                  |
| `azure`  | Either `keyId` (the full URL, versioned or not, including `*.managedhsm.azure.net`), or `vaultUrl` + `keyName` + optional `keyVersion`. An unversioned key is resolved once and the resulting version is pinned. |

AWS resolves the region in this order: the region inside an ARN, then `key.region`, then `defaults.aws.region`, then the SDK's own chain. A configured region that conflicts with the ARN's region is an error. `AWS_ENDPOINT_URL_KMS` (useful for LocalStack) is left to the AWS SDK, which honours it.

Identifiers are not secrets. Every identifier field still accepts `string | ConfigurationVariable`. A value that came from a variable is displayed as `<VAR_NAME>` unless the user passes `--show-ids`.

Third-party providers extend the config types through the declaration-merged `KmsProviderUserConfigs` interface (see [Provider contract](../../contributor/providers.md#provider-contract)).

## Provider SDKs

The plugin loads a provider's SDK from your project the first time one of its keys is used. Install the SDK for each provider you use as a dependency of your own project, because the plugin resolves it from your project's `package.json`:

| Provider         | Install                                                              |
| ---------------- | -------------------------------------------------------------------- |
| AWS KMS          | `npm install @aws-sdk/client-kms@"^3.714.0"`                         |
| Google Cloud KMS | `npm install @google-cloud/kms@"^6.0.0"`                             |
| Azure Key Vault  | `npm install @azure/keyvault-keys@"^4.0.0" @azure/identity@"^4.0.0"` |

Loading the config never loads an SDK. When a key is used, the SDK must be installed in the project (or hoisted to a workspace root above it), within the supported range and not a prerelease; otherwise the error says what is wrong and gives the command to install a supported version. A copy found only through `NODE_PATH` or a global folder is not used.

## Credentials

No secrets live in the Hardhat config. Each provider takes credentials from its SDK's default chain:

- AWS uses the SDK default chain: environment, then SSO/ini/profile, then process, then web identity, then IMDS/ECS.
- GCP uses Application Default Credentials.
- Azure builds the chain below, which follows the order used by Foundry's Azure Key Vault signer (service principal, workload identity, `az`/`azd`, managed identity).

<!-- docs-check: skip -->

```ts
new ChainedTokenCredential(
  EnvironmentCredential,
  WorkloadIdentityCredential,
  AzureCliCredential,
  AzureDeveloperCliCredential,
  ManagedIdentityCredential({ clientId: AZURE_CLIENT_ID }),
);
```

`AZURE_CLIENT_ID` selects a user-assigned managed identity. The managed identity `getToken` call has a 10 s timeout.
