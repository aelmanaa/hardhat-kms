---
title: Set up an Azure Key Vault key
description: "Azure Key Vault and Managed HSM setup for Ethereum signing: a P-256K key, get and sign rights only, sign-in, config and audit logs."
---

# Set up an Azure Key Vault key

This guide creates a secp256k1 signing key in Azure Key Vault or Azure Managed HSM, allows a deployer to get and sign with it and nothing else, signs in, adds the key to a Hardhat project and checks that it signs.

You need the `az` CLI.

With `@hardhat-kms/azure`, a connection lists the key's account and signs transactions, messages and typed data with it. `kms history` lists who signed with the key, when and from where, from the Key Vault audit log that a diagnostic setting sends to a Log Analytics workspace; see [Audit logs](#audit-logs).

> [!NOTE]
> Audience: users who sign with a key in Azure Key Vault or Azure Managed HSM.
>
> The plugin's live tests on Sepolia ran against a real vault, with the developer's own identity, not with the roles in [step 2](#2-allow-get-and-sign-and-nothing-else).

## 1. Create a secp256k1 signing key

Ethereum signs with secp256k1, the curve Key Vault calls `P-256K`, so the key must be an elliptic-curve key on it.

Check the vault before you create the key. How long a deleted key stays recoverable is the vault's soft-delete retention, 7 to 90 days, 90 by default, and it "can only be configured during key vault creation" ([Soft-delete behavior](https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview#soft-delete-behavior)). Purge protection is off by default and can be turned on later ([Purge protection](https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview#purge-protection)); "when purge protection is enabled, it cannot be disabled or overridden by anyone including Microsoft" ([Azure Key Vault recovery overview](https://learn.microsoft.com/en-us/azure/key-vault/general/key-vault-recovery)). Read all three:

```sh
az keyvault show --name my-vault \
  --query "{softDelete: properties.enableSoftDelete, retentionDays: properties.softDeleteRetentionInDays, purgeProtection: properties.enablePurgeProtection}"
```

`purgeProtection` prints `null` if purge protection was never turned on, and `true` once it is on; it cannot be turned off again. For a Managed HSM, use `--hsm-name my-hsm`. Give a key that will hold value the full 90 days: if this vault keeps deleted keys for less, create the key in a vault made with `az keyvault create --retention-days 90` instead, and see [Prevent and recover from losing a key](key-loss.md#guard-an-azure-key-vault-key) for purge protection.

Now create the key. Allow it to sign:

```sh
az keyvault key create \
  --vault-name my-vault \
  --name deployer \
  --kty EC \
  --curve P-256K \
  --ops sign verify
```

`--kty EC` keeps the private key in software in a Standard vault. `--kty EC-HSM` keeps it in an HSM and needs a Premium vault. In a Managed HSM, pass `--hsm-name my-hsm` instead of `--vault-name`; its keys are always `EC-HSM`. The plugin accepts both, and refuses any other key type or curve.

Print the key's versioned id, which the config uses:

```sh
az keyvault key show --vault-name my-vault --name deployer --query key.kid --output tsv
# https://my-vault.vault.azure.net/keys/deployer/0123456789abcdef0123456789abcdef
```

Deleting the key loses its address for good, along with any funds it holds, once the vault's soft-delete retention period ends or the key is purged; [Prevent and recover from losing a key](key-loss.md) covers recovering a key, purge protection and retiring a key.

## 2. Allow get and sign, and nothing else

The identity that runs Hardhat needs two permissions on the key: `get`, to read the public key, and `sign`. How you grant them depends on the vault's permission model.

### Vaults that use Azure RBAC

New vaults use Azure role-based access control. No built-in Key Vault role grants only these two permissions, so create a custom role with the two data actions the plugin uses: `Microsoft.KeyVault/vaults/keys/read`, to read the public key, and `Microsoft.KeyVault/vaults/keys/sign/action`, to sign. Save the definition as `key-vault-ethereum-signer.json`:

```json
{
  "Name": "Key Vault Ethereum Signer",
  "IsCustom": true,
  "Description": "Read a key's public part and sign digests with it.",
  "Actions": [],
  "NotActions": [],
  "DataActions": [
    "Microsoft.KeyVault/vaults/keys/read",
    "Microsoft.KeyVault/vaults/keys/sign/action"
  ],
  "NotDataActions": [],
  "AssignableScopes": ["/subscriptions/<subscription id>"]
}
```

Create the role once in the subscription. This needs permission to create custom roles, such as the Owner or User Access Administrator role ([Create or update Azure custom roles using Azure CLI](https://learn.microsoft.com/azure/role-based-access-control/custom-roles-cli)):

```sh
az role definition create --role-definition key-vault-ethereum-signer.json
```

Assign it on the key alone, not on the vault, so the identity can use no other key. If the assignment says the role does not exist right after you created it, wait a few minutes and run it again. A new assignment can take up to 10 minutes to take effect ([Troubleshoot Azure RBAC](https://learn.microsoft.com/azure/role-based-access-control/troubleshooting#symptom---role-assignment-changes-are-not-being-detected)):

```sh
az role assignment create \
  --role "Key Vault Ethereum Signer" \
  --assignee-object-id <principal object id> \
  --assignee-principal-type <User or ServicePrincipal> \
  --scope "$(az keyvault show --name my-vault --query id --output tsv)/keys/deployer"
```

`<principal object id>` is the Microsoft Entra object id of the identity that runs Hardhat. Its principal type is `User` for a person, and `ServicePrincipal` for a service principal or a managed identity. `--assignee-object-id` with `--assignee-principal-type` assigns the role without a Microsoft Graph lookup, which an identity without Graph read access, such as a CI service principal, cannot make. Find the object id with:

```sh
# Your own account, signed in with az login:
az ad signed-in-user show --query id --output tsv
# A service principal, by its application (client) id:
az ad sp show --id <application id> --query id --output tsv
# A user-assigned managed identity:
az identity show --resource-group my-rg --name <identity name> --query principalId --output tsv
```

The Key Vault Ethereum Signer role alone has not yet been checked against real Key Vault: the plugin's live tests ran with an identity that has wider permissions.

If you cannot create a custom role, the built-in role with the fewest permissions that still covers both is **Key Vault Crypto User** (`12338af0-0e69-4776-bea7-57ae8d297424`). Assign it the same way, with `--role "Key Vault Crypto User"`. It also holds seven data actions the plugin does not use: `encrypt`, `decrypt`, `wrap`, `unwrap`, `verify`, `update` and `backup` ([Azure built-in roles](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/security#key-vault-crypto-user)):

- `update` changes the key's attributes, so it can disable the key or change its permitted operations ([`az keyvault key set-attributes`](https://learn.microsoft.com/cli/azure/keyvault/key#az-keyvault-key-set-attributes)).
- `backup` writes a copy of the key that can be restored into another vault in the same subscription and geography. Whoever can restore that copy can sign as the key's address, and disabling or deleting the original does not stop it ([Back up a key](key-loss.md#back-up-a-key)).

Creating the key in step 1 needs a broader role, such as Key Vault Crypto Officer, which the identity that only signs should not have.

### Vaults that use access policies

Older vaults grant access with access policies, which apply to every key in the vault. Microsoft calls them "a legacy authorization system" and recommends Azure RBAC, which is the default for vaults created with Key Vault API version 2026-02-01 or later ([Azure RBAC vs. access policies](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-access-policy)). To move a vault to RBAC, see [Migrate to Azure role-based access control](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-migration). Until then, grant only the two key permissions to the identity's object id, found as in [Vaults that use Azure RBAC](#vaults-that-use-azure-rbac):

```sh
az keyvault set-policy --name my-vault --object-id <principal object id> --key-permissions get sign
```

`az keyvault show --name my-vault --query properties.enableRbacAuthorization` prints `true` for an RBAC vault and `false` (or nothing) for an access-policy vault. A vault whose `enableRbacAuthorization` is unset keeps using access policies.

Key Vault control-plane API versions before 2026-02-01 retire on 2027-02-27. From then on, the `az keyvault` commands that create and configure vaults need Azure CLI 2.90.0 or later, the first version that supports 2026-02-01 ([Plan for Azure RBAC as the default](https://learn.microsoft.com/en-us/azure/key-vault/general/access-control-default)). Signing is not affected: the plugin calls only the vault's data plane.

### Managed HSM

A Managed HSM has its own local RBAC, with its own roles and data actions. Its built-in **Managed HSM Crypto User** role can read and sign, and also create, import, delete, back up and restore keys ([Managed HSM built-in roles](https://learn.microsoft.com/azure/key-vault/managed-hsm/built-in-roles)). Create a local custom role with only the two data actions instead. This needs a local role that can write role definitions, such as Managed HSM Administrator, Managed HSM Crypto Officer or Managed HSM Policy Administrator ([Managed HSM role management](https://learn.microsoft.com/azure/key-vault/managed-hsm/role-management#create-a-new-role-definition)):

```sh
az keyvault role definition create --hsm-name my-hsm --role-definition '{
  "roleName": "Managed HSM Ethereum Signer",
  "description": "Read the public key and sign digests with it.",
  "actions": [],
  "notActions": [],
  "dataActions": [
    "Microsoft.KeyVault/managedHsm/keys/read/action",
    "Microsoft.KeyVault/managedHsm/keys/sign/action"
  ],
  "notDataActions": []
}'
```

Assign it on the key:

```sh
az keyvault role assignment create \
  --hsm-name my-hsm \
  --role "Managed HSM Ethereum Signer" \
  --assignee-object-id <principal object id> \
  --assignee-principal-type <User or ServicePrincipal> \
  --scope /keys/deployer
```

To use the built-in role instead, pass `--role "Managed HSM Crypto User"`. An identity with it can delete the key, or back it up and restore the copy.

## 3. Sign in

hardhat-kms tries these credential sources in order and uses the first that returns a token:

1. A service principal from the environment: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`, or `AZURE_CLIENT_CERTIFICATE_PATH` with `AZURE_CLIENT_CERTIFICATE_PASSWORD` for a protected certificate. `AZURE_CLIENT_SEND_CERTIFICATE_CHAIN=true` sends the certificate chain, and `AZURE_ADDITIONALLY_ALLOWED_TENANTS` allows a vault in a tenant other than `AZURE_TENANT_ID`. This is for a CI system or server that holds the service principal's secret or certificate. Prefer a federated credential, such as workload identity or `azure/login` with OIDC, or a certificate over a secret: Microsoft's [security best practices for app registration](https://learn.microsoft.com/en-us/entra/identity-platform/security-best-practices-for-app-registration) say "use certificate credentials" when a managed identity or another external identity provider is not possible, and "Don't use password credentials, also known as secrets".
2. Workload identity, when `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_FEDERATED_TOKEN_FILE` are set. AKS sets them in a pod that uses workload identity.
3. The Azure CLI (`az login`), then the Azure Developer CLI (`azd auth login`). This is for a laptop, and for GitHub Actions: the `azure/login` action signs the Azure CLI in, with OIDC federation or a secret, and sets no `AZURE_*` variables, so the plugin gets its token from the Azure CLI.
4. A managed identity, user-assigned when `AZURE_CLIENT_ID` is set. This is for code that runs on Azure, such as a virtual machine or a container app. It gets 10 seconds for a token and 3 seconds for each request. In Azure Cloud Shell and Service Fabric, where a user-assigned identity cannot be chosen, it is left out when `AZURE_CLIENT_ID` is set.

This is the order proposed for Foundry's Azure Key Vault signer in [foundry-rs/foundry#17120](https://github.com/foundry-rs/foundry/pull/17120), which no Foundry release includes yet. The developer tools come before the managed identity, so a local `az login` works without waiting for the managed identity endpoint, which outside Azure may never answer. A source that is not configured is skipped; a source that is configured but fails, such as a service principal with a wrong secret, stops the search with its error.

Every Azure key of a run signs as the identity this chain finds; [Credentials](../reference/credentials.md#azure) lists the variables that turn each source on, and [Cloud credentials for KMS signing](../explanation/cloud-access.md) shows which source a laptop, a CI job and a server use.

On a laptop, `az login` is enough. In GitHub Actions, run `azure/login` with OIDC federation rather than a client secret.

A service principal in the environment takes precedence over every other source. With `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` (or `AZURE_CLIENT_CERTIFICATE_PATH`) set, the plugin signs in as that service principal even after `az login` or `azure/login`. Unset `AZURE_CLIENT_SECRET` or `AZURE_CLIENT_CERTIFICATE_PATH` to use another source.

The plugin does not sign in with a username and password, since that sign-in cannot do multifactor authentication. With `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_USERNAME` and `AZURE_PASSWORD` set and no secret or certificate, it fails with an error that names the variables. Sign in with a service principal, `az login`, workload identity or a managed identity instead.

When you sign in as a user, commands that create, change or delete Azure resources need a sign-in that completed multifactor authentication (MFA). In Azure's public cloud, this applies to every such request to Azure Resource Manager, from the Azure CLI, Azure PowerShell, the SDKs or the REST API. Enforcement began on 2025-10-01, and a tenant could postpone it to 2026-07-01 at the latest. Reads are exempt, and so are workload identities such as service principals and managed identities ([Mandatory Microsoft Entra MFA](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-mandatory-multifactor-authentication)). On this page, they include `az keyvault create`, `az role definition create`, `az role assignment create`, `az keyvault set-policy`, `az monitor log-analytics workspace create` and `az monitor diagnostic-settings create`. Signing and `kms history` are not: the plugin calls the vault and Log Analytics, not Azure Resource Manager.

## 4. Install the plugin and configure the key

::: code-group

```sh [npm]
npm install --save-dev hardhat-kms @hardhat-kms/azure
```

```sh [pnpm]
pnpm add --save-dev hardhat-kms @hardhat-kms/azure
```

```sh [Yarn]
yarn add --dev hardhat-kms @hardhat-kms/azure
```

:::

pnpm 11 and later need an `allowBuilds` entry, and Yarn 4 needs `nodeLinker: node-modules`: [Install hardhat-kms](install-before-release.md) gives the settings for each package manager.

`@hardhat-kms/azure` brings the Azure SDK (`@azure/keyvault-keys` and `@azure/identity`) with it, so there is nothing else to install. Add it to `plugins`; it loads `hardhat-kms` itself:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAzure from "@hardhat-kms/azure";

export default defineConfig({
  plugins: [hardhatKmsAzure],
  kms: {
    keys: {
      deployer: {
        provider: "azure",
        keyId: "https://my-vault.vault.azure.net/keys/deployer/0123456789abcdef0123456789abcdef",
        // Optional, recommended: run `npx hardhat kms accounts` and replace the next line with
        // the `address` line it prints for this key. The plugin then refuses to sign if the key
        // derives to another address.
        // address: "0x…",
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

`keyId` can also leave out the version, or the key can be given as `vaultUrl`, `keyName` and an optional `keyVersion`; the [configuration reference](../reference/configuration.md#key-forms-per-provider) lists the forms and the accepted hosts. Prefer the versioned id: without a version, the plugin uses the version that is current when it first reads the key, so rotating the key changes the address on the next run.

To pin the key's address, run `npx hardhat kms accounts`. For a key without a pin it prints an `address` line; paste it into the key in place of the commented-out line ([`kms accounts`](../reference/tasks.md#kms-accounts)).

To use a key without a config entry, set `AZURE_KEY_VAULT_KEY_ID` (or `AZURE_KEY_VAULT_KEY_IDS` for several) and pass `--kms azure`; see [Migrate from Foundry](migrate-from-foundry.md). Such keys are added to the network selected with `--network`, or to `default` without one.

`configVariable("SEPOLIA_RPC_URL")` reads the RPC URL when a network needs it: from an environment variable of that name (`export SEPOLIA_RPC_URL=https://…`), or from the Hardhat keystore (`npx hardhat keystore set SEPOLIA_RPC_URL`) when the config loads the keystore plugin. The config above does not: add `import hardhatKeystore from "@nomicfoundation/hardhat-keystore";` and put `hardhatKeystore` in `plugins`, or load a Hardhat toolbox, which includes it. The script in step 5 uses it.

## 5. Check that the key signs

Save this script as `scripts/check-kms.ts`. It lists the accounts on `sepolia`, then signs the message `hello` with the last one, which is the KMS account:

```ts
import { network } from "hardhat";

const { provider } = await network.create("sepolia");
const accounts = await provider.request({ method: "eth_accounts" });
const address: unknown = Array.isArray(accounts) ? accounts.at(-1) : undefined;
if (typeof address !== "string") {
  throw new Error("no accounts");
}
const signature = await provider.request({
  method: "personal_sign",
  params: ["0x68656c6c6f", address],
});
console.log(address, signature);
```

Run it with `npx hardhat run scripts/check-kms.ts`. Each run reads the key once, before the first signature, then signs once for the signature, or more if a request is retried ([How many sign requests one call can send](../explanation/security-model.md#how-many-sign-requests-one-call-can-send)). An `address` pin does not save the read: the plugin checks the public key against the pin before it releases a signature, and it pins the key's version from the read. A pin saves the read only where the plugin needs just the address, such as listing accounts with `eth_accounts`; the first signature and the `kms` tasks still read the key ([`address`](../reference/configuration.md#configuration)).

## How the plugin uses the key

- It reads the key once and checks that it is an `EC` or `EC-HSM` key on `P-256K`, that it is enabled and within its activation and expiry dates, and that its permitted operations include `sign`.
- It pins the version from that read. An unversioned key id is resolved to the current version once, and every signature in the run uses that version.
- It signs the 32-byte digest with `ES256K` against the versioned key id. Key Vault signs the digest as given and returns 64 bytes, `r || s`.
- It checks that the `kid` of each response names the configured vault and key, and that the `kid` of each sign response names the pinned version. It refuses the key or the signature otherwise.
- It normalizes each signature to low-S, recovers the parity and verifies it against the public key before using it; see the [security model](../explanation/security-model.md#every-signature-is-verified).
- It puts `hardhat-kms/<version>` at the start of the user agent of every request, so the `ClientInfo` column of the `AZKVAuditLogs` table starts with `hardhat-kms/1.0.0` (with your installed version) when a diagnostic setting sends audit events to a workspace. The client reports this tag and anyone can send the same string, so it marks the plugin's calls but proves nothing.

## Audit logs

Key Vault records each sign request in its audit log, whoever makes it, as a `KeySign` event. [`kms history`](../reference/tasks.md#kms-history) lists them for one key:

::: code-group

```sh [npm]
npx hardhat kms history deployer --since 7d
```

```sh [pnpm]
pnpm hardhat kms history deployer --since 7d
```

```sh [Yarn]
yarn hardhat kms history deployer --since 7d
```

:::

Without `--since`, the task reads the last 24 hours, and it lists at most 100 events, the newest; `--limit` takes up to 1000 ([`kms history`](../reference/tasks.md#kms-history)).

Key Vault keeps no audit log you can query by itself. A diagnostic setting on the vault sends the `AuditEvent` category to a Log Analytics workspace, and the task reads the `AZKVAuditLogs` table there. Nothing is logged before the setting exists.

### Send the audit log to a workspace

Create a workspace, or reuse one, then add a diagnostic setting on the vault with the resource-specific destination:

```sh
az monitor log-analytics workspace create \
  --resource-group my-rg \
  --workspace-name kms-audit \
  --location eastus

az monitor diagnostic-settings create \
  --name hardhat-kms-audit \
  --resource "$(az keyvault show --name my-vault --query id -o tsv)" \
  --workspace "$(az monitor log-analytics workspace show --resource-group my-rg --workspace-name kms-audit --query id -o tsv)" \
  --export-to-resource-specific true \
  --logs '[{"category":"AuditEvent","enabled":true}]'
```

`--export-to-resource-specific true` matters: without it, the events go to the older `AzureDiagnostics` table, which the task does not read, and the task fails with `azure.history.no-table`. The table appears in the workspace with the first event.

Creating the setting needs `Microsoft.Insights/diagnosticSettings/write` on the vault, which the Monitoring Contributor role grants, for example. Keep `AZKVAuditLogs` on the Analytics table plan: the task's query API cannot read a table on the Basic or Auxiliary plan.

Then give the plugin the workspace id, the GUID that `az monitor log-analytics workspace show --resource-group my-rg --workspace-name kms-audit --query customerId -o tsv` prints. It is not the workspace's resource id or name:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAzure from "@hardhat-kms/azure";

export default defineConfig({
  plugins: [hardhatKmsAzure],
  kms: {
    keys: { deployer: { provider: "azure", keyId: configVariable("DEPLOYER_KEY_ID") } },
    audit: { azure: { workspaceId: configVariable("KMS_AUDIT_WORKSPACE_ID") } },
  },
});
```

A literal GUID works too. Without `kms.audit.azure.workspaceId`, `kms history` fails on Azure keys with `azure.history.no-workspace`; signing does not need it.

### The read permission

The identity that runs `kms history` uses the same credential chain as signing ([step 3](#3-sign-in)) and needs to query the workspace and read the `AZKVAuditLogs` table: `Microsoft.OperationalInsights/workspaces/query/read` and table read access. The **Log Analytics Data Reader** role on the workspace grants both:

```sh
az role assignment create \
  --role "Log Analytics Data Reader" \
  --assignee-object-id <principal object id> \
  --assignee-principal-type <User or ServicePrincipal> \
  --scope "$(az monitor log-analytics workspace show --resource-group my-rg --workspace-name kms-audit --query id -o tsv)"
```

It lets the identity read every table of the workspace, so a workspace that holds only Key Vault audit events keeps that access narrow. A refused read fails with the permissions to grant. An identity whose access is limited to other tables of the workspace may get no rows from this one, or the `azure.history.no-table` error; we have not checked which. Neither is proof that the key signed nothing.

### How it reads

The task sends one Log Analytics query to `api.loganalytics.azure.com`, in Azure's public cloud. It reads the `KeySign` rows whose key URL (`Id`, or `RequestUri` when `Id` is empty) has the key's vault host and key name, without regard to case, for any version of the key, in the range. It sorts them newest first and keeps one more than `--limit`. The query is built only from the checked vault host and key name and the two times, so no configuration value can change it. The host and name go in obfuscated string literals (`h"…"`), so the workspace's own query log, `LAQueryLogs`, does not record them. The server ends the query within 100 seconds (`Prefer: wait=100`). Log Analytics allows 200 queries per 30 seconds per user; a throttled query is retried twice, honouring `Retry-After`, before the task reports it. A firewall or proxy must let the task reach `api.loganalytics.azure.com`.

Vaults in Azure China or Azure Government use other Log Analytics endpoints and are not supported yet. Managed HSM keys are not supported yet either. The task fails with an error for both rather than show an empty history.

### What Key Vault logs, and what it does not

Each row comes from one `AZKVAuditLogs` row:

| Column or field            | `AZKVAuditLogs` column                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `time`                     | `TimeGenerated`, to the 100 nanoseconds; shown to the millisecond                                                                                                                                                                                                                                                                                                                                                                                                                |
| `principal`                | from the token claims in `Identity`: `upn`, else `unique_name`, else, for an application, `appid`, else the object id `oid`. A token is an application's when its `idtyp` is `app`, or when it has neither `idtyp` nor `scp`. For a user, `appid` names the client application, such as the Azure CLI, so it is never shown as the principal. For an application, or a user with no name claim, the principal is a GUID (`appid` or `oid`), shown as logged like every principal |
| `sourceIp`                 | `CallerIpAddress`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `userAgent`                | `ClientInfo`; the plugin's calls start with `hardhat-kms/<version>`                                                                                                                                                                                                                                                                                                                                                                                                              |
| `requestId`                | `CorrelationId`: the `x-ms-request-id` that Key Vault returned to the caller, not the client's `x-ms-client-request-id`                                                                                                                                                                                                                                                                                                                                                          |
| `keyVersion`               | the version segment of `Id`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `error`                    | for a request whose `HttpStatusCode` is not 2xx: `ResultSignature`, such as `Bad Request`, and `ResultDescription` with `--show-ids`. Key Vault logs a refused sign request with `ResultType` `Success`, so the status decides                                                                                                                                                                                                                                                   |
| `keyResource`              | `Id`, the versioned key URL, shown with `--show-ids`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `extra`                    | `ResultType`, `ResultSignature`, `HttpStatusCode`, `Algorithm` (`ES256K`), `DurationMs`, `OperationVersion` (the API version), the token's `idtyp`, `IsRbacAuthorized`, `IsAccessPolicyMatch` and the TLS version, when logged                                                                                                                                                                                                                                                   |
| `extra`, with `--show-ids` | the `oid` and `appid` claims that are not the principal, `AppliedAssignmentId` (the role assignment that allowed the call) and `SubnetId`                                                                                                                                                                                                                                                                                                                                        |

Key Vault never logs the digest, the message, the transaction or the signature, so the task cannot tell which signature an event made.

### Delay, retention and cost

- **Delay.** Key Vault documents that events reach the workspace at most 10 minutes after the request. Log Analytics ingestion can add to that. In our tests on 2026-10-02, `KeySign` rows took 2.7 minutes on average and at most about 9.2 minutes from `TimeGenerated` to being queryable, and did not always arrive in order. A history that ends in the last 15 minutes says that recent events may be missing.
- **Retention.** The workspace keeps rows for its retention period, 30 days by default and up to 730. The task cannot know it, so a range that starts earlier just shows what is left.
- **Cost.** Log Analytics bills ingestion beyond the free allowance of its pricing tier. A `KeySign` row is about 1.9 KB, so a thousand signatures add about 2 MB. The setting also sends the vault's other events, such as `KeyGet` and `Authentication`. Remove the diagnostic setting to stop.

### A key deleted and created again

Key Vault names a key by its vault and name. If a key is deleted (and purged) and a new key is created under the same name, the new key's history and the old one's are one: the task matches by vault host and key name, so it lists the old key's `KeySign` rows too. Their key version tells them apart, since a new key starts with new versions: check the version of each row when that matters.

### Several settings and workspaces

A vault can have up to five diagnostic settings, each sending to its own workspace, storage account or event hub. The task reads only the workspace in `kms.audit.azure.workspaceId`, so it never claims to see every sign request on the key. An empty history gets the `logging-not-confirmed` note with what to check.

## Errors

Each message starts with the provider, the operation and the key, for example `azure, sign, key azure:https://my-vault.vault.azure.net/keys/deployer: Key Vault answered 403 Forbidden: …`. The table lists the part after the colon.

| Error                                                                      | Cause and fix                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Azure Key Vault keys need the @hardhat-kms/azure plugin`                  | Run `npm install --save-dev @hardhat-kms/azure` in the Hardhat project, and add `hardhatKmsAzure` to `plugins` in the config.                                                                                                                                                                                                                                |
| `@hardhat-kms/azure … needs hardhat-kms …, but hardhat-kms … is installed` | The two packages are released together and must be the same version. Run the install command the error prints.                                                                                                                                                                                                                                               |
| `no Azure credential returned a token (AggregateAuthenticationError)`      | No credential source in [step 3](#3-sign-in) is configured. Run `az login`, or set the variables of a service principal or workload identity.                                                                                                                                                                                                                |
| `AZURE_TENANT_ID is not a tenant id`                                       | The variable holds a character other than a letter, a digit, `-` or `.`. Set it to the tenant id that `az account show --query tenantId -o tsv` prints, or unset it.                                                                                                                                                                                         |
| `… which selects username and password sign-in`                            | The environment selects username and password sign-in, which the plugin refuses. Unset `AZURE_USERNAME` and `AZURE_PASSWORD`, or set `AZURE_CLIENT_SECRET` or `AZURE_CLIENT_CERTIFICATE_PATH`.                                                                                                                                                               |
| `a configured Azure credential could not sign in (AuthenticationError)`    | A source in [step 3](#3-sign-in) is configured but its sign-in failed, for example a wrong or expired `AZURE_CLIENT_SECRET`, or a wrong `AZURE_TENANT_ID`. Fix its settings, or unset the variables of a source you do not mean to use; the chain does not fall through to `az login` after this.                                                            |
| `Key Vault answered 401 …: the credential was not accepted`                | The token is for another tenant, or has expired. Run `az login` again, or check `AZURE_TENANT_ID`.                                                                                                                                                                                                                                                           |
| `Key Vault answered 403 …: the identity may not use this key`              | The identity lacks `get` or `sign` on the key ([step 2](#2-allow-get-and-sign-and-nothing-else)), the role assignment has not taken effect yet (it can take a few minutes), the key is disabled, or the vault firewall blocks the network.                                                                                                                   |
| `Key Vault answered 404 …: the key or key version does not exist`          | The vault has no key with this name or version. Check `keyId`; a deleted key must be recovered first.                                                                                                                                                                                                                                                        |
| `Key Vault could not be reached`                                           | The request did not get an answer: check the vault URL, DNS, the network and any proxy.                                                                                                                                                                                                                                                                      |
| `the key type is …, not EC or EC-HSM` or `the key curve is …, not P-256K`  | The key is not a secp256k1 key. A key's type and curve cannot be changed, so create a new key as in step 1.                                                                                                                                                                                                                                                  |
| `the key version is disabled`                                              | Enable it with `az keyvault key set-attributes --vault-name my-vault --name deployer --version <version> --enabled true`.                                                                                                                                                                                                                                    |
| `the key version is not valid before …` or `the key version expired at …`  | The key's activation or expiry date excludes now. The plugin checks the dates when it reads the key and again before each signature, so a key that expires during a run fails here too. Change it with `az keyvault key set-attributes --vault-name my-vault --name deployer --version <version>` and `--not-before` or `--expires`, or use another version. |
| `the key's permitted operations do not include sign`                       | The key was created without `sign` in `--ops`. Add it with `az keyvault key set-attributes --vault-name my-vault --name deployer --version <version> --ops sign verify`.                                                                                                                                                                                     |
| `the key derives to 0x…, but the configured address is 0x…`                | The key id names another key or version than the one the pin was taken from, or the pin is wrong. Nothing was signed. Find out why before you change the pin; see [When the pin fails](key-rotation.md#when-the-pin-fails).                                                                                                                                  |
| `no answer within … ms`                                                    | Key Vault did not answer in time. Check the network, or raise `timeoutMs`.                                                                                                                                                                                                                                                                                   |
| `kms.audit.azure.workspaceId is not set`                                   | `kms history` needs the workspace that the vault's diagnostic setting sends to. See [Audit logs](#send-the-audit-log-to-a-workspace).                                                                                                                                                                                                                        |
| `the Log Analytics workspace has no AZKVAuditLogs table`                   | No diagnostic setting sends Key Vault audit events to this workspace in resource-specific mode. Add one with `--export-to-resource-specific true`, or check the workspace id.                                                                                                                                                                                |
| `cannot read the audit log: the credentials lack Microsoft.Operational…`   | The identity may not query the workspace. Assign **Log Analytics Data Reader** on it, as in [The read permission](#the-read-permission).                                                                                                                                                                                                                     |

Errors show the HTTP status and Key Vault's error code, never the service's message, which names the vault, the key and the caller. Run with `DEBUG=hardhat:kms:*` to see each call; see [Debug output](debug-output.md). The table lists the most common errors; the [errors reference](../reference/errors.md#hardhat-kmsazure) lists every one, with its id, cause and fix, and the [core plugin's errors](../reference/errors.md#hardhat-kms) too.
