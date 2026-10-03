# Configuration reference

Audience: Users configuring the plugin.

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

Keys can also come from Foundry's environment variables with `--kms aws`, `--kms gcp`, `--kms azure` or a comma-separated list, without a config entry. Foundry has not released an Azure signer: the `azure` variable names follow the proposal in [foundry-rs/foundry#17120](https://github.com/foundry-rs/foundry/pull/17120) and may change before it ships. These keys inherit `kms.defaults` and pass the same checks as config keys. They are added to the selected network only (the `--network` value, or `default` without one), after the network's `kmsAccounts`. A command-line key that names the same KMS key as a config key on that network is an error that names both, without the value. See [Migrate from Foundry](../guides/migrate-from-foundry.md#from-the-command-line-as-in-foundry).

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

Third-party providers extend the config types through the declaration-merged `KmsProviderUserConfigs` interface (optional, for provider authors: [Provider contract](../../contributor/providers.md#provider-contract) in the contributor docs).

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

In this order, hardhat-kms gives a raw `eth_sendTransaction` request without `from` its default sender ([RPC methods](rpc-methods.md#rpc-behaviour)) before hardhat-ledger checks it. In the other order, hardhat-ledger rejects every such request on a network with `ledgerAccounts`, as it does when loaded alone. hardhat-viem, hardhat-ethers and Ignition always set `from`, to the first address of `eth_accounts` unless you name another, so the order does not change their sender. The order also sets `eth_accounts`: with hardhat-ledger first, the network's own accounts come first, then the Ledger addresses, then the KMS addresses. In the other order the KMS addresses come before the Ledger ones, and `eth_requestAccounts` leaves the Ledger addresses out. Code that picks an account by index, such as Ignition's `m.getAccount(index)`, sees the difference.

## Credentials

No secrets live in the Hardhat config. The plugin passes no credentials to the cloud SDKs, so each SDK walks its own chain of sources and uses the first one that is configured. The lists below give that order.

### AWS

1. Access keys in the environment: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, with `AWS_SESSION_TOKEN` for temporary keys. Skipped whenever a profile is set; see below.
2. The profile in `~/.aws/config` and `~/.aws/credentials` named by the key's `profile`, else by `AWS_PROFILE`, else `default`. A profile can hold access keys, an SSO session (`aws sso login`), a role to assume, a `credential_process` command or a web identity token file.
3. A web identity token: `AWS_WEB_IDENTITY_TOKEN_FILE` with `AWS_ROLE_ARN`, as EKS sets for IAM roles for service accounts.
4. Container credentials when `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` or `AWS_CONTAINER_CREDENTIALS_FULL_URI` is set (an ECS task role, EKS Pod Identity). Otherwise the EC2 instance role, unless `AWS_EC2_METADATA_DISABLED` is set.

**A profile skips the environment keys.** When a key sets `profile`, or `AWS_PROFILE` is set, the AWS SDK for JavaScript ignores `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` and prints a warning if they are set. A CI job that exports keys, as `aws-actions/configure-aws-credentials` does, then looks for the profile instead. It finds none and fails, or signs as whatever identity a later source returns, such as the runner's instance role. Keep `profile` out of a config that CI runs, and set `AWS_PROFILE` on the laptop instead. Foundry differs here: the AWS SDK for Rust uses the environment keys even when `AWS_PROFILE` is set.

**An alias or a bare key id names a key in the credentials' own account and in the key's region.** The AWS KMS API reaches another account's key only through a key ARN or an alias ARN. Other credentials, or another region, can therefore find a different key under the same alias, and sign with it. An [`address` pin](#configuration) catches this: the plugin refuses to sign when the key derives to another address. A key ARN fixes both the account and the region.

Each AWS key can set its own `profile`, so the keys of one run can sign with different credentials. `--kms aws` keys have no `profile` of their own and follow `AWS_PROFILE`.

### Google Cloud

Application Default Credentials (ADC):

1. The JSON file named by `GOOGLE_APPLICATION_CREDENTIALS`: a service account key, or a workload identity federation config (`external_account`) such as the one `google-github-actions/auth` writes.
2. `application_default_credentials.json`, which `gcloud auth application-default login` writes, in the directory named by `CLOUDSDK_CONFIG`, else `~/.config/gcloud` (`%APPDATA%\gcloud` on Windows). Signing in with `--impersonate-service-account` makes it an impersonated service account.
3. The metadata server, on Google Cloud: the service account attached to the VM, GKE workload or Cloud Run service.

Either file can hold a service account key, a user, an impersonated service account or an `external_account` config. `GOOGLE_CLOUD_QUOTA_PROJECT` sets the quota project. The plugin does not use the account of `gcloud auth login`, nor gcloud settings such as `auth/impersonate_service_account`.

### Azure

The plugin builds its own chain rather than `DefaultAzureCredential`, in the order proposed for Foundry's Azure Key Vault signer in [foundry-rs/foundry#17120](https://github.com/foundry-rs/foundry/pull/17120). No Foundry release includes that signer yet. The code is `packages/hardhat-kms-azure/src/internal/credential.ts`.

1. `EnvironmentCredential`, when `AZURE_TENANT_ID` and `AZURE_CLIENT_ID` are set with one of: `AZURE_CLIENT_SECRET` for a service principal secret; `AZURE_CLIENT_CERTIFICATE_PATH`, with `AZURE_CLIENT_CERTIFICATE_PASSWORD` for a protected certificate; or `AZURE_USERNAME` and `AZURE_PASSWORD` for a user. The first complete set in that order wins.
2. `WorkloadIdentityCredential`, when `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_FEDERATED_TOKEN_FILE` are set, as AKS sets them for workload identity.
3. `AzureCliCredential` (`az login`, or the `azure/login` action in GitHub Actions), then `AzureDeveloperCliCredential` (`azd auth login`).
4. `ManagedIdentityCredential`, user-assigned when `AZURE_CLIENT_ID` is set.

`AZURE_CLIENT_ID` selects a user-assigned managed identity. The managed identity has 10 s to return a token, after which it counts as unavailable, and each of its HTTP requests times out after 3 s. @azure/identity does not pass an abort signal on to those requests, so the request timeout is what ends one to an endpoint that never answers and lets `hardhat run` exit. Where the managed identity refuses a client id (Azure Cloud Shell, Service Fabric), it is left out of the chain. A source that is not configured is skipped; a configured source that fails, such as a service principal with a wrong secret, stops the chain with its error. All Azure keys of a run share the chain and its tokens, so `az login` users see one `az` call per run, not one per key. See [Set up an Azure Key Vault key](../guides/azure-key-vault-setup.md#3-sign-in).

### One identity per run on Google Cloud and Azure

Only AWS keys can choose their credentials, with `profile`. No config field selects a credential on Google Cloud or Azure: every Google Cloud key of a run signs as the ADC identity, and every Azure key as the first source in the Azure chain that returns a token. `kms history` reads with the same identity. To sign as two identities, run Hardhat twice with different environments.
