# Configuration reference

Audience: Users configuring the plugin.

Status: Validation and resolution of this config are implemented (M2). Signing with a key needs its provider: AWS arrives in M3, Google Cloud and Azure in M6. The warning for `kmsAccounts` on the `default` network is planned for M4.

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

## Validation rules

Hardhat validates the config when it loads, and reports every problem with its path from the config root:

```text
HHE15: Invalid config:
	* Config error in config.kms.keys.deployer.keyId: Expected an https URL on an Azure Key Vault or Managed HSM host (for example `*.vault.azure.net`) with the path /keys/<name> or /keys/<name>/<version>
	* Config error in config.networks.sepolia.kmsAccounts.0: Unknown key "deployr". Known keys: deployer.
```

The rules:

- **Key names** start with a letter and use at most 64 letters, digits, `_` or `-`, because tasks take them as arguments.
- **`kmsAccounts`** entries are key names from `kms.keys` or inline key objects. A name must exist, and a network cannot list the same name twice. An inline key is named `<network>.kmsAccounts[<index>]` in output.
- **Unknown fields** are errors, so a typo such as `keyID` is caught.
- **`address`** is a `0x`-prefixed 20-byte address. It can be all lowercase or all uppercase; a mixed-case address must have a valid EIP-55 checksum.
- **`timeoutMs`** and **`approvalTimeoutMs`** are whole numbers of milliseconds from 1 to 2147483647, the largest delay Node.js timers accept.
- **`simulatedBalance`** is a non-negative `bigint`, for example `10n ** 18n`.

Values written as literal strings are also checked for their format. Values from configuration variables are checked when the key is first used, since their value is only read then.

| Field                | Accepted format                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS `keyId`          | A key id (`1234abcd-…` or `mrk-…`), a key ARN, an alias name (`alias/…`) or an alias ARN, in the `aws`, `aws-cn`, `aws-us-gov`, `aws-iso` or `aws-iso-b` partition.    |
| AWS `region`         | Must match the region inside an ARN `keyId`, if both are set.                                                                                                          |
| GCP `keyVersionName` | `projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>/cryptoKeyVersions/<n>`, where `<n>` is a positive integer.                                                     |
| GCP components       | `projectId`, `location`, `keyRing` and `keyName` without slashes, and `keyVersion` as a positive integer or a string of digits. Use either the name or the components. |
| Azure `keyId`        | `https://<vault>/keys/<name>` or `https://<vault>/keys/<name>/<version>`.                                                                                              |
| Azure `vaultUrl`     | `https://<vault>` with no path. Use either `keyId` or `vaultUrl` with `keyName` and an optional `keyVersion`.                                                          |

For Azure, `<vault>` must be a Key Vault or Managed HSM host in the public or a sovereign cloud: `*.vault.azure.net`, `*.managedhsm.azure.net`, `*.vault.azure.cn`, `*.managedhsm.azure.cn`, `*.vault.usgovcloudapi.net`, `*.managedhsm.usgovcloudapi.net`, `*.vault.microsoftazure.de` or `*.managedhsm.microsoftazure.de`. Other hosts, other ports, `http` and URLs with credentials are rejected, so a key id cannot send signing requests to another server.

## Resolved config

After loading, `hre.config.kms` holds the resolved section, and each network's config has a `kmsAccounts` array of resolved keys (empty when none are configured). A key listed by name on a network is the same object as the entry in `hre.config.kms.keys`.

Each resolved key has a `displayId` that is safe to print, such as `aws:alias/deployer`. A value read from a configuration variable shows as its name, for example `aws:<AWS_KMS_KEY_ID>`; the value itself is read only when the key is used. The types are exported from `hardhat-kms/types`.

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

## Credentials

No secrets live in the Hardhat config. Each provider takes credentials from its SDK's default chain:

- AWS uses the SDK default chain: environment, then SSO/ini/profile, then process, then web identity, then IMDS/ECS.
- GCP uses Application Default Credentials.
- Azure builds the chain below, which follows the order used by Foundry's Azure Key Vault signer (service principal, workload identity, `az`/`azd`, managed identity).

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
