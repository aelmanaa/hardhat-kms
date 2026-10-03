# Configuration reference

Audience: Users configuring the plugin.

Status: M2 implements validation and resolution of this config, and M3 the AWS adapter in the `@hardhat-kms/aws` package ([set up an AWS KMS key](../guides/aws-kms-setup.md)). M4 adds the network hook: connections to a network with `kmsAccounts` list the KMS accounts and sign messages and typed data with them ([RPC methods](rpc-methods.md)). `kms.allowCrossChainTypedData` governs the typed-data chain check ([#20](https://github.com/aelmanaa/hardhat-kms/issues/20)), and `--kms` keys are added to the selected network ([#84](https://github.com/aelmanaa/hardhat-kms/issues/84)). `kms.simulatedBalance` funds KMS accounts on `edr-simulated` networks ([#103](https://github.com/aelmanaa/hardhat-kms/issues/103)). The Azure adapter is in the `@hardhat-kms/azure` package ([set up an Azure Key Vault key](../guides/azure-key-vault-setup.md), [#30](https://github.com/aelmanaa/hardhat-kms/issues/30)). The Google Cloud adapter is in the `@hardhat-kms/gcp` package ([set up a Google Cloud KMS key](../guides/gcp-kms-setup.md), [#29](https://github.com/aelmanaa/hardhat-kms/issues/29)).

## Configuration

Keys are declared once under `kms.keys` and referenced by name from any network. Each provider's keys need its [provider package](#provider-packages) in `plugins`; the example lists `@hardhat-kms/aws`, which loads `hardhat-kms` itself:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
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

A network's `kmsAccounts` lists key names or inline key objects. [Use several keys across networks](../guides/multiple-keys.md) shows how to combine keys, providers and networks, and how to pick the sender. The full set of plugin config fields:

| Field                          | Meaning                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kms.keys`                     | Named keys, reused across networks.                                                                                                                                                                                                                                                                                                                                                  |
| `kms.defaults.aws.region`      | Default AWS region (see the region precedence below).                                                                                                                                                                                                                                                                                                                                |
| `kms.defaults.timeoutMs`       | Default per-call timeout. Default 30 s.                                                                                                                                                                                                                                                                                                                                              |
| `kms.allowCrossChainTypedData` | Allow typed data whose `domain.chainId` differs from the connection's chain, or in `kms sign --data` from the chain to compare with. Default `false`. Typed data without `domain.chainId` is always signed.                                                                                                                                                                          |
| `kms.simulatedBalance`         | A bigint in wei. On `edr-simulated` networks only, each new connection sets every KMS account's balance to this value with `hardhat_setBalance`, before the connection is returned. Addresses come from pins, or from key lookups, so connecting calls KMS for unpinned keys (pin addresses to avoid it); a failed lookup fails the connection. `hardhat_reset` clears the balances. |
| `kms.audit.azure.workspaceId`  | The Log Analytics workspace id (a GUID) that `kms history` reads Azure Key Vault audit events from. Literal or a configuration variable.                                                                                                                                                                                                                                             |
| `networks.<name>.kmsAccounts`  | Key names or inline key objects for that network, on http and `edr-simulated` networks.                                                                                                                                                                                                                                                                                              |
| `address` (per key)            | Optional address pin. Recommended: it guards against key substitution. Listing a network's accounts uses the pin without a KMS call. The first signature and the `kms` tasks still read the public key of an AWS, Google Cloud or Azure key, and fail if it derives to another address.                                                                                              |
| `timeoutMs` (per key)          | Overrides the default timeout for that key. For a third-party provider where a person approves each signature, `timeoutMs` also bounds the wait for that approval: raise it on that key to cover the time a person takes to approve.                                                                                                                                                 |

When the `default` network has KMS keys, from `kmsAccounts` or from `--kms` without `--network`, the plugin prints a warning once per run: tasks and tests use that network when no `--network` is given, so they would call KMS. Put KMS keys on a named network instead.

## Keys from the command line

Keys can also come from Foundry's environment variables with `--kms aws`, `--kms gcp`, `--kms azure` or a comma-separated list, without a config entry. Foundry has not released an Azure signer: the `azure` variable names follow the proposal in [foundry-rs/foundry#17120](https://github.com/foundry-rs/foundry/pull/17120) and may change before it ships. These keys inherit `kms.defaults` and pass the same checks as config keys. They are added to the selected network only (the `--network` value, or `default` without one), after the network's `kmsAccounts`. A command-line key that names the same KMS key as a config key on that network is an error that names both, without the value. See [Migrate from Foundry](../guides/migrate-from-foundry.md#from-the-command-line-as-in-foundry) and [decision 0008](../../contributor/decisions/0008-kms-command-line-option.md).

## Validation rules

Hardhat validates the config when it loads, and reports every problem with its path from the config root:

```text
HHE15: Invalid config:
	* Config error in config.kms.keys.deployer.keyId: Expected an https URL on an Azure Key Vault or Managed HSM host (for example `*.vault.azure.net`) with the path /keys/<name> or /keys/<name>/<version>
	* Config error in config.networks.sepolia.kmsAccounts.0: Unknown key "deployr". Known keys: deployer.
```

The rules:

- **Key names** in `kms.keys` start with a letter and have at most 64 characters: letters, digits, `_` or `-`. They are kept simple because tasks take them as command-line arguments.
- **`kmsAccounts`** entries are key names from `kms.keys` or inline key objects. A name must exist in `kms.keys`, and a network cannot list the same name twice. Errors and resolved configs call an inline key `<network>.kmsAccounts[<index>]`.
- **`provider`** is `aws`, `gcp`, `azure` or a third-party provider's id. An id that looks like a misspelled built-in one, such as `AWS` or `azrue`, is an error rather than a third-party provider.
- **Unknown fields** in the `kms` section and in built-in providers' keys are errors, so a typo such as `keyID` is caught. For a third-party provider's key, the plugin checks only `provider`, `address` and `timeoutMs`.
- **`address`** is a `0x`-prefixed 20-byte address, all lowercase, all uppercase, or mixed case with a valid EIP-55 checksum.
- **`timeoutMs`** is a whole number of milliseconds from 1 to 2147483647, the largest delay Node.js timers accept.
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

## Provider packages

`hardhat-kms` validates the keys of every provider, but signs only through a provider package. Each provider package is a Hardhat plugin that depends on its cloud SDK, so installing it installs the SDK:

| Provider         | Package                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| AWS KMS          | `npm install --save-dev hardhat-kms @hardhat-kms/aws`, then add `hardhatKmsAws` to `plugins`     |
| Google Cloud KMS | `npm install --save-dev hardhat-kms @hardhat-kms/gcp`, then add `hardhatKmsGcp` to `plugins`     |
| Azure Key Vault  | `npm install --save-dev hardhat-kms @hardhat-kms/azure`, then add `hardhatKmsAzure` to `plugins` |

Until the first npm release these installs fail with `E404`; [Install before the first npm release](../guides/install-before-release.md) builds the packages from the repository instead.

A provider package loads `hardhat-kms` itself, so `plugins: [hardhatKmsAws]` is enough. Listing `hardhatKms` as well also works. Install `hardhat-kms` and the provider packages at the same version; they are released together.

Loading the config never loads an SDK. A provider package loads its SDK the first time one of its keys is used. A key whose provider package is not in `plugins` fails when it is first used, and the error says which package to install:

```text
aws, create adapter, key aws:alias/deployer: AWS KMS keys need the @hardhat-kms/aws plugin. Install it with `npm install --save-dev @hardhat-kms/aws` and add it to `plugins` in your Hardhat config
```

## Other signing plugins

hardhat-kms works next to `@nomicfoundation/hardhat-ledger`. List hardhat-ledger first:

```ts
import hardhatLedger from "@nomicfoundation/hardhat-ledger";
import { defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatLedger, hardhatKmsAws],
});
```

In this order, hardhat-kms gives a raw `eth_sendTransaction` request without `from` its default sender ([RPC methods](rpc-methods.md#rpc-behaviour)) before hardhat-ledger checks it. In the other order, hardhat-ledger rejects every such request on a network with `ledgerAccounts`, as it does when loaded alone. hardhat-viem, hardhat-ethers and Ignition always set `from`, to the first address of `eth_accounts` unless you name another, so the order does not change their sender. The order also sets where the KMS and Ledger accounts appear in `eth_accounts`; see [Other signing plugins](../../contributor/architecture.md#other-signing-plugins).

## Credentials

No secrets live in the Hardhat config. Each provider takes credentials from its SDK's default chain:

- AWS uses the SDK default chain: environment, then SSO/ini/profile, then process, then web identity, then IMDS/ECS.
- GCP uses Application Default Credentials: `gcloud auth application-default login`, `GOOGLE_APPLICATION_CREDENTIALS`, or the service account of the machine or CI job.
- Azure builds the chain below, which follows the order proposed for Foundry's Azure Key Vault signer in [foundry-rs/foundry#17120](https://github.com/foundry-rs/foundry/pull/17120) (service principal, workload identity, `az`/`azd`, managed identity). No Foundry release includes that signer yet. The code is `packages/hardhat-kms-azure/src/internal/credential.ts`.

<!-- docs-check: skip -->

```ts
new ChainedTokenCredential(
  new EnvironmentCredential(),
  new WorkloadIdentityCredential(), // only when its variables are set
  new AzureCliCredential(),
  new AzureDeveloperCliCredential(),
  new ManagedIdentityCredential({ clientId: AZURE_CLIENT_ID, httpClient }), // 3 s per request, 10 s in all
);
```

`AZURE_CLIENT_ID` selects a user-assigned managed identity. The managed identity has 10 s to return a token, after which it counts as unavailable, and each of its HTTP requests times out after 3 s. @azure/identity does not pass an abort signal on to those requests, so the request timeout is what ends one to an endpoint that never answers and lets `hardhat run` exit. Where the managed identity refuses a client id (Azure Cloud Shell, Service Fabric), it is left out of the chain. A source that is not configured is skipped; a configured source that fails, such as a service principal with a wrong secret, stops the chain with its error. All Azure keys of a run share the chain and its tokens, so `az login` users see one `az` call per run, not one per key. See [Set up an Azure Key Vault key](../guides/azure-key-vault-setup.md#3-sign-in).
