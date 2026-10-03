import type { ErrorEntry } from "hardhat-kms/provider-utils";

/*
 * Every error @hardhat-kms/azure builds, with its cause and fix. Build errors only from these
 * entries, with catalogError, catalogMessage or internalError from hardhat-kms/provider-utils;
 * `pnpm run docs:check` fails on a throw that bypasses them. `pnpm run docs:errors` writes
 * docs/user/reference/errors.md from this file.
 */

/** The @hardhat-kms/azure error catalogue. */
export const ERRORS = {
  noCredential: {
    id: "azure.credential.none",
    kind: "error",
    group: "Credentials",
    template:
      "no Azure credential returned a token ({errorName}). Run `az login`, or set AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET for a service principal",
    cause:
      "No credential source of the chain is configured: no service principal, workload identity, managed identity or `az login`.",
    fix: "Run `az login`, or set the variables of a service principal or workload identity, as the setup guide describes.",
  },
  credentialFailed: {
    id: "azure.credential.failed",
    kind: "error",
    group: "Credentials",
    template:
      "a configured Azure credential could not sign in ({errorName}). Check the service principal (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET), the workload identity or the managed identity; unset the variables of a source you do not mean to use",
    cause:
      "A credential source is configured but its sign-in failed, for example a wrong or expired `AZURE_CLIENT_SECRET` or a wrong `AZURE_TENANT_ID`. The chain does not fall through to `az login` after this.",
    fix: "Fix that source's settings, or unset the variables of a source you do not mean to use.",
  },
  aborted: {
    id: "azure.credential.aborted",
    kind: "reason",
    group: "Credentials",
    template: "The operation was aborted.",
    cause:
      "A token request was abandoned when the call's time ran out. The error is named `AbortError`, as the Azure SDK names its own; the plugin reports the call as `no answer within … ms`.",
    fix: "See `core.signer.no-answer`.",
  },
  managedIdentityTimeout: {
    id: "azure.credential.managed-identity-timeout",
    kind: "reason",
    group: "Credentials",
    template: "ManagedIdentityCredential: no token within {seconds} s",
    cause:
      "The managed identity endpoint gave no token in time, which happens outside Azure when the endpoint accepts a connection and never answers. The managed identity is the last source of the credential chain, so the chain then fails, and the plugin reports `azure.credential.none` with the chain's class name. This text is the message of that source's `CredentialUnavailableError`.",
    fix: "Outside Azure, sign in with `az login` or a service principal. On Azure, check that the managed identity is assigned to the resource.",
  },
  unreachable: {
    id: "azure.service.unreachable",
    kind: "error",
    group: "Key Vault answers",
    template: "Key Vault could not be reached. Check the vault URL, the network and any proxy",
    cause: "The request got no HTTP answer.",
    fix: "Check the vault URL, DNS, the network and any proxy.",
  },
  unreachableCode: {
    id: "azure.service.unreachable-code",
    kind: "error",
    group: "Key Vault answers",
    template:
      "Key Vault could not be reached ({code}). Check the vault URL, the network and any proxy",
    cause: "The request got no HTTP answer. The code says why, for example `ENOTFOUND` for DNS.",
    fix: "Check the vault URL, DNS, the network and any proxy.",
  },
  unauthorized: {
    id: "azure.service.401",
    kind: "error",
    group: "Key Vault answers",
    template: "Key Vault answered {status}: the credential was not accepted",
    cause: "The token is for another tenant, or has expired.",
    fix: "Run `az login` again, or check `AZURE_TENANT_ID`.",
  },
  forbidden: {
    id: "azure.service.403",
    kind: "error",
    group: "Key Vault answers",
    template:
      "Key Vault answered {status}: the identity may not use this key. It needs the keys/get and keys/sign permissions: the Key Vault Crypto User role on an RBAC vault, or the Get and Sign key permissions in an access policy. A disabled key or a firewall rule also gives 403",
    cause:
      "The identity lacks `get` or `sign` on the key, the role assignment has not taken effect yet (it can take a few minutes), the key is disabled, or the vault firewall blocks the network.",
    fix: "Grant the role or the access policy the message names, wait a few minutes, and check the key and the vault's network rules.",
  },
  notFound: {
    id: "azure.service.404",
    kind: "error",
    group: "Key Vault answers",
    template:
      "Key Vault answered {status}: the key or key version does not exist in this vault. Check the key id",
    cause: "The vault has no key with this name or version.",
    fix: "Check `keyId`, or `keyName` and `keyVersion`. A deleted key must be recovered first.",
  },
  answered: {
    id: "azure.service.other",
    kind: "error",
    group: "Key Vault answers",
    template: "Key Vault answered {status}",
    cause:
      "Key Vault answered with another HTTP status. Only the status and Key Vault's error code are shown, since the service's message names the vault, the key and the caller.",
    fix: "Look the status and code up in the Key Vault documentation, and run with `DEBUG=hardhat:kms:*` to see the call.",
  },
  responseVersion: {
    id: "azure.response.key-version",
    kind: "error",
    group: "Responses",
    template: "the response is for another key version",
    cause: "Key Vault returned another version than the one configured or pinned.",
    fix: "Check that `keyId` names the version you mean.",
  },
  noPublicKey: {
    id: "azure.response.no-public-key",
    kind: "error",
    group: "Responses",
    template: "the response has no public key",
    cause: "The key read from Key Vault has no JSON Web Key.",
    fix: "Run again; if it repeats, report it.",
  },
  noVersionedId: {
    id: "azure.response.no-versioned-id",
    kind: "error",
    group: "Responses",
    template: "the response has no versioned key id",
    cause:
      "A Key Vault answer has no key id with a version, which the adapter needs to pin the version.",
    fix: "Run again; if it repeats, report it.",
  },
  responseKey: {
    id: "azure.response.key",
    kind: "error",
    group: "Responses",
    template: "the response is for another key than the one requested",
    cause: "A Key Vault answer names another key than the configured one. It is refused.",
    fix: "Check the vault URL and any proxy; if it repeats, report it.",
  },
  noSignature: {
    id: "azure.response.no-signature",
    kind: "error",
    group: "Responses",
    template: "the response has no signature",
    cause: "The sign answer has no signature.",
    fix: "Run again; if it repeats, report it.",
  },
  keyType: {
    id: "azure.key.type",
    kind: "error",
    group: "Keys",
    template: "the key type is {keyType}, not EC or EC-HSM. Create an EC key on the P-256K curve",
    cause: "The key is not an elliptic-curve key, for example an RSA key.",
    fix: "A key's type cannot be changed. Create a new key with `--kty EC --curve P-256K`, as in the setup guide.",
  },
  keyCurve: {
    id: "azure.key.curve",
    kind: "error",
    group: "Keys",
    template:
      "the key curve is {curve}, not P-256K (secp256k1). Create the key with --kty EC --curve P-256K",
    cause: "The key is an EC key on another curve, such as P-256.",
    fix: "A key's curve cannot be changed. Create a new key with the command the message gives.",
  },
  disabled: {
    id: "azure.key.disabled",
    kind: "error",
    group: "Keys",
    template:
      "the key version is disabled. Enable it with `az keyvault key set-attributes --enabled true`",
    cause: "The key version is disabled.",
    fix: "Enable it with `az keyvault key set-attributes` and `--enabled true`, giving the vault, the key and the version.",
  },
  notYetValid: {
    id: "azure.key.not-yet-valid",
    kind: "error",
    group: "Keys",
    template: "the key version is not valid before {date}",
    cause: "The key's activation date is in the future.",
    fix: "Change it with `az keyvault key set-attributes --not-before`, or use another version.",
  },
  expired: {
    id: "azure.key.expired",
    kind: "error",
    group: "Keys",
    template: "the key version expired at {date}",
    cause:
      "The key's expiry date has passed. The plugin checks it when it reads the key and again before each signature.",
    fix: "Change it with `az keyvault key set-attributes --expires`, or use another version.",
  },
  noSignOperation: {
    id: "azure.key.no-sign-operation",
    kind: "error",
    group: "Keys",
    template:
      "the key's permitted operations do not include sign. Set them with `az keyvault key set-attributes --ops sign verify`",
    cause: "The key was created without `sign` in `--ops`.",
    fix: "Add it with `az keyvault key set-attributes --ops sign verify`.",
  },
  lookupUnfinished: {
    id: "azure.sign.lookup-unfinished",
    kind: "error",
    group: "Signing",
    template: "the key lookup did not finish, so there is no key version to sign with",
    cause:
      "The key read that pins the version was abandoned when its time ran out. The adapter never signs without a pinned version.",
    fix: "Run again. If it repeats, check the network, or raise `timeoutMs`.",
  },
  signatureVersion: {
    id: "azure.sign.signature-version",
    kind: "error",
    group: "Signing",
    template: "the signature is from another key version than the pinned one",
    cause:
      "The sign answer's `kid` names another version than the pinned one. The signature is refused.",
    fix: "Report it if it happens against Key Vault itself.",
  },
  notKeyUrl: {
    id: "azure.key.not-key-url",
    kind: "error",
    group: "Keys",
    template: "the key id is not an Azure Key Vault key URL",
    cause:
      "The key id is not a Key Vault key URL. The config checks refuse such values first, so this is a guard.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  historyNoWorkspace: {
    id: "azure.history.no-workspace",
    kind: "error",
    group: "History",
    template:
      "`kms history` reads Azure Key Vault's audit log from a Log Analytics workspace, and kms.audit.azure.workspaceId is not set. Set it to the workspace id (a GUID) that the vault's diagnostic setting sends AuditEvent logs to",
    cause:
      "Key Vault keeps no audit log of its own: a diagnostic setting on the vault sends it to a Log Analytics workspace, and the plugin needs to know which one.",
    fix: 'Set `kms.audit.azure.workspaceId` to the workspace id, as the Azure setup guide\'s "Audit logs" section describes. `az monitor log-analytics workspace show --query customerId` prints it.',
  },
  historyWorkspaceId: {
    id: "azure.history.workspace-id",
    kind: "error",
    group: "History",
    template: "kms.audit.azure.workspaceId is not a GUID, so no Log Analytics query is sent to it",
    cause:
      "The reader puts the workspace id in the query URL, so it accepts a GUID only. The config check refuses other values first, so this means a value reached the reader without it.",
    fix: "Set `kms.audit.azure.workspaceId` to the workspace id (`customerId`), not its name or resource id.",
  },
  historyKeyId: {
    id: "azure.history.key-id",
    kind: "error",
    group: "History",
    template:
      "the key id is not a Key Vault key URL with a host of letters, digits, . and - and a key name of letters, digits and -, so no Log Analytics query is built from it",
    cause:
      "`kms history` builds its query only from the checked host and key name of the key URL, so that no part can change the query. The config check refuses other values first, so this means a key reached the reader without it.",
    fix: "Check `keyId`, or `vaultUrl` and `keyName`.",
  },
  historyManagedHsm: {
    id: "azure.history.managed-hsm",
    kind: "error",
    group: "History",
    template: "`kms history` does not support Managed HSM keys yet",
    cause:
      "The reader queries the `AZKVAuditLogs` table of Key Vault audit events. Reading the audit log of a Managed HSM is not supported yet.",
    fix: "Read the Managed HSM audit log in the Azure portal or with `az monitor log-analytics query`, or open an issue asking for Managed HSM support.",
  },
  historySovereignCloud: {
    id: "azure.history.sovereign-cloud",
    kind: "error",
    group: "History",
    template:
      "`kms history` reads only vaults in Azure's public cloud (vault.azure.net) for now, since other clouds use another Log Analytics endpoint",
    cause:
      "Azure China and Azure Government answer Log Analytics queries on their own endpoints, which the plugin does not call yet.",
    fix: "Query `AZKVAuditLogs` with `az monitor log-analytics query` in that cloud, or open an issue asking for it.",
  },
  historyNoTable: {
    id: "azure.history.no-table",
    kind: "error",
    group: "History",
    template:
      'the Log Analytics workspace has no AZKVAuditLogs table that this identity may read: no diagnostic setting sends Key Vault audit events to it in resource-specific mode, or the identity may not be allowed to read this table. See the Azure setup guide\'s "Audit logs" section',
    cause:
      "The `AZKVAuditLogs` table appears once a vault's diagnostic setting sends the `AuditEvent` category to the workspace with the resource-specific destination. A setting in the older Azure diagnostics mode writes to `AzureDiagnostics`, which the plugin does not read, and a setting that sends to a storage account or an event hub writes nothing here. An identity whose access is limited to other tables of the workspace may also be unable to resolve this one.",
    fix: "Create the diagnostic setting with `--export-to-resource-specific true`, check that `kms.audit.azure.workspaceId` names the workspace it sends to, or give the identity read access to the `AZKVAuditLogs` table, such as the Log Analytics Data Reader role on the workspace.",
  },
  historyWorkspaceNotFound: {
    id: "azure.history.workspace-not-found",
    kind: "error",
    group: "History",
    template:
      "Log Analytics found no workspace with the id in kms.audit.azure.workspaceId (404 WorkspaceNotFoundError)",
    cause:
      "No workspace has this id, or the id is the workspace's resource id or name instead of its workspace id.",
    fix: "Set `kms.audit.azure.workspaceId` to the workspace's `customerId`, which `az monitor log-analytics workspace show` prints.",
  },
  historyUnauthorized: {
    id: "azure.history.401",
    kind: "error",
    group: "History",
    template: "Log Analytics answered {status}: the credential was not accepted",
    cause: "The token is for another tenant than the workspace's, or has expired.",
    fix: "Run `az login` again, or check `AZURE_TENANT_ID`.",
  },
  historyReadFailed: {
    id: "azure.history.read-failed",
    kind: "error",
    group: "History",
    template: "the Log Analytics query failed ({status})",
    cause:
      "Log Analytics answered the query with an error. Only the HTTP status and the service's error codes are shown, since its message can name the workspace and the vault.",
    fix: "For a 5xx status, try again later. Run with `DEBUG=hardhat:kms:*` to see the call, and report a 400 with the codes it names.",
  },
  historyPartial: {
    id: "azure.history.partial",
    kind: "error",
    group: "History",
    template:
      "Log Analytics returned part of the result with an error ({code}), so the history would be incomplete",
    cause:
      "A query can succeed with only part of its result, for example when it hits a limit of the service. The reader fails rather than show part of the history as if it were all of it.",
    fix: "Narrow the range with `--since` and `--until`, or lower `--limit`, and run again.",
  },
  historyUnreachable: {
    id: "azure.history.unreachable",
    kind: "error",
    group: "History",
    template:
      "could not reach Log Analytics ({code}). Check the network connection, DNS and any proxy",
    cause:
      "The query got no HTTP answer, after the Azure SDK's retries. The code says why, for example `ENOTFOUND` for DNS.",
    fix: "Check that `api.loganalytics.io` can be reached, and any `HTTPS_PROXY`.",
  },
  historyBadResponse: {
    id: "azure.history.bad-response",
    kind: "error",
    group: "History",
    template: "Log Analytics answered in a form this plugin does not read: {problem}",
    cause:
      "The query answer, or a `KeySign` row in it, lacks a field such an answer always has. The reader fails rather than show part of the history as if it were all of it.",
    fix: "Run again; if it repeats, report it with the problem the message names.",
  },
  noPackageVersion: {
    id: "azure.internal.no-package-version",
    kind: "internal",
    group: "Internal",
    template: "{packageName}/package.json has no version",
    cause:
      "The installed @hardhat-kms/azure has no `version` in its package.json, so the install is broken.",
    fix: "Reinstall the dependencies. If it repeats, open an issue at https://github.com/aelmanaa/hardhat-kms/issues.",
  },
} as const;

/** Every entry, checked against the entry type. */
export const ENTRIES: readonly ErrorEntry[] = Object.values(ERRORS);
