import type { ErrorEntry } from "./errors.ts";

/*
 * Every error the core package builds, with its cause and fix. First-party code builds errors
 * only from these entries, through catalogError, catalogMessage and internalError in errors.ts;
 * `pnpm run docs:check` fails on a throw that bypasses them. `pnpm run docs:errors` writes
 * docs/user/reference/errors.md from this file.
 *
 * A placeholder holds a value (a name, a number, a list), never wording: two messages that differ
 * only in the words around a value are two entries.
 */

/** The core package's error catalogue. */
export const ERRORS = {
  // Configuration: validation messages, which Hardhat shows after the config path.
  timeoutType: {
    id: "core.config.timeout-type",
    kind: "validation",
    group: "Configuration",
    template: "Expected a number of milliseconds",
    cause: "`timeoutMs`, on a key or in `kms.defaults`, is not a number.",
    fix: "Set it to a number of milliseconds, such as `30_000`.",
  },
  timeoutInteger: {
    id: "core.config.timeout-integer",
    kind: "validation",
    group: "Configuration",
    template: "Expected an integer number of milliseconds",
    cause: "`timeoutMs`, on a key or in `kms.defaults`, has a fraction.",
    fix: "Use a whole number of milliseconds.",
  },
  timeoutMin: {
    id: "core.config.timeout-min",
    kind: "validation",
    group: "Configuration",
    template: "Expected at least 1 ms",
    cause: "`timeoutMs`, on a key or in `kms.defaults`, is 0 or negative.",
    fix: "Use a positive number of milliseconds. The default `timeoutMs` is 30000.",
  },
  timeoutMax: {
    id: "core.config.timeout-max",
    kind: "validation",
    group: "Configuration",
    template: "Expected at most 2147483647 ms",
    cause:
      "`timeoutMs`, on a key or in `kms.defaults`, is larger than Node.js timers accept (2^31 - 1 ms, about 24.8 days).",
    fix: "Use a smaller value.",
  },
  allowRawDigestsType: {
    id: "core.config.allow-raw-digests-type",
    kind: "validation",
    group: "Configuration",
    template: "Expected true or false",
    cause: 'A key\'s `allowRawDigests` is not a boolean, for example the string `"true"`.',
    fix: "Write `allowRawDigests: true`, or remove the field to keep raw digests behind a person at a terminal.",
  },
  addressPin: {
    id: "core.config.address",
    kind: "validation",
    group: "Configuration",
    template:
      "Expected a 0x-prefixed 20-byte address, all lowercase, all uppercase or with a valid EIP-55 checksum",
    cause:
      "A key's `address` pin is not an address, or it is mixed-case and its EIP-55 checksum is wrong, which usually means a typo.",
    fix: "Copy the address from `npx hardhat kms address <key>`, or write it in lowercase.",
  },
  delegateList: {
    id: "core.config.delegate-list",
    kind: "validation",
    group: "Configuration",
    template: "Expected a list of delegates, each with `address` and `chains`",
    cause: "A key's `allowedDelegates` is not a list.",
    fix: 'Write it as a list, such as `[{ address: "0x...", chains: [11155111] }]`, or remove it to allow every delegate.',
  },
  delegateAddress: {
    id: "core.config.delegate-address",
    kind: "validation",
    group: "Configuration",
    template:
      "Expected a 0x-prefixed 20-byte address, all lowercase, all uppercase or with a valid EIP-55 checksum",
    cause:
      "An `allowedDelegates` entry's `address` is not an address, or it is mixed-case and its EIP-55 checksum is wrong, which usually means a typo.",
    fix: "Copy the delegate's address from its deployment or its explorer page, or write it in lowercase.",
  },
  delegateChains: {
    id: "core.config.delegate-chains",
    kind: "validation",
    group: "Configuration",
    template: 'Expected "all" or a non-empty list of chain ids',
    cause:
      'An `allowedDelegates` entry\'s `chains` is missing, empty, or neither a list nor the string `"all"`.',
    fix: 'List the chain ids the delegate is allowed on, such as `[1, 11155111]`, or write `"all"`.',
  },
  delegateChainId: {
    id: "core.config.delegate-chain-id",
    kind: "validation",
    group: "Configuration",
    template: "Expected a positive integer chain id, as a number",
    cause:
      "A chain id in an `allowedDelegates` entry's `chains` is not a whole number from 1 to 2^53 - 1, or is a string or a bigint.",
    fix: "Write the chain id as a number, such as `11155111`.",
  },
  delegateChainZero: {
    id: "core.config.delegate-chain-zero",
    kind: "validation",
    group: "Configuration",
    template:
      'Chain 0 cannot be listed. A chain-0 authorization is valid on every chain: allow it with chains: "all"',
    cause:
      "An `allowedDelegates` entry's `chains` lists 0. An authorization for chain 0 is valid on every chain, so only an entry for every chain allows it.",
    fix: 'Remove 0 from the list. To allow chain-0 authorizations for this delegate, set `chains: "all"`.',
  },
  delegateLabel: {
    id: "core.config.delegate-label",
    kind: "validation",
    group: "Configuration",
    template:
      "Expected a label of 1 to 64 characters, with no control characters and no surrounding whitespace",
    cause:
      "An `allowedDelegates` entry's `label` is empty, too long, has whitespace around it, or holds a control or format character, which could change how a terminal shows it.",
    fix: "Use a short plain name, such as `Simple7702Account`.",
  },
  delegateCodeHash: {
    id: "core.config.delegate-code-hash",
    kind: "validation",
    group: "Configuration",
    template: "Expected a 0x-prefixed 32-byte keccak256 hash",
    cause: "An `allowedDelegates` entry's `codeHash` is not `0x` followed by 64 hex digits.",
    fix: "Set it to the keccak256 of the delegate's runtime code, such as the output of `cast keccak $(cast code <address> --rpc-url <url>)`.",
  },
  delegateCodeHashEmpty: {
    id: "core.config.delegate-code-hash-empty",
    kind: "validation",
    group: "Configuration",
    template: "This is the hash of empty code; a delegate without code cannot be pinned",
    cause:
      "An `allowedDelegates` entry's `codeHash` is the keccak256 of no bytes, which an address without code has. The plugin refuses a pinned delegate without code, so the entry could never match.",
    fix: "Read the code from the chain where the delegate is deployed, and hash that.",
  },
  nonEmptyString: {
    id: "core.config.non-empty",
    kind: "validation",
    group: "Configuration",
    template: "Expected a non-empty string",
    cause:
      "A string field of the `kms` config, such as `provider`, `region` or `profile`, is empty.",
    fix: "Set the field, or remove it if it is optional.",
  },
  surroundingWhitespace: {
    id: "core.config.whitespace",
    kind: "validation",
    group: "Configuration",
    template: "Unexpected leading or trailing whitespace",
    cause: "A string field of the `kms` config starts or ends with whitespace.",
    fix: "Remove the spaces, tabs or newlines around the value.",
  },
  settingType: {
    id: "core.config.setting-type",
    kind: "validation",
    group: "Configuration",
    template: "Expected a string or a Configuration Variable",
    cause:
      "An AWS key's `region` or `profile`, or `kms.defaults.aws.region`, is neither a string nor `configVariable(...)`.",
    fix: "Use a string, such as `us-east-1` for a region, or `configVariable(...)`.",
  },
  providerMisspelled: {
    id: "core.config.provider-misspelled",
    kind: "validation",
    group: "Configuration",
    template: 'Unknown provider "{provider}". Did you mean "{suggestion}"?',
    cause:
      "A key's `provider` matches a built-in provider id (`aws`, `gcp`, `azure`, `turnkey`) in another case, or is one edit away from one, such as `AWS`, `gpc` or `turnky`.",
    fix: "Use the id the message suggests. A third-party provider needs an id that does not look like a built-in one.",
  },
  providerReserved: {
    id: "core.config.provider-reserved",
    kind: "validation",
    group: "Configuration",
    template:
      'Provider "{provider}" is reserved for the planned {name} provider, which is not released yet (https://github.com/aelmanaa/hardhat-kms/issues/{issue})',
    cause:
      "A key's `provider` is one of the ids that hardhat-kms reserves for its planned providers, in any case. No other plugin can use these ids. The provider contract lists them.",
    fix: "Follow the linked issue for the release, or use another provider. A third-party provider needs an id of its own.",
  },
  keyShape: {
    id: "core.config.key-shape",
    kind: "validation",
    group: "Configuration",
    template:
      'Expected a key object with a `provider` field, for example { provider: "aws", keyId: "alias/deployer" }',
    cause:
      "An entry of `kms.keys`, or a key object in `kmsAccounts`, is not an object with a string `provider`.",
    fix: "Write the key as an object with a `provider` field and the fields of that provider.",
  },
  accountShape: {
    id: "core.config.account-shape",
    kind: "validation",
    group: "Configuration",
    template: "Expected the name of a key in `kms.keys` or a key object",
    cause: "An entry of a network's `kmsAccounts` is neither a string nor an object.",
    fix: "List key names from `kms.keys`, or key objects.",
  },
  keyName: {
    id: "core.config.key-name",
    kind: "validation",
    group: "Configuration",
    template: "Key names start with a letter and use at most 64 letters, digits, `_` or `-`",
    cause: "A name in `kms.keys` has another character, starts with a digit or is too long.",
    fix: "Rename the key. Tasks take key names on the command line, so they are kept simple.",
  },
  simulatedBalanceType: {
    id: "core.config.simulated-balance-type",
    kind: "validation",
    group: "Configuration",
    template: "Expected a bigint amount of wei, for example 10n ** 18n",
    cause: "`kms.simulatedBalance` is not a bigint, for example a number or a string.",
    fix: "Write it as a bigint, such as `10n ** 18n` for 1 ETH.",
  },
  simulatedBalanceNegative: {
    id: "core.config.simulated-balance-negative",
    kind: "validation",
    group: "Configuration",
    template: "Expected a non-negative amount of wei",
    cause: "`kms.simulatedBalance` is negative.",
    fix: "Use 0 or more wei.",
  },
  unknownKeyNoKeys: {
    id: "core.config.unknown-key-empty",
    kind: "validation",
    group: "Configuration",
    template: 'Unknown key "{account}". `kms.keys` is empty.',
    cause: "A network's `kmsAccounts` names a key, but `kms.keys` defines none.",
    fix: "Define the key in `kms.keys`, or put the key object in `kmsAccounts` instead of its name.",
  },
  unknownKey: {
    id: "core.config.unknown-key",
    kind: "validation",
    group: "Configuration",
    template: 'Unknown key "{account}". Known keys: {known}.',
    cause:
      "A network's `kmsAccounts` names a key that `kms.keys` does not define. Names are case-sensitive.",
    fix: "Use one of the names listed, or add the key to `kms.keys`.",
  },
  keyListedTwice: {
    id: "core.config.key-listed-twice",
    kind: "validation",
    group: "Configuration",
    template: 'Key "{account}" is listed twice',
    cause: "A network's `kmsAccounts` names the same key twice.",
    fix: "Remove the repeated name.",
  },
  awsEndpoint: {
    id: "core.config.aws-endpoint",
    kind: "validation",
    group: "Configuration",
    template: "Expected an http or https URL without credentials, such as http://localhost:4566",
    cause:
      "An AWS key's `endpoint` is not an http or https URL, or it has a user name or password, which would end up in logs and errors.",
    fix: "Use a plain URL. The AWS SDK takes credentials from its own chain, never from the URL.",
  },
  awsKeyId: {
    id: "core.config.aws-key-id",
    kind: "validation",
    group: "Configuration",
    template: "Expected a key id, a key ARN, an alias name (`alias/...`) or an alias ARN",
    cause: "An AWS key's `keyId` has none of the forms AWS KMS accepts.",
    fix: "Use the key id, the key ARN, `alias/<name>` or the alias ARN, as `aws kms list-aliases` shows them.",
  },
  awsRegionConflict: {
    id: "core.config.aws-region-conflict",
    kind: "validation",
    group: "Configuration",
    template: "Conflicts with the region in the key ARN ({region})",
    cause: "An AWS key's `keyId` is an ARN, and its `region` names another region than the ARN.",
    fix: "Remove `region`: an ARN already names the region.",
  },
  azureEitherForm: {
    id: "core.config.azure-either-form",
    kind: "validation",
    group: "Configuration",
    template:
      "Use either `keyId` or `vaultUrl` with `keyName` (and an optional `keyVersion`), not both",
    cause: "An Azure key mixes the `keyId` form and the `vaultUrl` form.",
    fix: "Keep one form: `keyId` alone, or `vaultUrl` with `keyName` and an optional `keyVersion`.",
  },
  azureKeyId: {
    id: "core.config.azure-key-id",
    kind: "validation",
    group: "Configuration",
    template:
      "Expected an https URL on an Azure Key Vault or Managed HSM host (for example `*.vault.azure.net`) with the path /keys/<name> or /keys/<name>/<version>",
    cause: "An Azure key's `keyId` is not a Key Vault or Managed HSM key URL.",
    fix: "Copy the key identifier from `az keyvault key show` (its `key.kid`), or from the portal.",
  },
  azureVaultUrl: {
    id: "core.config.azure-vault-url",
    kind: "validation",
    group: "Configuration",
    template:
      "Expected an https URL on an Azure Key Vault or Managed HSM host (for example `*.vault.azure.net`), with no path",
    cause:
      "An Azure key's `vaultUrl` is not the https URL of a vault or Managed HSM, or it has a path.",
    fix: "Use the vault URL alone, such as `https://my-vault.vault.azure.net`, and put the key in `keyName`.",
  },
  azureKeyName: {
    id: "core.config.azure-key-name",
    kind: "validation",
    group: "Configuration",
    template: "Expected 1 to 127 letters, digits or dashes",
    cause:
      "An Azure key's `keyName` has a character Key Vault does not allow in key names, or is too long.",
    fix: "Use the key's name as Key Vault shows it.",
  },
  azureKeyVersion: {
    id: "core.config.azure-key-version",
    kind: "validation",
    group: "Configuration",
    template: "Expected letters and digits only",
    cause: "An Azure key's `keyVersion` is not a Key Vault version id.",
    fix: "Copy the version from `az keyvault key list-versions`, or remove `keyVersion` to use the current version.",
  },
  azureWorkspaceId: {
    id: "core.config.azure-workspace-id",
    kind: "validation",
    group: "Configuration",
    template:
      "Expected a Log Analytics workspace id, a GUID such as 00000000-0000-0000-0000-000000000000",
    cause:
      "`kms.audit.azure.workspaceId` is not a GUID. It takes the workspace id, not the workspace name or resource id.",
    fix: "Copy the workspace id from `az monitor log-analytics workspace show --query customerId`, or from the workspace's overview in the portal.",
  },
  gcpEitherForm: {
    id: "core.config.gcp-either-form",
    kind: "validation",
    group: "Configuration",
    template:
      "Use either `keyVersionName` or `projectId`, `location`, `keyRing`, `keyName` and `keyVersion`, not both",
    cause: "A Google Cloud key mixes the `keyVersionName` form and the parts form.",
    fix: "Keep one form: `keyVersionName` alone, or all five parts.",
  },
  gcpKeyVersionName: {
    id: "core.config.gcp-key-version-name",
    kind: "validation",
    group: "Configuration",
    template:
      "Expected projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>/cryptoKeyVersions/<version>",
    cause: "A Google Cloud key's `keyVersionName` is not the resource name of a key version.",
    fix: "Copy the name from `gcloud kms keys versions list`; it ends with `/cryptoKeyVersions/<version>`.",
  },
  gcpKeyVersionType: {
    id: "core.config.gcp-key-version-type",
    kind: "validation",
    group: "Configuration",
    template: "Expected a positive integer, a string or a Configuration Variable",
    cause:
      "A Google Cloud key's `keyVersion` is another type, or a number that is not a positive integer.",
    fix: "Use the version number, such as `1`, a string, or `configVariable(...)`.",
  },
  gcpSegment: {
    id: "core.config.gcp-segment",
    kind: "validation",
    group: "Configuration",
    template: "Expected letters, digits, `_`, `.`, `:` or `-`, and not `.` or `..`",
    cause:
      "A Google Cloud key's `projectId`, `location`, `keyRing` or `keyName` has a character a resource name cannot hold.",
    fix: "Check the value for a typo, against the key's resource name in `gcloud kms keys versions list`.",
  },
  gcpKeyVersion: {
    id: "core.config.gcp-key-version",
    kind: "validation",
    group: "Configuration",
    template: "Expected a positive integer version",
    cause: "A Google Cloud key's `keyVersion` string is not a positive integer.",
    fix: 'Use the version number, such as `"1"`.',
  },
  turnkeyOrganizationId: {
    id: "core.config.turnkey-organization-id",
    kind: "validation",
    group: "Configuration",
    template:
      "Expected a Turnkey organization id, a UUID such as 00000000-0000-0000-0000-000000000000",
    cause: "A Turnkey key's `organizationId` is not a UUID.",
    fix: "Use the id of the organization or sub-organization that holds the wallet account.",
  },
  turnkeyAddressRequired: {
    id: "core.config.turnkey-address-required",
    kind: "validation",
    group: "Configuration",
    template: "A Turnkey key needs `address`, the address of the wallet account that signs",
    cause:
      "A Turnkey key has no `address`. The plugin signs with the account this address names, and checks every signature against it.",
    fix: "Add `address` with the Ethereum address of the Turnkey wallet account.",
  },
  secretVariable: {
    id: "core.config.secret-variable",
    kind: "validation",
    group: "Configuration",
    template:
      "Expected `configVariable(NAME)` without a `default` or a `format`. A secret cannot be written in the config",
    cause:
      "A secret field, such as a Turnkey key's `apiPrivateKey`, is a literal string, a configuration variable with a `default` or with a `format` other than `{variable}`, or another value.",
    fix: 'Write `configVariable("TURNKEY_API_PRIVATE_KEY")`, and set the variable in the environment or in `hardhat-keystore`.',
  },
  // Configuration: values read when a key is first used.
  invalidValue: {
    id: "core.config.invalid-value",
    kind: "error",
    group: "Configuration",
    template: "invalid value for {path} ({display}): {problem}",
    cause:
      "A key identifier does not have its provider's format. A value from a configuration variable is checked when it is read, which config validation cannot do. `{path}` is the config path, such as `kms.keys.deployer.keyId` or `--kms aws`, and `{display}` shows a variable by its name, never its value.",
    fix: "Fix the value, or the variable it comes from. The part after the colon is one of the reasons below.",
  },
  awsKeyIdReason: {
    id: "core.config.aws-key-id-reason",
    kind: "reason",
    group: "Configuration",
    template: "expected a key id, a key ARN, an alias name (`alias/...`) or an alias ARN",
    cause: "An AWS `keyId` has none of the forms AWS KMS accepts.",
    fix: "Use the key id, the key ARN, `alias/<name>` or the alias ARN.",
  },
  awsRegionConflictReason: {
    id: "core.config.aws-region-conflict-reason",
    kind: "reason",
    group: "Configuration",
    template: "the key ARN's region conflicts with `region` ({region})",
    cause:
      "An AWS `keyId` is an ARN in another region than the key's `region`. `{region}` shows a region from a configuration variable by the variable's name, never its value.",
    fix: "Remove `region`, or fix the ARN.",
  },
  azureKeyIdReason: {
    id: "core.config.azure-key-id-reason",
    kind: "reason",
    group: "Configuration",
    template:
      "expected an https URL on an Azure Key Vault or Managed HSM host (for example `*.vault.azure.net`) with the path /keys/<name> or /keys/<name>/<version>",
    cause:
      "An Azure `keyId`, or the URL built from `vaultUrl`, `keyName` and `keyVersion`, is not a key URL.",
    fix: "Copy the key identifier from `az keyvault key show`, or fix the parts.",
  },
  azureWorkspaceIdReason: {
    id: "core.config.azure-workspace-id-reason",
    kind: "reason",
    group: "Configuration",
    template: "expected a Log Analytics workspace id, a GUID",
    cause:
      "The configuration variable of `kms.audit.azure.workspaceId` holds something other than a GUID.",
    fix: "Set the variable to the workspace id from `az monitor log-analytics workspace show --query customerId`.",
  },
  gcpKeyVersionNameReason: {
    id: "core.config.gcp-key-version-name-reason",
    kind: "reason",
    group: "Configuration",
    template:
      "expected projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>/cryptoKeyVersions/<version>",
    cause:
      "A Google Cloud `keyVersionName`, or the name built from its parts, is not a key version name.",
    fix: "Copy the name from `gcloud kms keys versions list`.",
  },
  gcpSegmentReason: {
    id: "core.config.gcp-segment-reason",
    kind: "reason",
    group: "Configuration",
    template: "expected letters, digits, `_`, `.`, `:` or `-`, and not `.` or `..`",
    cause:
      "A Google Cloud `projectId`, `location`, `keyRing` or `keyName` has a character a resource name cannot hold.",
    fix: "Check the value for a typo, against the key's resource name in `gcloud kms keys versions list`.",
  },
  gcpKeyVersionReason: {
    id: "core.config.gcp-key-version-reason",
    kind: "reason",
    group: "Configuration",
    template: "expected a positive integer version",
    cause: "A Google Cloud `keyVersion` is not a positive integer.",
    fix: "Use the version number, such as `1`.",
  },
  turnkeyOrganizationIdReason: {
    id: "core.config.turnkey-organization-id-reason",
    kind: "reason",
    group: "Configuration",
    template: "expected a Turnkey organization id, a UUID",
    cause:
      "The configuration variable of a Turnkey key's `organizationId` holds something other than a UUID.",
    fix: "Set the variable to the id of the organization or sub-organization that holds the wallet account.",
  },

  // The --kms option.
  kmsOptionEmpty: {
    id: "core.kms-option.empty",
    kind: "error",
    group: "The `--kms` option",
    template: "--kms: expected one or more of aws, gcp and azure, such as --kms aws",
    cause: "`--kms` was given an empty value.",
    fix: "Name the providers whose environment variables hold keys, such as `--kms aws` or `--kms aws,gcp`.",
  },
  kmsOptionUnknownSuggested: {
    id: "core.kms-option.unknown-provider-suggested",
    kind: "error",
    group: "The `--kms` option",
    template:
      '--kms {provider}: unknown provider. Did you mean "{suggestion}"? Expected aws, gcp or azure',
    cause: "`--kms` names a provider that is close to a built-in one, such as `AWS` or `gpc`.",
    fix: "Use the suggested id. `--kms` reads only the variables of `aws`, `gcp` and `azure`.",
  },
  kmsOptionUnknown: {
    id: "core.kms-option.unknown-provider",
    kind: "error",
    group: "The `--kms` option",
    template: "--kms {provider}: unknown provider. Expected aws, gcp or azure",
    cause:
      "`--kms` names a provider other than `aws`, `gcp` and `azure`, such as `turnkey`. `--kms` reads only the variables of these three providers. Turnkey keys and third-party providers' keys are configured in `kms.keys` only.",
    fix: "Use `aws`, `gcp` or `azure`, or configure the key in the Hardhat config.",
  },
  kmsOptionListedTwice: {
    id: "core.kms-option.listed-twice",
    kind: "error",
    group: "The `--kms` option",
    template: "--kms {provider}: listed twice",
    cause: "`--kms` names the same provider twice.",
    fix: "Name each provider once.",
  },
  kmsOptionListEmpty: {
    id: "core.kms-option.list-empty",
    kind: "error",
    group: "The `--kms` option",
    template: "--kms {provider}: {list} holds no key ids",
    cause:
      "`AWS_KMS_KEY_IDS` or `AZURE_KEY_VAULT_KEY_IDS` is set, but holds only commas and spaces.",
    fix: "Put comma-separated key ids in it, or unset it to use the single-key variable.",
  },
  kmsOptionNotSet: {
    id: "core.kms-option.not-set",
    kind: "error",
    group: "The `--kms` option",
    template: "--kms {provider}: set {single}, or {list} for several keys",
    cause:
      "`--kms aws` or `--kms azure` was given, but neither of the provider's key variables is set.",
    fix: "Export the variable the message names, such as `AWS_KMS_KEY_ID=alias/deployer`.",
  },
  kmsOptionRepeated: {
    id: "core.kms-option.repeated",
    kind: "error",
    group: "The `--kms` option",
    template: "--kms {provider}: {name} repeats {first}",
    cause: "A list variable such as `AWS_KMS_KEY_IDS` holds the same key id twice.",
    fix: "Remove the repeated entry.",
  },
  kmsOptionVariableNotSet: {
    id: "core.kms-option.variable-not-set",
    kind: "error",
    group: "The `--kms` option",
    template: "--kms {provider}: {name} is not set",
    cause:
      "`--kms gcp` needs all of `GCP_PROJECT_ID`, `GCP_LOCATION`, `GCP_KEY_RING`, `GCP_KEY_NAME` and `GCP_KEY_VERSION`, and one is unset or empty.",
    fix: "Export the variable the message names.",
  },

  // Provider plugins: building a key's adapter.
  adapterNothing: {
    id: "core.provider.adapter-nothing",
    kind: "error",
    group: "Provider plugins",
    template:
      "a kms.createKeyAdapter handler returned nothing for this key. Handlers must return `await next(context, key)` for keys of other providers",
    cause:
      "A provider plugin's `createKeyAdapter` handler returned `undefined` or `null` instead of passing the key on.",
    fix: "If you wrote the handler, return `await next(context, key)` for keys it does not handle. Otherwise report it to the provider plugin.",
  },
  adapterNotObject: {
    id: "core.provider.adapter-not-object",
    kind: "error",
    group: "Provider plugins",
    template: "the adapter for this key is not an object",
    cause:
      "A provider plugin's `createKeyAdapter` handler returned a value that is not an adapter object.",
    fix: "Report it to the provider plugin; see the adapter contract in the provider guide.",
  },
  adapterNoDescribe: {
    id: "core.provider.adapter-no-describe",
    kind: "error",
    group: "Provider plugins",
    template: "the adapter for this key has no describe() method",
    cause:
      "The adapter a provider plugin returned has no `describe()` method, which every adapter needs.",
    fix: "Report it to the provider plugin.",
  },
  adapterNotFunction: {
    id: "core.provider.adapter-not-function",
    kind: "error",
    group: "Provider plugins",
    template: "the adapter's {method} is not a function",
    cause: "The adapter has a property with a method's name, but it is not a function.",
    fix: "Report it to the provider plugin.",
  },
  adapterNotBoolean: {
    id: "core.provider.adapter-not-boolean",
    kind: "error",
    group: "Provider plugins",
    template: "the adapter's {property} is not a boolean",
    cause:
      "The adapter has a property with the name of a flag of the adapter contract, such as `signTransactionOutlivesAbort`, but its value is not `true` or `false`.",
    fix: "Report it to the provider plugin.",
  },
  adapterNoSigning: {
    id: "core.provider.adapter-no-signing",
    kind: "error",
    group: "Provider plugins",
    template: "the adapter for this key has no signing method ({methods})",
    cause:
      "The adapter implements none of `signDigest`, `signMessage` and `signTypedData`. `signTransaction` alone does not count, since messages and typed data need one of the others.",
    fix: "Report it to the provider plugin.",
  },
  adapterNoIdentity: {
    id: "core.provider.adapter-no-identity",
    kind: "error",
    group: "Provider plugins",
    template:
      "the adapter for this key can neither return a public key nor an address, and the key has no `address` pin",
    cause:
      "The adapter has neither `getPublicKey` nor `getAddress`, so only a pin can tell which address it signs for.",
    fix: "Set `address` on the key to the account's address. The first signature checks it.",
  },
  adapterDescribeFailed: {
    id: "core.provider.adapter-describe-failed",
    kind: "error",
    group: "Provider plugins",
    template: "the adapter's describe() failed ({errorName})",
    cause: "The adapter's `describe()` threw. Only the error's class name is shown.",
    fix: "Report it to the provider plugin.",
  },
  adapterDescribeFields: {
    id: "core.provider.adapter-describe-fields",
    kind: "error",
    group: "Provider plugins",
    template: "the adapter's describe() must return non-empty strings for {fields}",
    cause:
      "The adapter's `describe()` result lacks `provider`, `pinnedId` or `displayId`, or one is empty.",
    fix: "Report it to the provider plugin.",
  },
  noPlugin: {
    id: "core.provider.no-plugin",
    kind: "error",
    group: "Provider plugins",
    template:
      'no plugin provides "{provider}" keys. Add the plugin for this provider to `plugins` in your Hardhat config, or check the `provider` field',
    cause: "No plugin in the Hardhat config handles keys of this `provider`.",
    fix: "Add the provider's plugin to `plugins`, or fix the key's `provider` field.",
  },
  providerNotAvailable: {
    id: "core.provider.not-available",
    kind: "error",
    group: "Provider plugins",
    template:
      "signing with {name} keys is not available yet (https://github.com/aelmanaa/hardhat-kms/issues/{issue})",
    cause:
      "The provider is planned, but its adapter is not released yet. A key with a reserved provider id gets this error too when it reaches the resolved config without validation, for example through another plugin's config hook.",
    fix: "Follow the linked issue, or use another provider.",
  },
  providerPackageMissing: {
    id: "core.provider.package-missing",
    kind: "error",
    group: "Provider plugins",
    template:
      "{name} keys need the {package} plugin. Install it with `npm install --save-dev {package}` and add it to `plugins` in your Hardhat config",
    cause:
      "The config has a key of a built-in provider, but the provider's package is not in `plugins`.",
    fix: "Install the package the message names and add its plugin to `plugins`.",
  },
  adapterFailed: {
    id: "core.provider.adapter-failed",
    kind: "error",
    group: "Provider plugins",
    template: "creating the adapter failed ({errorName})",
    cause:
      "A provider plugin threw while building the key's adapter, for example when its cloud SDK failed to load. Only the error's class name is shown, since SDK messages can carry request details.",
    fix: "Check that the provider's SDK is installed (`npm ls`), and run with `DEBUG=hardhat:kms:*` to see the step that failed.",
  },
  versionMismatch: {
    id: "core.provider.version-mismatch",
    kind: "error",
    group: "Provider plugins",
    template:
      "{package} {version} needs hardhat-kms {version}, but hardhat-kms {core} is installed. Install the same version of both, for example `npm install --save-dev hardhat-kms@{target} {package}@{target}`",
    cause:
      "A first-party provider package and hardhat-kms have different versions. They are released together, and the provider package asks for its own version of hardhat-kms as a peer dependency. Measured on new projects that install both packages: npm 11.15.0 stops the install with `ERESOLVE` unless it runs with `--legacy-peer-deps`; pnpm 12.8.1, Yarn 1.22.22 and Yarn 4.18.1 warn and install both. The check runs the first time a key of that provider is used.",
    fix: "Run the install command the message prints.",
  },
  versionMismatchNoTarget: {
    id: "core.provider.version-mismatch-no-target",
    kind: "error",
    group: "Provider plugins",
    template:
      "{package} {version} needs hardhat-kms {version}, but hardhat-kms {core} is installed. Install the same version of both",
    cause:
      "As above, with a version that is not a plain `major.minor.patch`, such as a tag, so no install command is suggested.",
    fix: "Install the same version of hardhat-kms and the provider package.",
  },
  debugNamespaceInvalid: {
    id: "core.provider.debug-namespace-invalid",
    kind: "error",
    group: "Provider plugins",
    template:
      "kmsDebug namespace {namespace} is not valid: use 1 to 64 lowercase letters, digits and -, starting with a letter",
    cause:
      "A provider package called `kmsDebug` from `hardhat-kms/provider-utils` with a namespace that is empty, longer than 64 characters, does not start with a letter, or holds another character, such as an uppercase letter, `*`, `,` or `:`. `*`, `,` and `:` would change which `DEBUG` patterns match it.",
    fix: "If you wrote the provider package, pass its provider id to `kmsDebug`, such as `myvault`. Otherwise report it to the provider package.",
  },
  debugNamespaceReserved: {
    id: "core.provider.debug-namespace-reserved",
    kind: "error",
    group: "Provider plugins",
    template:
      "kmsDebug namespace {namespace} belongs to hardhat-kms ({reserved}); log under the provider id instead",
    cause:
      "A provider package called `kmsDebug` from `hardhat-kms/provider-utils` with one of the namespaces hardhat-kms logs under, so its lines would pass for the core's.",
    fix: "If you wrote the provider package, pass its provider id to `kmsDebug`, such as `myvault`. Otherwise report it to the provider package.",
  },

  // Signing.
  signerNoIdentity: {
    id: "core.signer.no-identity",
    kind: "error",
    group: "Signing",
    template: "the adapter can neither return a public key nor an address; set an `address` pin",
    cause:
      "The key's adapter has neither `getPublicKey` nor `getAddress`, and the key has no `address`.",
    fix: "Set `address` on the key to the account's address.",
  },
  signerTimeoutRange: {
    id: "core.signer.timeout-range",
    kind: "error",
    group: "Signing",
    template: "the timeout must be an integer from 1 to 2147483647 ms, got {timeout}",
    cause:
      "A signer was created with a `timeoutMs` that Node.js cannot schedule. The config validation refuses such values first.",
    fix: "Set `timeoutMs` to an integer from 1 to 2147483647.",
  },
  signerAddressInvalid: {
    id: "core.signer.address-invalid",
    kind: "error",
    group: "Signing",
    template: "the configured address is invalid: {reason}",
    cause:
      "The key's `address` pin is not a valid address. The config validation refuses such values first.",
    fix: "Copy the address from `npx hardhat kms address <key>`, or write it in lowercase.",
  },
  signerAddressOnly: {
    id: "core.signer.address-only",
    kind: "error",
    group: "Signing",
    template: "the provider returns only the key's address, not its public key",
    cause:
      "The provider's adapter reports an address but no public key, and the key has not signed yet in this run, which would reveal it.",
    fix: "Use a provider that returns the public key. An address-only provider reveals it only once the key has signed in the same run.",
  },
  signerEip191Failed: {
    id: "core.signer.eip191-failed",
    kind: "error",
    group: "Signing",
    template: "the signature failed EIP-191 verification",
    cause:
      "The final check of a personal-message signature failed, after the signature had passed the low-level checks. The signature is not released.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  signerEip712Failed: {
    id: "core.signer.eip712-failed",
    kind: "error",
    group: "Signing",
    template: "the signature failed EIP-712 verification",
    cause:
      "The final check of a typed-data signature failed, after the signature had passed the low-level checks. The signature is not released.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  signerCannotIdentify: {
    id: "core.signer.cannot-identify",
    kind: "error",
    group: "Signing",
    template: "the adapter cannot identify its key",
    cause:
      "The key's adapter has neither `getPublicKey` nor `getAddress`, and the key has no `address`. Creating the adapter refuses such a key first, so this is a guard.",
    fix: "Set `address` on the key to the account's address.",
  },
  addressMismatch: {
    id: "core.signer.address-mismatch",
    kind: "error",
    group: "Signing",
    template:
      'the key derives to {address}, but the configured address is {expected}, so nothing was signed. The key id may now name the wrong key or a substituted one, or the pin may be wrong. Do not change the pin to match until you know why the key changed; see "When the pin fails" in the key rotation guide, which also covers a deliberate move to a new key.',
    cause:
      "The key's public key gives another address than its `address` pin: the key id, alias or version now names another key, by mistake or by substitution, or the pin is wrong. Nothing was signed.",
    fix: 'Find out why the key changed before you touch the pin. If the change was a mistake, point the config back at the old key. If it was deliberate, point the old entry back at the old key and follow "Move to a new key" in the key rotation guide, which gives the new key its own entry and pin. If the pin itself is wrong, for example mistyped, do not change it until you have confirmed that the key id names the key that holds your funds and roles. Then set the pin to the address after "the key derives to" in this error, or remove the pin, run `npx hardhat kms address <key>` and pin what it prints.',
  },
  signerDigestLength: {
    id: "core.signer.digest-length",
    kind: "error",
    group: "Signing",
    template: "expected a {expected}-byte digest, got {length} bytes",
    cause:
      "Code that uses the signer asked it to sign a digest that is not 32 bytes. Nothing was sent to the provider.",
    fix: "Sign a 32-byte hash, such as a keccak256 digest.",
  },
  signerInvalidSignature: {
    id: "core.signer.invalid-signature",
    kind: "error",
    group: "Signing",
    template: "the provider returned an invalid signature ({reason})",
    cause:
      "The provider returned a signature that failed the checks twice in a row. The reason is one of the signature reasons below. A key other than the configured one fails here too.",
    fix: "Check that the config names the key you expect, then run again. If it repeats, run with `DEBUG=hardhat:kms:*` and report it.",
  },
  signerCannotSign: {
    id: "core.signer.cannot-sign",
    kind: "error",
    group: "Signing",
    template: "the provider cannot sign a {kind}",
    cause:
      "The key's adapter has no `signDigest`, and no method for this kind of payload (`signMessage`, `signTypedData` or `signTransaction`).",
    fix: "Sign another kind of payload with this key, or use a provider that signs digests.",
  },
  signerKeyMaterial: {
    id: "core.signer.key-material",
    kind: "error",
    group: "Signing",
    template: "{reason}",
    cause:
      "The provider returned a public key or an address that the plugin refuses. The message is one of the reasons under Public keys and addresses.",
    fix: "Check that the key is a secp256k1 signing key, as the provider's setup guide creates it.",
  },
  signerNoAnswer: {
    id: "core.signer.no-answer",
    kind: "error",
    group: "Signing",
    template: "no answer within {timeout} ms",
    cause:
      "The provider did not answer within the key's `timeoutMs`. The request may still complete at the provider; see the security model.",
    fix: "Check the network and the region or endpoint, or raise `timeoutMs` on the key or in `kms.defaults`.",
  },
  signerCancelled: {
    id: "core.signer.cancelled",
    kind: "error",
    group: "Signing",
    template: "cancelled by the caller's abort signal",
    cause:
      "The `signal` given to `connection.kms.getAccount` aborted before or during a KMS call, so the plugin stopped waiting and returned nothing. It does not retry a cancelled call. A request that already reached the provider can still be signed there and show in its audit log, but the plugin never returns that signature.",
    fix: "Nothing, if the abort was meant. To sign again, get a new account with a signal that has not aborted.",
  },
  signerTransactionOutstanding: {
    id: "core.signer.transaction-outstanding",
    kind: "error",
    group: "Signing",
    template:
      "{reason}. The request reached the provider, and {who} may still sign this transaction ({request}); anyone who can read it there can then broadcast it with nonce {nonce}. {reject} while it is pending; then, or if it completed, send a replacement transaction with nonce {nonce}, before any other transaction from this account{hold}",
    cause:
      "The key's adapter declares that a transaction request it gave up on may still be signed at the provider (`signTransactionOutlivesAbort`), as Turnkey's `sign_transaction` does, and the call failed after the request was sent: it timed out, was cancelled, or the adapter threw an error without saying that the provider refused the request (`ctx.requestRefused`), such as Turnkey's `turnkey.activity.approval-needed`, an unreachable or failing service while it polled, or a signed transaction it refused. The message starts with that cause. Turnkey keeps working on an accepted activity and stores the signed transaction, which every user of the organization can read and broadcast. Two valid transactions with one nonce could then exist, so the plugin keeps the nonce held instead of signing it again: on `eth_sendTransaction`, `eth_signTransaction` and a library account's `signTransaction`, the network connection's later sends from the account skip it. The hold ends once the nonce is mined (or, on an HTTP network, when any transaction with it reaches the node through the connection), when the provider's copy itself reaches the node through the connection, or when the connection closes. A Turnkey id is shown only when it is a UUID.",
    fix: 'For Turnkey, open the activity in the dashboard. If it is still pending, reject it, so that nobody approves or completes it later. Then, or if it completed, send a replacement with the nonce the message names, with an explicit `nonce`, before anything else (or broadcast the transaction the completed activity holds); the replacement also fills the gap that the plugin\'s later sends wait behind. Raise `timeoutMs` if Turnkey is slow to answer. See the Turnkey setup guide, "When Turnkey does not answer in time".',
  },
  signerCallFailed: {
    id: "core.signer.provider-call-failed",
    kind: "error",
    group: "Signing",
    template: "the provider call failed ({errorName})",
    cause:
      "The provider's SDK threw an error that the provider plugin does not explain. Only the error's class name is shown, since SDK messages can carry request details.",
    fix: "Look the class name up in the provider's setup guide, and run with `DEBUG=hardhat:kms:*` to see the call.",
  },
  timedOut: {
    id: "core.signer.timed-out",
    kind: "reason",
    group: "Signing",
    template: "timed out after {timeout} ms",
    cause: "A provider call ran out of time. It is reported as `no answer within … ms`.",
    fix: "See `core.signer.no-answer`.",
  },
  cancelled: {
    id: "core.signer.cancelled-reason",
    kind: "reason",
    group: "Signing",
    template: "cancelled by the caller",
    cause:
      "The caller's abort signal stopped a provider call. It is reported as `cancelled by the caller's abort signal`.",
    fix: "See `core.signer.cancelled`.",
  },

  // Public keys and addresses: reasons for core.signer.key-material and others.
  spkiDer: {
    id: "core.key.spki-der",
    kind: "reason",
    group: "Public keys and addresses",
    template:
      "expected the canonical DER encoding of an uncompressed secp256k1 SubjectPublicKeyInfo",
    cause:
      "The provider returned a DER public key that is not an uncompressed secp256k1 key, for example a P-256 key.",
    fix: "Use a secp256k1 key, as the provider's setup guide creates it.",
  },
  jwkKeyType: {
    id: "core.key.jwk-key-type",
    kind: "reason",
    group: "Public keys and addresses",
    template: 'expected an EC key, got key type "{keyType}"',
    cause:
      "The provider returned a JSON Web Key that is not an elliptic-curve key, for example an RSA key.",
    fix: "Use an EC key on the secp256k1 curve.",
  },
  jwkCurve: {
    id: "core.key.jwk-curve",
    kind: "reason",
    group: "Public keys and addresses",
    template: 'expected curve P-256K (secp256k1), got "{curve}"',
    cause: "The provider returned an EC JSON Web Key on another curve, such as P-256.",
    fix: "Use a key on the secp256k1 curve (P-256K).",
  },
  publicKeyLength: {
    id: "core.key.length",
    kind: "reason",
    group: "Public keys and addresses",
    template: "expected a 65-byte uncompressed public key",
    cause:
      "A public key does not have the 65 bytes of an uncompressed secp256k1 point (`0x04`, x, y).",
    fix: "If a provider plugin returned it, report it to the plugin.",
  },
  notOnCurve: {
    id: "core.key.not-on-curve",
    kind: "reason",
    group: "Public keys and addresses",
    template: "the public key is not a point on secp256k1",
    cause:
      "The public key's coordinates are not a point on the secp256k1 curve: it is corrupt, or from another curve.",
    fix: "Check that the key is a secp256k1 key. If a provider plugin returned it, report it to the plugin.",
  },
  spkiParse: {
    id: "core.key.spki-parse",
    kind: "reason",
    group: "Public keys and addresses",
    template: "the public key could not be parsed as SubjectPublicKeyInfo",
    cause: "The provider returned a PEM or DER public key that Node.js cannot read.",
    fix: "If it repeats, report it to the provider plugin.",
  },
  spkiCurve: {
    id: "core.key.spki-curve",
    kind: "reason",
    group: "Public keys and addresses",
    template: "expected a secp256k1 key, got {keyType} {curve}",
    cause: "The provider returned the public key of another key type or curve.",
    fix: "Use a secp256k1 key, as the provider's setup guide creates it.",
  },
  jwkCoordinateMissing: {
    id: "core.key.coordinate-missing",
    kind: "reason",
    group: "Public keys and addresses",
    template: 'the key has no "{coordinate}" coordinate',
    cause: "The provider returned a JSON Web Key without its `x` or `y` coordinate.",
    fix: "If it repeats, report it to the provider plugin.",
  },
  jwkCoordinateLong: {
    id: "core.key.coordinate-long",
    kind: "reason",
    group: "Public keys and addresses",
    template: 'the "{coordinate}" coordinate is longer than 32 bytes',
    cause: "A JSON Web Key coordinate is too long for secp256k1.",
    fix: "Check that the key is a secp256k1 key.",
  },
  invalidAddress: {
    id: "core.key.invalid-address",
    kind: "reason",
    group: "Public keys and addresses",
    template: "{address} is not a valid Ethereum address",
    cause:
      "A value is not `0x` and 40 hex digits, or it is mixed-case with a wrong EIP-55 checksum.",
    fix: "Check the address for a typo, or write it in lowercase.",
  },

  // Signatures: reasons for core.signer.invalid-signature and the kms verify task.
  signatureFormat: {
    id: "core.signature.format",
    kind: "reason",
    group: "Signatures",
    template: "unsupported signature format; expected der or compact",
    cause: "A provider plugin returned a signature in a format the core does not read.",
    fix: "Report it to the provider plugin.",
  },
  signatureCompactLength: {
    id: "core.signature.compact-length",
    kind: "reason",
    group: "Signatures",
    template: "expected a 64-byte compact signature, got {length} bytes",
    cause: "The provider returned an `r || s` signature of the wrong length.",
    fix: "If it repeats, report it.",
  },
  signatureParse: {
    id: "core.signature.parse",
    kind: "reason",
    group: "Signatures",
    template: "the {format} signature could not be parsed",
    cause: "The provider returned DER or compact bytes that are not a valid ECDSA signature.",
    fix: "If it repeats, report it.",
  },
  signatureScalarType: {
    id: "core.signature.scalar-type",
    kind: "reason",
    group: "Signatures",
    template: "r and s must be bigints",
    cause:
      "A provider plugin returned a signature as `{ r, s }` whose values are not `bigint`, for example JavaScript numbers, which cannot hold a 256-bit scalar exactly.",
    fix: "Report it to the provider plugin.",
  },
  signatureRange: {
    id: "core.signature.range",
    kind: "reason",
    group: "Signatures",
    template: "r or s is outside the range [1, n - 1]",
    cause:
      "A signature's `r` or `s` is 0, or not below the secp256k1 curve order, so it cannot be valid.",
    fix: "For a signature from a provider, run again; for one given to `kms verify`, check that it was copied whole.",
  },
  signatureNoRecovery: {
    id: "core.signature.no-recovery",
    kind: "reason",
    group: "Signatures",
    template: "the signature does not recover to the expected public key",
    cause:
      "No recovery bit gives back the key's public key: the signature is from another key, or over other data.",
    fix: "Check that the key id names the key you expect.",
  },
  signatureNoVerify: {
    id: "core.signature.no-verify",
    kind: "reason",
    group: "Signatures",
    template: "the signature does not verify against the expected public key",
    cause: "The signature does not verify against the key's public key over the digest.",
    fix: "Check that the key id names the key you expect.",
  },
  signatureHex: {
    id: "core.signature.hex",
    kind: "reason",
    group: "Signatures",
    template: "the signature must be 0x-prefixed hex",
    cause:
      "The signature given to `kms verify` does not start with `0x` or has a character that is not hex.",
    fix: "Pass the 65-byte signature as `0x` and 130 hex digits.",
  },
  signatureRpcLength: {
    id: "core.signature.rpc-length",
    kind: "reason",
    group: "Signatures",
    template: "expected a 65-byte signature (r || s || v, 130 hex digits), got {digits} hex digits",
    cause: "The signature given to `kms verify` is not 65 bytes long.",
    fix: "Pass the whole `r || s || v` signature, as `eth_sign` and `kms sign` print it.",
  },
  signatureV: {
    id: "core.signature.v",
    kind: "reason",
    group: "Signatures",
    template: "v must be 0 or 1, 27 or 28, or 35 or more (EIP-155), got {v}",
    cause: "The last byte of the signature is not a recovery id in any form Ethereum uses.",
    fix: "Check that the signature was copied whole and is an Ethereum signature.",
  },
  signatureNoPublicKey: {
    id: "core.signature.no-public-key",
    kind: "reason",
    group: "Signatures",
    template: "no public key recovers from the signature",
    cause:
      "The signature's `r` is not the x coordinate of a curve point, so no signer can be recovered.",
    fix: "Check that the signature was copied whole.",
  },
  signatureDigestLength: {
    id: "core.signature.digest-length",
    kind: "reason",
    group: "Signatures",
    template: "expected a 32-byte digest, got {length} bytes",
    cause: "A signature check was asked to work on a digest that is not 32 bytes.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  signatureNotConfiguredAddress: {
    id: "core.signature.not-configured-address",
    kind: "reason",
    group: "Signatures",
    template: "the signature does not recover to the configured address",
    cause:
      "A provider that reports only an address signed, and no recovery bit gives the `address` pin: the key is not the one the pin names.",
    fix: "Check the key id and the `address` pin.",
  },

  // Accounts.
  sameAccount: {
    id: "core.accounts.same-account",
    kind: "error",
    group: "Accounts",
    template: "{name} and {other} are the same account ({address}); list each key once",
    cause:
      "Two keys of the network give the same address, for example an alias and the key ARN it points to.",
    fix: "Remove one of them from the network's `kmsAccounts` or from `--kms`.",
  },
  kmsAccountSentence: {
    id: "core.accounts.unknown-account-hint",
    kind: "reason",
    group: "Accounts",
    template: "The KMS account on this network is {list}.",
    cause:
      "A signing request named an account that is neither a KMS account nor one of the node's accounts. The plugin appends this sentence to the error from Hardhat or the node, so you can see which account it signs for. `{list}` is the address, or the first ten and a count.",
    fix: "Send from the address listed, or add the key of the account you meant to the network's `kmsAccounts`.",
  },
  kmsAccountsSentence: {
    id: "core.accounts.unknown-account-hint-many",
    kind: "reason",
    group: "Accounts",
    template: "The KMS accounts on this network are {list}.",
    cause:
      "As above, for a network with several KMS accounts. `{list}` holds the first ten addresses, then how many more there are.",
    fix: "Send from one of the addresses listed, or add the key of the account you meant to the network's `kmsAccounts`.",
  },
  alreadyListed: {
    id: "core.accounts.already-listed",
    kind: "error",
    group: "Accounts",
    template: "{name} is already {path}{named}; use one of them",
    cause:
      "A `--kms` key names the same KMS key as one of the network's `kmsAccounts`. `{path}` is that entry's place, such as `networks.sepolia.kmsAccounts[0]`, and `{named}` adds its name in brackets when it has one.",
    fix: "Drop `--kms`, or remove the key from the network's `kmsAccounts`.",
  },
  addressBytes: {
    id: "core.accounts.address-bytes",
    kind: "error",
    group: "Accounts",
    template: "pass the address as the hex string {address}, not as a byte array",
    cause:
      "An `eth_sign`, `personal_sign` or `eth_signTypedData_v4` request names a KMS account as 20 bytes (a `Buffer` or a `Uint8Array`). Hardhat's simulated network and JSON-RPC nodes take the address only as a hex string. Nothing was signed.",
    fix: "Pass the address as a 0x-prefixed hex string, for example with viem's `bytesToHex`.",
  },

  // Transactions.
  txNotObject: {
    id: "core.tx.not-object",
    kind: "error",
    group: "Transactions",
    template: "the transaction must be an object",
    cause:
      "The first parameter of `eth_sendTransaction` or `eth_signTransaction` is not an object.",
    fix: "Pass the transaction as an object of `eth_sendTransaction` fields.",
  },
  txSelfAuthorizationNonce: {
    id: "core.tx.self-authorization-nonce",
    kind: "error",
    group: "Transactions",
    template:
      "authorizationList[{index}] is signed by the sender for nonce {nonce}, but the final transaction requires nonce {expected}; nothing was signed",
    cause:
      "EIP-7702 increments the sender nonce before processing authorizations. Each valid self-authorization increments it again. The authorization nonce does not match.",
    fix: "Choose the transaction nonce explicitly and sign the self-authorization for that nonce plus 1. Use consecutive nonces for additional self-authorizations, all below 2^64 - 1.",
  },
  txSelfAuthorizationChain: {
    id: "core.tx.self-authorization-chain",
    kind: "error",
    group: "Transactions",
    template:
      "authorizationList[{index}] is signed by the sender for chain {requested}, but the transaction is for chain {chainId}; nothing was signed",
    cause: "A self-authorization names another chain. The node would skip it.",
    fix: "Sign the authorization for the transaction chain, or deliberately use chain 0.",
  },
  txSelfAuthorizationDelegate: {
    id: "core.tx.self-authorization-delegate",
    kind: "error",
    group: "Transactions",
    template:
      "authorizationList[{index}] is signed by the sender and delegates it to {delegate} on chain {chain}, which the allowedDelegates of key {keyName} do not allow; nothing was signed",
    cause:
      "The transaction carries an EIP-7702 authorization signed by the sending KMS key, and its delegate is not in the key's `allowedDelegates` for the authorization's chain. A chain-0 authorization matches only entries with `chains: \"all\"`. Authorizations signed by other accounts are not checked.",
    fix: "Remove the authorization, or add the delegate to the key's `allowedDelegates` for that chain if it is intended.",
  },
  txAuthorizationFees: {
    id: "core.tx.authorization-fees",
    kind: "error",
    group: "Transactions",
    template:
      "fee history could not be read; EIP-7702 needs EIP-1559 fees. Set maxFeePerGas and maxPriorityFeePerGas explicitly",
    cause:
      "Automatic EIP-1559 fee estimation is unavailable for a transaction with an authorization list. A legacy gas price cannot fund an EIP-7702 transaction.",
    fix: "Retry when the node can serve eth_feeHistory, or provide both EIP-1559 fee fields explicitly.",
  },
  txBlob: {
    id: "core.tx.blob",
    kind: "error",
    group: "Transactions",
    template:
      "blob transactions (EIP-4844) cannot be signed with KMS accounts; send them from another account",
    cause:
      'The transaction has blobs, blob versioned hashes, `maxFeePerBlobGas` or type 3 (`0x3` in any case or with leading zeros, the number 3, `"3"` or `eip4844`, with or without surrounding whitespace). The plugin does not sign blob transactions. This check runs before the checks of `core.tx.unsupported-type` and `core.tx.type-mismatch`.',
    fix: "Send blob transactions from another account.",
  },
  txUnsupportedType: {
    id: "core.tx.unsupported-type",
    kind: "error",
    group: "Transactions",
    template:
      "transaction type {type} is not supported; KMS accounts sign types 0x0, 0x1, 0x2 and 0x4. Nothing was signed.",
    cause:
      "The transaction's `type` is a number other than 0, 1, 2, 3 or 4, such as a chain-specific type: Celo's fee-currency type `0x7b` (viem's Celo formatter sends it when `feeCurrency` is set), zkSync's EIP-712 type `0x71`, or the OP Stack deposit type `0x7e`. Before, such a request was signed as a plain transaction of the type its fee fields give, without its chain-specific fields. A `type` counts as a number when it is a hex quantity (either case, any leading zeros), a decimal string, a non-negative integer or a bigint, with or without surrounding whitespace. Any other `type`, such as viem's `\"legacy\"`, is ignored: the fields decide. The check runs before any request to the node.",
    fix: "Send the transaction from another account, or as type `0x0`, `0x1`, `0x2` or `0x4`.",
  },
  txNullField: {
    id: "core.tx.null-field",
    kind: "error",
    group: "Transactions",
    template:
      "the transaction's {field} is null; set a value or leave the field out. Nothing was signed.",
    cause:
      'The transaction sets `gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`, `accessList` or `authorizationList` to `null`, and the fill would not replace it. These fields take a value or are left out; `null` is neither. Before, such a request failed with a raw schema error. One `null` is still accepted, as Hardhat accepts it: with the network\'s `gasPrice` set to `"auto"`, no `gasPrice` and the other EIP-1559 field left out, a `null` `maxFeePerGas` or `maxPriorityFeePerGas` is filled like an absent one. The check runs after those of `core.tx.blob` and `core.tx.unsupported-type`, and before `core.tx.type-mismatch` and any request to the node. `{field}` is the first such field, in that order.',
    fix: "Set the field to a value, or leave it out to let the plugin fill it.",
  },
  txRequestTypeMismatch: {
    id: "core.tx.type-mismatch",
    kind: "error",
    group: "Transactions",
    template:
      "the transaction asks for type {requested}, but its fields make it type {actual}. Nothing was signed. {hint}",
    cause:
      'The transaction\'s `type` disagrees with the fee fields the caller set: `gasPrice`, `maxFeePerGas` or `maxPriorityFeePerGas`. The fields make it type 0x4 with an `authorizationList`, else 0x2 with an EIP-1559 fee field, else 0x1 with an `accessList`, else 0x0. For example, type `0x2` with `gasPrice` would be signed as legacy. Type `0x1` with `gasPrice` and no `accessList` is not a mismatch: it is signed as type 0x1 with an empty access list. A `type` with no fee field is not checked: the plugin fills the fees and the type follows them. A `null` fee or list field fails earlier, with `core.tx.null-field`, except a lone `null` EIP-1559 fee field that the automatic fee fill replaces: it counts as an EIP-1559 fee field, so `type: "0x0"` with `maxFeePerGas: null` is a mismatch. The check runs before any request to the node. `{hint}` says what to change, naming only the fields the transaction sets.',
    fix: "Set the fee fields of the type asked for (`gasPrice` for 0x0 and 0x1, `maxFeePerGas` and `maxPriorityFeePerGas` for 0x2 and 0x4), add an `authorizationList` for type 0x4, or remove `type` to let the fields decide.",
  },
  txNoGas: {
    id: "core.tx.no-gas",
    kind: "error",
    group: "Transactions",
    template: "the transaction has no gas limit",
    cause: "The filled transaction has no gas limit. The fill always sets one, so this is a guard.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  txWrongChain: {
    id: "core.tx.wrong-chain",
    kind: "error",
    group: "Transactions",
    template: "the transaction is for chain {requested}, but this network is chain {chainId}",
    cause:
      "The transaction's `chainId` differs from the chain of the network it is sent on. Nothing was signed.",
    fix: "Remove `chainId` from the transaction, or send it on the network of that chain.",
  },
  txNoLatestBlock: {
    id: "core.tx.no-latest-block",
    kind: "error",
    group: "Transactions",
    template: "the node returned no latest block",
    cause: 'The node answered `eth_getBlockByNumber("latest")` with something other than a block.',
    fix: "Check the network's RPC URL and that the node is synced.",
  },
  txNoBlockGasLimit: {
    id: "core.tx.no-block-gas-limit",
    kind: "error",
    group: "Transactions",
    template: "the {blockTag} block has no gasLimit",
    cause: "The node's block, read to cap the gas limit, has no `gasLimit` field.",
    fix: "Check the network's RPC URL, or set `gas` on the transaction.",
  },
  txAuthorizationScalar: {
    id: "core.tx.authorization-scalar",
    kind: "error",
    group: "Transactions",
    template:
      "authorizationList[{index}].{field} must be between 1 and the secp256k1 curve order minus 1",
    cause:
      "An EIP-7702 authorization's `r` or `s` is 0 or not below the curve order, so the signature cannot be valid. Nothing was sent.",
    fix: "Sign the authorization again, for example with `kms sign-auth`.",
  },
  txNotPlainData: {
    id: "core.tx.not-plain-data",
    kind: "error",
    group: "Transactions",
    template: "the transaction must be plain data (JSON values, bigints and byte arrays)",
    cause:
      "The request holds a value that `structuredClone` cannot copy, such as a function, a symbol or a getter that throws.",
    fix: "Pass plain values: strings, numbers, bigints, byte arrays, arrays and objects.",
  },
  txFromBytes: {
    id: "core.tx.from-bytes",
    kind: "error",
    group: "Transactions",
    template: "pass `from` as the hex string {address}, not as a byte array",
    cause:
      "The transaction's `from` names a KMS account as 20 bytes (a `Buffer` or a `Uint8Array`). Hardhat's simulated network and JSON-RPC nodes take `from` only as a hex string. Nothing was signed or sent.",
    fix: "Pass `from` as a 0x-prefixed hex string, for example with viem's `bytesToHex`.",
  },
  nodeAnswerNotString: {
    id: "core.tx.node-answer-not-string",
    kind: "error",
    group: "Transactions",
    template: "the node's {what} answer is not a string",
    cause: "The node answered a fee or gas request with something other than a hex string.",
    fix: "Check the network's RPC URL; the node may not be an Ethereum JSON-RPC node.",
  },
  txNoFee: {
    id: "core.tx.no-fee",
    kind: "error",
    group: "Transactions",
    template: "the transaction has no gasPrice, maxFeePerGas or maxPriorityFeePerGas",
    cause:
      "The filled transaction has no fee field. The fill always sets one, so this is a guard Hardhat has too.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  txGasPrice7702: {
    id: "core.tx.gas-price-7702",
    kind: "error",
    group: "Transactions",
    template: "an EIP-7702 transaction (authorizationList) cannot have a gasPrice",
    cause:
      "The transaction has an `authorizationList` and a `gasPrice`. EIP-7702 transactions use EIP-1559 fees.",
    fix: "Remove `gasPrice`, or set `maxFeePerGas` and `maxPriorityFeePerGas` instead.",
  },
  txAuthorizationNoTo: {
    id: "core.tx.authorization-no-to",
    kind: "error",
    group: "Transactions",
    template:
      "an EIP-7702 transaction (authorizationList) needs `to`: it cannot create a contract. Nothing was sent to the node",
    cause:
      "The transaction has an `authorizationList` and no `to`, or `to: null`. EIP-7702 transactions cannot create contracts. Hardhat's local accounts refuse the same request (HHE726).",
    fix: "Set `to`, or remove `authorizationList` to deploy a contract.",
  },
  txAuthorizationListEmpty: {
    id: "core.tx.authorization-list-empty",
    kind: "error",
    group: "Transactions",
    template:
      "the authorizationList of an EIP-7702 transaction is empty: it needs at least one authorization. Nothing was sent to the node",
    cause:
      "The transaction has `authorizationList: []`. An EIP-7702 transaction must carry at least one authorization. Hardhat's local accounts refuse the same request (HHE727).",
    fix: "Add an authorization, or remove `authorizationList` to send an EIP-1559 transaction.",
  },
  txInvalidFields: {
    id: "core.tx.invalid-fields",
    kind: "error",
    group: "Transactions",
    template: "the {type} transaction has invalid fields: {problems}. Nothing was signed",
    cause:
      "micro-eth-signer, which builds the unsigned transaction, refused these fields. Hardhat's local accounts build it with the same code and refuse the same fields. Numbers of 21 digits or more in a reason are left out, so the message holds no signature value.",
    fix: "Correct each field the message names.",
  },
  txBothFees: {
    id: "core.tx.both-fees",
    kind: "error",
    group: "Transactions",
    template: "the transaction cannot have both gasPrice and maxFeePerGas or maxPriorityFeePerGas",
    cause: "The transaction mixes legacy and EIP-1559 fee fields.",
    fix: "Keep `gasPrice` alone, or `maxFeePerGas` with `maxPriorityFeePerGas`.",
  },
  txNoMaxFee: {
    id: "core.tx.no-max-fee",
    kind: "error",
    group: "Transactions",
    template: "the transaction has maxPriorityFeePerGas but no maxFeePerGas",
    cause:
      "The filled transaction has `maxPriorityFeePerGas` without `maxFeePerGas`. The fill completes the missing field, so this is a guard Hardhat has too.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  txNoPriorityFee: {
    id: "core.tx.no-priority-fee",
    kind: "error",
    group: "Transactions",
    template: "the transaction has maxFeePerGas but no maxPriorityFeePerGas",
    cause:
      "The filled transaction has `maxFeePerGas` without `maxPriorityFeePerGas`. The fill completes the missing field, so this is a guard Hardhat has too.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  txCreationNoData: {
    id: "core.tx.creation-no-data",
    kind: "error",
    group: "Transactions",
    template: "a contract creation (no `to`) needs `data`",
    cause:
      "The transaction has neither `to` nor `data`, so it would create a contract with no code.",
    fix: "Set `to` to send to an account, or `data` to deploy a contract.",
  },
  txBothMaxFees: {
    id: "core.tx.both-max-fees",
    kind: "error",
    group: "Transactions",
    template: "an EIP-1559 or EIP-7702 transaction needs both maxFeePerGas fields",
    cause:
      "The transaction to sign is an EIP-1559 or EIP-7702 transaction without both fee fields. The fill always sets both, so this is a guard.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  txNoRecovery: {
    id: "core.tx.no-recovery",
    kind: "error",
    group: "Transactions",
    template: "the signed transaction does not recover to {from}; nothing was sent",
    cause:
      "The final check of a signed transaction found another sender than the account. The transaction is not sent.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  txNotFrom: {
    id: "core.tx.not-from",
    kind: "error",
    group: "Transactions",
    template: "the filled transaction is not from {from}",
    cause: "After the fill, the transaction's `from` is not the account that was asked to sign it.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  sendWaitersFull: {
    id: "core.tx.send-waiters-full",
    kind: "error",
    group: "Transactions",
    template:
      "Too many sends from {account} are waiting: the limit is {limit}. This send was not signed or sent.",
    cause:
      "Sends from one account on one chain run one at a time, and too many were already waiting.",
    fix: "Wait for earlier sends before starting more, for example by awaiting each one.",
  },
  sendStalled: {
    id: "core.tx.send-stalled",
    kind: "error",
    group: "Transactions",
    template:
      "A send from {account} waited {seconds} s for the account's earlier sends, and none finished. This send was not signed or sent.",
    cause:
      "An earlier send from the same account is stuck, for example waiting for a KMS approval or a node that does not answer.",
    fix: "Find the earlier send that does not finish, and send this one again.",
  },
  sendReentrant: {
    id: "core.tx.send-reentrant",
    kind: "error",
    group: "Transactions",
    template:
      "A send from {account} was made from inside an earlier send from the same account on that chain, for example by a hook during its fill or broadcast. It would wait for itself, so it was not signed or sent.",
    cause:
      "Code that runs during a send, such as a network hook, sent from the same account again.",
    fix: "Send the second transaction after the first one returns.",
  },
  accountNonceReentrant: {
    id: "core.account.nonce-reentrant",
    kind: "error",
    group: "Library accounts",
    template:
      "A transaction of the library account {account} was started from inside an earlier send from the same account on that chain, for example by a hook during its fill or broadcast. It would wait for itself, so it was not signed or sent.",
    cause:
      "Code that runs during a send, such as a network hook, sent a transaction with a connection.kms.getAccount account of the same address.",
    fix: "Send the second transaction after the first one returns.",
  },
  rawSendReentrant: {
    id: "core.tx.raw-send-reentrant",
    kind: "error",
    group: "Transactions",
    template:
      "A raw transaction from {account} was sent from inside an earlier send from the same account on that chain, for example by a hook during its fill or broadcast. It would wait for itself, so it was not sent.",
    cause:
      "Code that runs during a send, such as a network hook, sent a transaction that the same account signed outside the plugin, for example with a connection.kms.getAccount account.",
    fix: "Send the second transaction after the first one returns.",
  },
  walletSendRefused: {
    id: "core.tx.wallet-send-refused",
    kind: "error",
    group: "Transactions",
    template:
      "wallet_sendTransaction is not available for the KMS account {address}. Send with eth_sendTransaction, which the plugin signs.",
    cause:
      "A `wallet_sendTransaction` request named a KMS account as `from`. The plugin sends a KMS account's transactions through `eth_sendTransaction` only, so it answers this method with JSON-RPC error -32601 (method not found) and does not pass it to the node. viem sends it once after an `eth_sendTransaction` error such as -32000, and then throws the first error.",
    fix: "If viem sent it, nothing: viem throws the `eth_sendTransaction` error instead. If your code sends it, send `eth_sendTransaction`.",
  },
  walletSendCallsRefused: {
    id: "core.tx.wallet-send-calls-refused",
    kind: "error",
    group: "Transactions",
    template:
      "wallet_sendCalls is not available for the KMS account {address}. Pass experimental_fallback: true to viem's sendCalls, or send each call as its own transaction.",
    cause:
      "A `wallet_sendCalls` (EIP-5792) request named a KMS account as `from`. The plugin sends a KMS account's transactions through `eth_sendTransaction` only, so it answers this method with JSON-RPC error -32601 (method not found) and does not pass it to the node. viem's `sendCalls` sends it.",
    fix: "Pass `experimental_fallback: true` to viem's `sendCalls`: on -32601 viem sends each call with `eth_sendTransaction`, and the KMS key signs each one. Or send each call yourself with `sendTransaction`.",
  },
  txRefusedProviderCopy: {
    id: "core.tx.refused-provider-copy",
    kind: "error",
    group: "Transactions",
    template:
      "the node refused the transaction with nonce {nonce} ({reason}, code {code}), but {who} keeps it signed ({request}), and anyone who can read it there can broadcast it once the node would take it. This connection's sends from the account skip nonce {nonce} until it is mined, or the provider's copy itself reaches the node through the connection. Fix the cause, such as the account's funds or the fees, then send a replacement transaction with nonce {nonce}, or broadcast that signed transaction",
    cause:
      "The key's adapter declares that the provider keeps what it signs (`signTransactionOutlivesAbort`), as Turnkey's `sign_transaction` does, and the node refused the signed transaction for certain, for example for insufficient funds or too low a fee. The provider's copy stays valid, and becomes acceptable once the cause goes away, so the plugin keeps its nonce held rather than sign a second transaction with it. The message names the kind of refusal (`insufficient funds`, `fee too low` or `refused`) and the node's JSON-RPC code, never the node's text. When the node's mined transaction count is above the nonce, the nonce is used on chain and the copy can never be valid, so the node's answer goes on unchanged instead; an answer that the node already knows the transaction counts as sent.",
    fix: 'Fix what the node refused, then send a replacement with the nonce the message names, with an explicit `nonce`, or broadcast the provider\'s signed transaction. For Turnkey, it is the completed activity the message names. See the Turnkey setup guide, "When Turnkey does not answer in time".',
  },
  sendConnectionClosed: {
    id: "core.tx.connection-closed",
    kind: "error",
    group: "Transactions",
    template:
      "{method}: the connection to network {network} closed before the transaction was broadcast, so nothing was sent. Send it again on an open connection",
    cause:
      "`connection.close()` ran while the send waited for its KMS signature or for an earlier send from the same account. A closed connection keeps no record of the account's nonces, so the plugin does not broadcast through it: a send on another connection could take the same nonce.",
    fix: "Wait for each send to return before you close its connection, or send again on an open connection from `network.create()`.",
  },
  sendOutcomeUnknown: {
    id: "core.tx.outcome-unknown",
    kind: "error",
    group: "Transactions",
    template:
      "{method}: transaction {hash} was handed to the node, but no answer came back ({cause}). It may still be mined: look it up by its hash before sending another transaction. Repeating the same request within {seconds} s sends the same transaction again.",
    cause:
      "The signed transaction reached the node, but the connection failed before the node answered, so the plugin cannot tell whether it was accepted.",
    fix: "Look the hash up on the network. If it is not there, repeat the request: within the time the message gives, the same signed transaction is sent again.",
  },

  // Typed data.
  typedDataInvalid: {
    id: "core.typed-data.invalid",
    kind: "error",
    group: "Typed data",
    template: "the typed data is invalid: {reason}",
    cause:
      "The EIP-712 typed data does not have the shape EIP-712 requires. The reason is one of the typed-data reasons below.",
    fix: "Fix the typed data as the reason says.",
  },
  typedDataNotJson: {
    id: "core.typed-data.not-json",
    kind: "error",
    group: "Typed data",
    template: "the typed data is not valid JSON",
    cause: "Typed data given as a string, as `eth_signTypedData_v4` takes it, is not JSON.",
    fix: "Pass `JSON.stringify(typedData)`, or the typed data object.",
  },
  typedDataUnreadable: {
    id: "core.typed-data.unreadable",
    kind: "error",
    group: "Typed data",
    template: "the typed data could not be read ({errorName}); it may be nested too deeply",
    cause:
      "Reading the typed data JSON failed with something other than a syntax error, usually a stack overflow on very deep nesting.",
    fix: "Flatten the typed data.",
  },
  typedDataChainMismatchNetwork: {
    id: "core.typed-data.chain-mismatch",
    kind: "error",
    group: "Typed data",
    template:
      "the typed data is for chain {domainChain}, but {name} is chain {chainId}. Set `kms.allowCrossChainTypedData: true` to sign typed data for other chains",
    cause:
      "The typed data's `domain.chainId` is another chain than the network's. A signature for it could act on that chain.",
    fix: "Sign it on the network of that chain, or set `kms.allowCrossChainTypedData: true` if signing for other chains is intended.",
  },
  typedDataPlainData: {
    id: "core.typed-data.plain-data",
    kind: "reason",
    group: "Typed data",
    template: "the typed data must be plain data (JSON values and bigints)",
    cause:
      "The typed data holds a value that `structuredClone` cannot copy, such as a function, a symbol or a getter that throws.",
    fix: "Pass plain values.",
  },
  typedDataObject: {
    id: "core.typed-data.object",
    kind: "reason",
    group: "Typed data",
    template: "the typed data must be an object",
    cause: "The typed data is not an object.",
    fix: "Pass an object with `types`, `primaryType`, `domain` and `message`.",
  },
  typedDataTypes: {
    id: "core.typed-data.types",
    kind: "reason",
    group: "Typed data",
    template: "`types` must map each type name to a list of {name, type}",
    cause: "The typed data's `types` is missing or not an object.",
    fix: "Give `types` an entry per struct, each a list of `{ name, type }` fields.",
  },
  typedDataTypeFields: {
    id: "core.typed-data.type-fields",
    kind: "reason",
    group: "Typed data",
    template: "`types.{typeName}` must be a list of {name, type}",
    cause: "One entry of `types` is not a list of `{ name, type }` fields with string values.",
    fix: "Fix the struct the message names.",
  },
  typedDataShape: {
    id: "core.typed-data.shape",
    kind: "reason",
    group: "Typed data",
    template: "the typed data needs a string `primaryType` and object `domain` and `message`",
    cause: "The typed data lacks `primaryType`, `domain` or `message`, or one has the wrong type.",
    fix: "Add the missing field.",
  },
  typedDataEncoder: {
    id: "core.typed-data.encoder",
    kind: "reason",
    group: "Typed data",
    template: "{message}",
    cause:
      "The EIP-712 encoder refused the typed data, for example for an unknown type or a value that does not fit its type. The message is the encoder's own, cut to 200 characters, ending in `...`, because it can quote a whole value.",
    fix: "Fix the type or value the message names.",
  },
  typedDataUnsafeInteger: {
    id: "core.typed-data.unsafe-integer",
    kind: "reason",
    group: "Typed data",
    template:
      "a number {where} is above 2^53 - 1, so JSON cannot hold it exactly; write it as a string",
    cause:
      "The typed data JSON has an integer too large for a JavaScript number, which would be rounded and signed as another value. The message names the key, cut to 40 characters, and never the number, since the file may be another one given by mistake.",
    fix: "Write large integers, such as `uint256` amounts, as decimal or hex strings.",
  },
  chainIdInvalid: {
    id: "core.chain.id-invalid",
    kind: "error",
    group: "Chains",
    template: "{what} is not a chain id: expected a non-negative integer, got {value}",
    cause:
      "A chain id, such as the typed data's `domain.chainId` or `--chain`, is not a non-negative integer.",
    fix: "Use a decimal or `0x` hex integer, such as `11155111`.",
  },
  nodeChainIdNotHex: {
    id: "core.chain.not-hex",
    kind: "error",
    group: "Chains",
    template: "the node answered eth_chainId with {answer}, not a hex quantity",
    cause: "The network's node answered `eth_chainId` with something other than a hex number.",
    fix: "Check the network's RPC URL; the node may not be an Ethereum JSON-RPC node.",
  },
  nodeChainIdMismatch: {
    id: "core.chain.mismatch",
    kind: "error",
    group: "Chains",
    template: "the network config sets chainId {configured}, but the node reports {chainId}",
    cause:
      "The network's `chainId` in the Hardhat config differs from the chain its node is on, so the URL may point at another chain.",
    fix: "Fix the network's `url` or its `chainId`.",
  },

  // Tasks.
  unknownNetwork: {
    id: "core.task.unknown-network",
    kind: "error",
    group: "Tasks",
    template: 'unknown network "{name}"',
    cause: "`kms accounts` was run with a `--network` that the Hardhat config does not define.",
    fix: "Use a network from `networks` in the config.",
  },
  notHex: {
    id: "core.task.not-hex",
    kind: "error",
    group: "Tasks",
    template: "{what} is not 0x-prefixed hex with an even number of digits",
    cause:
      "A task argument that starts with `0x` is read as bytes, and this one has an odd number of digits or a character that is not hex.",
    fix: "Fix the hex, or drop the `0x` to sign the text as UTF-8.",
  },
  typedDataFileUnreadable: {
    id: "core.task.typed-data-file-unreadable",
    kind: "error",
    group: "Tasks",
    template: "cannot read the typed data file {file} ({errorName})",
    cause: "`--from-file` names a file that cannot be read, for example because it does not exist.",
    fix: "Check the path, relative to the directory the task runs in.",
  },
  keyNameAmbiguous: {
    id: "core.task.key-ambiguous",
    kind: "error",
    group: "Tasks",
    template: '"{name}" names more than one key, from {sources}; rename the key in kms.keys',
    cause: "A key in `kms.keys` has the same name as a `--kms` key, such as `AWS_KMS_KEY_ID`.",
    fix: "Rename the key in `kms.keys`.",
  },
  taskUnknownKeyNoKeys: {
    id: "core.task.unknown-key-none",
    kind: "error",
    group: "Tasks",
    template:
      'unknown key "{name}". No KMS keys are configured: add them to kms.keys or a network\'s kmsAccounts, or pass --kms.',
    cause: "A `kms` task was given a key name, but no keys are configured.",
    fix: "Add keys to the config, or pass `--kms` with the provider's environment variables.",
  },
  taskUnknownKeySuggested: {
    id: "core.task.unknown-key-suggested",
    kind: "error",
    group: "Tasks",
    template: 'unknown key "{name}". Did you mean "{suggestions}"? Known keys: {known}.',
    cause:
      "A `kms` task was given a key name that differs from a configured one only in case. Names are case-sensitive.",
    fix: "Use the suggested name.",
  },
  taskUnknownKey: {
    id: "core.task.unknown-key",
    kind: "error",
    group: "Tasks",
    template: 'unknown key "{name}". Known keys: {known}.',
    cause: "A `kms` task was given a key name that is not configured.",
    fix: "Use one of the names listed. `npx hardhat kms accounts` lists every key.",
  },
  signNoRecovery: {
    id: "core.task.sign-no-recovery",
    kind: "error",
    group: "Tasks",
    template: "the signature does not recover to the key's address",
    cause:
      "`kms sign` checks the signature it prints against the key's address, and the check failed.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  fromFileNeedsData: {
    id: "core.task.from-file-needs-data",
    kind: "error",
    group: "Tasks",
    template: "--from-file requires --data",
    cause: "`--from-file` reads typed data from a file, so it works only with `--data`.",
    fix: "Add `--data`, or pass the message itself without `--from-file`.",
  },
  noHashWithData: {
    id: "core.task.no-hash-with-data",
    kind: "error",
    group: "Tasks",
    template: "--no-hash cannot be combined with --data",
    cause: "`kms sign` signs a raw digest with `--no-hash` and typed data with `--data`, not both.",
    fix: "Drop one of the two options.",
  },
  chainOptionsNeedData: {
    id: "core.task.chain-options-need-data",
    kind: "error",
    group: "Tasks",
    template: "--chain and --allow-cross-chain apply only to --data",
    cause: "The chain check of `kms sign` applies only to typed data.",
    fix: "Add `--data`, or drop `--chain` and `--allow-cross-chain`.",
  },
  signChainAndNetwork: {
    id: "core.task.sign-chain-and-network",
    kind: "error",
    group: "Tasks",
    template: "pass --chain or --network, not both",
    cause:
      "`kms sign --data` compares the typed data's chain with `--chain` or with the network's, and both were given.",
    fix: "Keep one. `--network` can also come from the `HARDHAT_NETWORK` environment variable.",
  },
  noHashDigestLength: {
    id: "core.task.no-hash-digest-length",
    kind: "error",
    group: "Tasks",
    template: "--no-hash needs a {expected}-byte digest, got {length} bytes",
    cause: "`kms sign --no-hash` signs a digest as given, and the hex is not 32 bytes.",
    fix: "Pass a 32-byte hash as `0x` and 64 hex digits.",
  },
  yesNeedsNoHash: {
    id: "core.task.yes-needs-no-hash",
    kind: "error",
    group: "Tasks",
    template: "--yes applies only to --no-hash",
    cause:
      "`kms sign` asks a question only before it signs a raw digest, so `--yes` has nothing to skip for a message or typed data.",
    fix: "Drop `--yes`, or add `--no-hash` if the input is a 32-byte digest.",
  },
  rawDigestDeclined: {
    id: "core.task.raw-digest-declined",
    kind: "error",
    group: "Tasks",
    template: "the raw digest was not signed: the question was not answered with y or yes",
    cause:
      "`kms sign --no-hash` asked at the terminal before signing, and the answer was not `y` or `yes`: `n`, an empty line, another word, or input that closed. Nothing was sent to the KMS for signing.",
    fix: "Run the task again and answer `y` if you computed the digest yourself and know what it authorizes.",
  },
  rawDigestNoTerminal: {
    id: "core.task.raw-digest-no-terminal",
    kind: "error",
    group: "Tasks",
    template:
      'without a terminal, --no-hash signs only with a key that sets allowRawDigests: true, and with --yes. Key "{name}" does not set allowRawDigests: true, and --yes was not passed',
    cause:
      "`kms sign --no-hash` ran without a terminal on standard input and standard error, so it could not ask. A raw digest can be any transaction, permit or EIP-7702 authorization, so without a person the key must opt in and the run must pass `--yes`.",
    fix: "Run the task at a terminal and answer the question. To sign raw digests in CI or from code, set `allowRawDigests: true` on the key in the Hardhat config and pass `--yes`.",
  },
  rawDigestNotAllowed: {
    id: "core.task.raw-digest-not-allowed",
    kind: "error",
    group: "Tasks",
    template:
      'without a terminal, --no-hash signs only with a key that sets allowRawDigests: true. Key "{name}" does not set it, so --yes cannot skip the question',
    cause:
      "`kms sign --no-hash --yes` ran without a terminal for a key without `allowRawDigests: true`. `--yes` skips the question only for a key that opts in.",
    fix: "Set `allowRawDigests: true` on the key in the Hardhat config if it should sign raw digests without a person, or run the task at a terminal and answer the question.",
  },
  rawDigestNeedsYes: {
    id: "core.task.raw-digest-needs-yes",
    kind: "error",
    group: "Tasks",
    template:
      'without a terminal, --no-hash needs --yes. Key "{name}" sets allowRawDigests: true, and --yes was not passed',
    cause:
      "`kms sign --no-hash` ran without a terminal for a key with `allowRawDigests: true`. Without a terminal, each run confirms the raw digest with `--yes`.",
    fix: "Pass `--yes`, or run the task at a terminal and answer the question.",
  },
  rawDigestCommandLineKey: {
    id: "core.task.raw-digest-command-line-key",
    kind: "error",
    group: "Tasks",
    template:
      'key "{name}" comes from --kms and has no config, so it cannot set allowRawDigests: true. Without a terminal, --no-hash cannot sign with it',
    cause:
      "`kms sign --no-hash` ran without a terminal with a key chosen with `--kms`. Such a key has no config entry, so it cannot opt in to raw digests, and only a person at a terminal can approve one.",
    fix: "Run the task at a terminal and answer the question, or add the key to `kms.keys` with `allowRawDigests: true` and pass `--yes`.",
  },
  signNoChainToCompare: {
    id: "core.task.sign-no-chain",
    kind: "error",
    group: "Tasks",
    template:
      "the typed data is for chain {domainChain}, and there is no chain to compare it with. Pass --network or --chain, or --allow-cross-chain to sign it for any chain",
    cause:
      "The typed data names a chain, and `kms sign` was given neither `--network` nor `--chain` to check it against.",
    fix: "Pass the chain the signature is for, or `--allow-cross-chain`.",
  },
  typedDataChainMismatchTask: {
    id: "core.task.sign-chain-mismatch",
    kind: "error",
    group: "Tasks",
    template:
      "the typed data is for chain {domainChain}, but {name} is chain {chainId}. Pass --allow-cross-chain to sign it for another chain",
    cause: "The typed data's `domain.chainId` differs from `--chain` or the network's chain.",
    fix: "Use the network or `--chain` of that chain, or `--allow-cross-chain` if signing for another chain is intended.",
  },
  verifyInvalidSignature: {
    id: "core.task.verify-invalid-signature",
    kind: "error",
    group: "Tasks",
    template: "invalid signature: {reason}",
    cause:
      "The signature given to `kms verify` cannot be read or recovered. The reason is one of the signature reasons above.",
    fix: "Pass the 65-byte `r || s || v` signature as `0x` and 130 hex digits.",
  },
  verifyAddressAndKey: {
    id: "core.task.verify-address-and-key",
    kind: "error",
    group: "Tasks",
    template: "pass either --address or --key, not both",
    cause:
      "`kms verify` compares the signer with one expected account, and both options were given.",
    fix: "Keep one of the two.",
  },
  verifyNoSigner: {
    id: "core.task.verify-no-signer",
    kind: "error",
    group: "Tasks",
    template: "pass the expected signer with --address <address> or --key <key>",
    cause: "`kms verify` needs the account the signature should come from.",
    fix: "Add `--address` or `--key`.",
  },
  verifyAddressInvalid: {
    id: "core.task.verify-address-invalid",
    kind: "error",
    group: "Tasks",
    template: "--address: {reason}",
    cause: "`--address` is not a valid address.",
    fix: "Check the address for a typo, or write it in lowercase.",
  },
  txFileUnreadable: {
    id: "core.task.tx-file-unreadable",
    kind: "error",
    group: "Tasks",
    template: "cannot read the transaction file {file} ({code})",
    cause: "`kms sign-tx` cannot read the file, for example `ENOENT` when it does not exist.",
    fix: "Check the path, relative to the directory the task runs in.",
  },
  txFileNotJson: {
    id: "core.task.tx-file-not-json",
    kind: "error",
    group: "Tasks",
    template: "the transaction file {file} is not valid JSON at line {line}, column {column}",
    cause:
      "The file given to `kms sign-tx` is not JSON, for example another file given by mistake. The message names where the JSON stops being valid and quotes none of the file, which could hold a secret.",
    fix: 'Fix the JSON. Quantities are strings, such as `"0x1"`.',
  },
  txFileNotObject: {
    id: "core.task.tx-file-not-object",
    kind: "error",
    group: "Tasks",
    template:
      "the transaction file {file} must hold one JSON object with eth_sendTransaction fields",
    cause: "The file holds an array, a string or another value instead of one transaction object.",
    fix: 'Put one object in the file, such as `{ "to": "0x…", "value": "0x1" }`.',
  },
  txFileChecksum: {
    id: "core.task.tx-file-checksum",
    kind: "error",
    group: "Tasks",
    template:
      "{field} {value} has a wrong EIP-55 checksum, which usually means a typo. Check the address, or write it in lowercase.",
    cause: "A mixed-case address in the transaction file has a wrong EIP-55 checksum.",
    fix: "Check the address, or write it in lowercase.",
  },
  txFileUnknownFields: {
    id: "core.task.tx-file-unknown-fields",
    kind: "error",
    group: "Tasks",
    template:
      "unknown transaction {fields}{hints}. The fields are those of eth_sendTransaction: {known}.",
    cause:
      "The transaction file has fields that `eth_sendTransaction` does not take, often a viem or ethers name such as `gasLimit`. `{fields}` is `field` or `fields` and the names; `{hints}` is empty or a bracketed list such as `(use gas instead of gasLimit)`.",
    fix: "Rename or remove the fields; the message suggests the right name where it knows one.",
  },
  txFileNotQuantity: {
    id: "core.task.tx-file-not-quantity",
    kind: "error",
    group: "Tasks",
    template: '{field} must be a hex quantity, such as "0x1", got {value}',
    cause:
      "A numeric field in the transaction file is not a `0x` hex string, for example a JSON number.",
    fix: "Write it as a hex string.",
  },
  txFileTypeNotQuantity: {
    id: "core.task.tx-file-type-not-quantity",
    kind: "error",
    group: "Tasks",
    template: 'type must be a hex quantity, such as "0x2"',
    cause: "The transaction file's `type` is not a `0x` hex string.",
    fix: "Write it as a hex string, or remove it to let the fields decide the type.",
  },
  txFileUnsupportedType: {
    id: "core.task.tx-file-unsupported-type",
    kind: "error",
    group: "Tasks",
    template:
      "transaction type {type} is not supported; KMS accounts sign types 0x0, 0x1, 0x2 and 0x4",
    cause: "The transaction file asks for a type the plugin does not sign.",
    fix: "Use type `0x0`, `0x1`, `0x2` or `0x4`.",
  },
  txTypeMismatch: {
    id: "core.task.tx-type-mismatch",
    kind: "error",
    group: "Tasks",
    template:
      "the transaction asks for type {requested}, but its fields make it type {actual}; nothing was signed. Set the fee fields of type {requested}, or remove type.",
    cause:
      "The transaction file's `type` disagrees with its fee fields, for example type `0x2` with `gasPrice`.",
    fix: "Set the fee fields of the type asked for, or remove `type`.",
  },
  signTxNeedsNetwork: {
    id: "core.task.sign-tx-needs-network",
    kind: "error",
    group: "Tasks",
    template:
      "--network is required: the transaction is filled on that network's node, and its chain id is checked against it",
    cause: "`kms sign-tx` fills the nonce, gas and fees from a node, so it needs a network.",
    fix: "Pass `--network <name>`.",
  },
  signTxWrongFrom: {
    id: "core.task.sign-tx-wrong-from",
    kind: "error",
    group: "Tasks",
    template:
      "the transaction's from is {from}, but key {keyName} has the address {address}. Remove from, or name the key of that address.",
    cause: "The transaction file's `from` is not the address of the key the task signs with.",
    fix: "Remove `from`, or pass the key of that address.",
  },
  authChainZero: {
    id: "core.task.auth-chain-zero",
    kind: "error",
    group: "Tasks",
    template:
      "an authorization for chain 0 is valid on every chain where the account's nonce matches. Pass --force to sign it anyway",
    cause: "`kms sign-auth` was asked for a chain-0 authorization, which any chain accepts.",
    fix: "Pass the chain the authorization is for, or `--force` if a chain-0 authorization is intended.",
  },
  authNonceTooLarge: {
    id: "core.task.auth-nonce-too-large",
    kind: "error",
    group: "Tasks",
    template: "the nonce {nonce} is too large: EIP-7702 needs one below 2^64 - 1",
    cause: "The authorization's nonce does not fit EIP-7702's limit.",
    fix: "Pass the account's real nonce, or let the task read it with `--network`.",
  },
  authNoRecovery: {
    id: "core.task.auth-no-recovery",
    kind: "error",
    group: "Tasks",
    template: "the authorization does not recover to the key's address",
    cause:
      "`kms sign-auth` checks the authorization it prints against the key's address, and the check failed.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  authChainAndNetwork: {
    id: "core.task.auth-chain-and-network",
    kind: "error",
    group: "Tasks",
    template:
      "pass --chain or --network, not both. --network can also come from the HARDHAT_NETWORK environment variable",
    cause:
      "`kms sign-auth` takes the chain from `--chain` or from the network, and both were given.",
    fix: "Keep one; unset `HARDHAT_NETWORK` if it set the network.",
  },
  authNoChain: {
    id: "core.task.auth-no-chain",
    kind: "error",
    group: "Tasks",
    template: "pass --chain, or --network to sign for that network's chain",
    cause: "`kms sign-auth` needs the chain the authorization is for.",
    fix: "Add `--chain` or `--network`.",
  },
  authNonceAndSelfBroadcast: {
    id: "core.task.auth-nonce-and-self-broadcast",
    kind: "error",
    group: "Tasks",
    template: "--nonce cannot be combined with --self-broadcast",
    cause:
      "`--self-broadcast` changes the nonce the task reads from the node, so it has no effect with `--nonce`.",
    fix: "Pass the nonce the authorization needs with `--nonce` alone.",
  },
  authNoNonce: {
    id: "core.task.auth-no-nonce",
    kind: "error",
    group: "Tasks",
    template: "pass --nonce, or --network to read the key's pending nonce",
    cause: "`kms sign-auth` needs the account's nonce, and has no network to read it from.",
    fix: "Add `--nonce` or `--network`.",
  },
  authChainTooLarge: {
    id: "core.task.auth-chain-too-large",
    kind: "error",
    group: "Tasks",
    template: "--chain does not fit in 256 bits",
    cause: "`--chain` is larger than any chain id.",
    fix: "Pass the real chain id.",
  },
  authDelegateInvalid: {
    id: "core.task.auth-delegate-invalid",
    kind: "error",
    group: "Tasks",
    template:
      "the delegate {delegate} is not an address: expected 0x and 40 hex digits, with a valid EIP-55 checksum if it is mixed-case",
    cause: "The delegate given to `kms sign-auth` is not an address, or its checksum is wrong.",
    fix: "Check the address for a typo, or write it in lowercase.",
  },
  authNonceInvalid: {
    id: "core.task.auth-nonce-invalid",
    kind: "error",
    group: "Tasks",
    template: "--nonce is not a nonce: expected a non-negative integer, got {value}",
    cause: "`--nonce` is not a decimal or `0x` hex integer.",
    fix: "Pass a non-negative integer.",
  },
  authNodeNonce: {
    id: "core.task.auth-node-nonce",
    kind: "error",
    group: "Tasks",
    template: "the node answered eth_getTransactionCount with something other than a nonce",
    cause:
      "The network's node did not answer `eth_getTransactionCount` with a hex number below 2^64, the largest an account nonce can be (EIP-2681).",
    fix: "Check the network's RPC URL, or pass `--nonce`.",
  },
  authNodeChainTooLarge: {
    id: "core.task.auth-node-chain-too-large",
    kind: "error",
    group: "Tasks",
    template:
      "the node reported a chain id that does not fit in 256 bits, so no authorization can name it. Nothing was signed",
    cause:
      "`kms sign-auth --network` takes the chain from the node when the network config sets no `chainId`, and the node's `eth_chainId` answer is 2^256 or more. EIP-7702 encodes the chain id in 256 bits.",
    fix: "Check the network's RPC URL and node, or set `chainId` in the network config.",
  },
  authNodeCode: {
    id: "core.task.auth-node-code",
    kind: "error",
    group: "Tasks",
    template:
      "the node answered eth_getCode with something other than hex data. Nothing was signed",
    cause:
      "`kms sign-auth --network` reads the code of the account and of the delegate before it asks, and the node's answer was not a `0x` hex string of whole bytes.",
    fix: "Check the network's RPC URL and node. Retry with another node if it persists.",
  },
  authNodeStorage: {
    id: "core.task.auth-node-storage",
    kind: "error",
    group: "Tasks",
    template:
      "the node answered eth_getStorageAt with something other than a 32-byte word. Nothing was signed",
    cause:
      "`kms sign-auth --network` reads the delegate's ERC-1967 implementation slot to tell whether it is a proxy, and the node's answer was not `0x` and at most 64 hex digits.",
    fix: "Check the network's RPC URL and node. Retry with another node if it persists.",
  },
  authNonceStale: {
    id: "core.task.auth-nonce-stale",
    kind: "error",
    group: "Tasks",
    template:
      "the nonce {nonce} is below the account's nonce {latest} on network {network}, so the authorization could never apply. Nothing was signed",
    cause:
      "An EIP-7702 authorization applies only when its nonce equals the account's nonce at that point, and the account's nonce never goes down. The node says the account has already used this nonce.",
    fix: "Drop `--nonce` to let the task read the account's nonce, or pass the nonce the account will have when the transaction runs.",
  },
  authDelegateDelegated: {
    id: "core.task.auth-delegate-delegated",
    kind: "error",
    group: "Tasks",
    template:
      "the delegate {delegate} is itself a delegated account on network {network}: its code starts with 0xef0100. Clients follow one delegation only, so every call to this account would fail. Nothing was signed",
    cause:
      "EIP-7702 clients load the delegate's code once and do not follow a second delegation (EIP-7702, Loops). An account delegated to another delegated account runs nothing.",
    fix: "Delegate to the contract the other account delegates to, not to the account.",
  },
  authDelegatePrecompile: {
    id: "core.task.auth-delegate-precompile",
    kind: "error",
    group: "Tasks",
    template:
      "the delegate {delegate} is in the reserved precompile range 0x01 to 0x1ff: every call to the account would succeed and do nothing. Nothing was signed",
    cause:
      "A delegation to a precompile runs empty code (EIP-7702, Precompiles). The task refuses addresses from 0x01 to 0x1ff, where Ethereum (0x01 to 0x11, and 0x100 for P256VERIFY) and Arbitrum (0x64 to 0xff) place precompiles. No contract can be deployed there.",
    fix: "Check the delegate address. To clear a delegation, use the zero address.",
  },
  authAccountHasCode: {
    id: "core.task.auth-account-has-code",
    kind: "error",
    group: "Tasks",
    template:
      "the account {account} has {size} bytes of contract code on network {network}, which is not a delegation, so nodes would skip the authorization. Nothing was signed",
    cause:
      "EIP-7702 skips an authorization whose authority has code other than a delegation (EIP-7702, Behavior). A key's address normally has no code; this node says it has contract code.",
    fix: "Check the network and the key. If the node is wrong, use another node.",
  },
  authNoTerminal: {
    id: "core.task.auth-no-terminal",
    kind: "error",
    group: "Tasks",
    template:
      "without a terminal, kms sign-auth signs only with --yes, for a delegate in the key's allowedDelegates or the zero address. --yes was not passed. Nothing was signed",
    cause:
      "`kms sign-auth` ran without a terminal on standard input and standard error, so it could not ask. An EIP-7702 authorization lets the delegate's code act for the account, so without a person the delegate must be one the config allows, and the run must say so with `--yes`.",
    fix: "Run the task at a terminal and answer the question. In CI, add the delegate to the key's `allowedDelegates` and pass `--yes`.",
  },
  authNotListedNoTerminal: {
    id: "core.task.auth-not-listed-no-terminal",
    kind: "error",
    group: "Tasks",
    template:
      'without a terminal, --yes signs only for a delegate in the key\'s allowedDelegates or the zero address. Key "{name}" has no allowedDelegates. Nothing was signed',
    cause:
      "`kms sign-auth --yes` ran without a terminal for a key without `allowedDelegates`, so no config names the delegate. A key given with `--kms` has no config, so it cannot have the list either.",
    fix: "Add the delegate to the key's `allowedDelegates` in the Hardhat config, or run the task at a terminal and answer the question.",
  },
  authDeclined: {
    id: "core.task.auth-declined",
    kind: "error",
    group: "Tasks",
    template: "the authorization was not signed: the question was not answered with y or yes",
    cause:
      "`kms sign-auth` asked at the terminal before signing, and the answer was not `y` or `yes`: `n`, an empty line, another word, or input that closed. Nothing was sent to the KMS for signing.",
    fix: "Check the account, delegate, chain and nonce the question shows, and run the task again if they are right.",
  },
  balancesNeedNetwork: {
    id: "core.task.balances-need-network",
    kind: "error",
    group: "Tasks",
    template: "--balances reads balances on one network: pass --network <name>",
    cause: "`kms accounts --balances` was run without `--network`, so it has no node to ask.",
    fix: "Add `--network` with the network whose balances you want.",
  },
  balanceReadFailed: {
    id: "core.task.balance-read-failed",
    kind: "reason",
    group: "Tasks",
    template: "could not read the balance: {reason}",
    cause:
      "`kms accounts --balances` could not connect to the network, or the node did not answer `eth_getBalance` for the key's address. The row fails, and the task exits with code 1.",
    fix: "Check the network's RPC URL and that the node is reachable. The text after the colon says what failed.",
  },
  balanceNotHex: {
    id: "core.task.balance-not-hex",
    kind: "error",
    group: "Tasks",
    template: "the node answered eth_getBalance with {answer}, not a hex quantity",
    cause: "The network's node answered `eth_getBalance` with something other than a hex number.",
    fix: "Check the network's RPC URL; the node may not be an Ethereum JSON-RPC node.",
  },
  checkSignFailed: {
    id: "core.task.check-sign-failed",
    kind: "reason",
    group: "Tasks",
    template: "the sign check failed: {reason}",
    cause:
      "`kms accounts --check-sign` asked the key to sign a random EIP-191 message, and the KMS refused or the signature did not recover to the key's address. Reading a public key and signing need different permissions, so a key can pass the plain check and fail this one.",
    fix: "Give the credentials the provider's sign permission: `kms:Sign` on AWS, `cloudkms.cryptoKeyVersions.useToSign` on Google Cloud. On Azure, the identity needs read and sign on the key, as step 2 of the Azure setup guide shows: `Microsoft.KeyVault/vaults/keys/read` and `Microsoft.KeyVault/vaults/keys/sign/action` in a custom role or the built-in Key Vault Crypto User role, the `get` and `sign` key permissions in an access policy, or `Microsoft.KeyVault/managedHsm/keys/read/action` and `Microsoft.KeyVault/managedHsm/keys/sign/action` on a Managed HSM. The text after the colon says what failed.",
  },

  // kms history: reading a key's sign events from its provider's audit log.
  historyTimeInvalid: {
    id: "core.history.time-invalid",
    kind: "error",
    group: "History",
    template:
      '--{option} "{value}" is not a time. Use an ISO 8601 time with a time zone, such as 2026-10-02T09:00:00Z, a date such as 2026-10-02, or a duration before now, such as 30m, 6h or 7d',
    cause:
      "`kms history` was given a `--since` or `--until` it cannot read. A time without a time zone is refused, because it could mean any zone.",
    fix: "Add `Z` or an offset such as `+02:00` to the time, or use a duration in `s`, `m`, `h` or `d`.",
  },
  historyRangeEmpty: {
    id: "core.history.range-empty",
    kind: "error",
    group: "History",
    template: "--since ({since}) must be before --until ({until})",
    cause:
      "The start of the range is not before its end. Without `--until`, the end is now, so a `--since` in the future fails too.",
    fix: "Swap the two values, or move `--since` back.",
  },
  historyUntilFuture: {
    id: "core.history.until-future",
    kind: "error",
    group: "History",
    template: "--until ({until}) is more than 5 minutes after now ({now})",
    cause:
      "`kms history --until` names a time in the future. The log cannot hold events from then, and a range that ends later would look complete when it is not.",
    fix: "Leave `--until` out to read up to now, or check the date and its time zone.",
  },
  historyLimitRange: {
    id: "core.history.limit-range",
    kind: "error",
    group: "History",
    template: "--limit must be an integer from 1 to {max}, got {limit}",
    cause: "`kms history --limit` is 0, negative or above the maximum.",
    fix: "Use a smaller `--limit`, and narrow the range with `--since` and `--until` to see older events.",
  },
  historyNoReader: {
    id: "core.history.no-reader",
    kind: "error",
    group: "History",
    template:
      'no plugin reads the audit log of "{provider}" keys, so kms history cannot list this key\'s sign events',
    cause:
      "No plugin in the Hardhat config implements the `kms.readSignHistory` hook for the key's provider. A third-party provider plugin may sign without offering a history reader.",
    fix: "Read the provider's audit log with its own tools, or ask the provider plugin's authors to add a reader (see the provider contract).",
  },
  historyNoReaderBuiltin: {
    id: "core.history.no-reader-builtin",
    kind: "error",
    group: "History",
    template:
      "no installed plugin reads {name} audit logs. The reader ships in {package}; install or update it to the same version as hardhat-kms, and add it to `plugins` in your Hardhat config",
    cause:
      "The key's provider is built in, but its provider package is not in `plugins`, or it is a version without a history reader.",
    fix: "Install the package the message names, at the same version as hardhat-kms, and add its plugin to `plugins`.",
  },
  historyUnsupported: {
    id: "core.history.unsupported",
    kind: "error",
    group: "History",
    template:
      "kms history does not read {name} keys yet: {package} signs with them but has no audit log reader. Read the key's activity with {name}'s own tools",
    cause:
      "The key's provider is built in, but its provider package has no history reader in this release, so installing or updating the package does not help.",
    fix: "Read the key's sign events with the provider's own tools: for Turnkey, the activities in the dashboard or the `list_activities` query.",
  },
  historyReadFailed: {
    id: "core.history.read-failed",
    kind: "error",
    group: "History",
    template: "reading the audit log failed ({errorName})",
    cause:
      "The history reader threw an error that is not one of the plugin's own. Only its class name is shown, since SDK messages can carry request details.",
    fix: "Run with `DEBUG=hardhat:kms:*` to see the step that failed, and check the provider's read permission.",
  },
  historyReaderInvalid: {
    id: "core.history.reader-invalid",
    kind: "error",
    group: "History",
    template: "the history reader returned an invalid result: {problem}",
    cause:
      "A provider plugin's `kms.readSignHistory` handler returned something that does not follow the contract, such as an event outside the range or a value for a field it lists as not logged.",
    fix: "Report it to the provider plugin; see the reader contract in the provider guide.",
  },
  historyAccessDenied: {
    id: "core.history.access-denied",
    kind: "error",
    group: "History",
    template:
      "cannot read the audit log: the credentials lack {permission}. Grant it, or run with credentials that have it",
    cause:
      "The provider refused to return log entries to the credentials in use. A reader never reports an empty history for a log it could not read.",
    fix: "Grant the permission the message names to the identity that runs `kms history`. The provider setup guides list it.",
  },
  historyThrottled: {
    id: "core.history.throttled",
    kind: "error",
    group: "History",
    template: "the audit log kept refusing requests as too frequent ({limit})",
    cause:
      "The provider throttled the reads, and the reader's retries did not get through. Long ranges need many requests.",
    fix: "Wait a minute and run again, or narrow the range with `--since` and `--until`, or lower `--limit`.",
  },
  historyAccessDeniedUnprintable: {
    id: "core.history.access-denied-unprintable",
    kind: "error",
    group: "History",
    template:
      "cannot read the audit log: the credentials lack a permission. The history reader named it in a form that could carry an id, so it is not shown; this is a bug in the reader",
    cause:
      "The provider refused to return log entries, and the history reader passed `auditLogAccessDenied` a permission with characters, a URL, an ARN, a resource path or a run of digits or hex that could be an account or key id. Such a value would be printed without `--show-ids`.",
    fix: "Grant the read permission that the provider setup guide lists, and report the bug to the provider plugin.",
  },
  historyThrottledUnprintable: {
    id: "core.history.throttled-unprintable",
    kind: "error",
    group: "History",
    template:
      "the audit log kept refusing requests as too frequent. The history reader named the limit in a form that could carry an id, so it is not shown; this is a bug in the reader",
    cause:
      "The provider throttled the reads, and the history reader passed `auditLogThrottled` a limit that could carry an id.",
    fix: "Wait a minute and run again, or narrow the range with `--since` and `--until`, and report the bug to the provider plugin.",
  },
  historyReaderError: {
    id: "core.history.reader-error",
    kind: "error",
    group: "History",
    template: "{message}",
    cause:
      "The history reader threw a plugin or Hardhat error. Its text is shown with key ids, workspace ids and other values that must not print masked, and without the errors it wraps, which are not masked.",
    fix: "Follow the message. Run with `--show-ids` to see it unmasked, or with `DEBUG=hardhat:kms:*` to see the step that failed.",
  },
  historyTimedOut: {
    id: "core.history.timed-out",
    kind: "error",
    group: "History",
    template:
      "reading the audit log took more than {seconds} seconds, so kms history stopped waiting",
    cause:
      "The history reader did not return within the deadline. Long ranges on a slow or throttled log need many requests.",
    fix: "Narrow the range with `--since` and `--until`, or lower `--limit`.",
  },

  // Library accounts: connection.kms.getAccount and the account it returns.
  accountViemMissing: {
    id: "core.account.viem-missing",
    kind: "error",
    group: "Library accounts",
    template:
      "connection.kms.getAccount needs the viem package, which could not be loaded ({reason}). Install viem in the project",
    cause:
      "`getAccount` returns a viem account, and viem, an optional peer dependency of hardhat-kms, is not installed in the project, or failed to load.",
    fix: "Install viem in the project with your package manager (for example `npm install --save-dev viem`, `pnpm add -D viem` or `yarn add -D viem`). Nothing else in the plugin needs it.",
  },
  accountViemTooOld: {
    id: "core.account.viem-too-old",
    kind: "error",
    group: "Library accounts",
    template:
      "connection.kms.getAccount needs viem {floor} or later, and the project has viem {installed}. Upgrade viem to {floor} or later",
    cause:
      "The account's nonce manager relies on viem calling its `reset` after every failed send, and only after a `consume`. With viem 2.49.3 and earlier, a failed library send never resets, so the account's next send through the plugin waits up to 60 s. With viem 2.50.3 to 2.55.11, a `reset` can follow a send that never asked for a nonce and end another send's hold, so a send through the plugin can take a nonce that send still needs. When the project asks for a viem that no release in the peer range satisfies, such as `2.55.11` or `~2.54.0`, npm 11.15.0 stops the install with `ERESOLVE` unless it runs with `--legacy-peer-deps`; pnpm 12.8.1, Yarn 1.22.22 and Yarn 4.18.1 install the older release. When the project's range overlaps the peer range but its lockfile holds an older release, such as `^2.47.6` from Hardhat's viem template with 2.52.2 locked, npm 11.15.0 installed with exit code 0 and moved viem to the newest release (2.57.2 when measured), and pnpm 12.8.1, Yarn 1.22.22, Yarn 4.18.1 and npm 11.15.0 with `--legacy-peer-deps` kept the locked 2.52.2.",
    fix: "Upgrade viem in the project to 2.55.13 or later, the floor of its peer range, with your package manager (for example `npm install --save-dev viem@^2.55.13`, `pnpm add -D viem@^2.55.13` or `yarn add -D viem@^2.55.13`).",
  },
  accountConnectionClosed: {
    id: "core.account.connection-closed",
    kind: "error",
    group: "Library accounts",
    template:
      "the connection to network {network} is closed, so its KMS accounts no longer sign. Get the account from an open connection",
    cause:
      "`getAccount` or a method of the account it returned was called after `connection.close()`. A closed connection's library accounts refuse to sign, before any KMS call.",
    fix: "Call `getAccount` on an open connection, from `network.create()`, and use that account.",
  },
  accountCancelled: {
    id: "core.account.cancelled",
    kind: "error",
    group: "Library accounts",
    template:
      "the signal given to getAccount has aborted, so the account makes no more KMS calls. Call getAccount with a new signal to sign again",
    cause:
      "`getAccount`, or a method of the account it returned, was called after the `signal` passed in its options aborted. The account refuses before any KMS call and reserves no nonce.",
    fix: "Call `getAccount` again, with a signal that has not aborted or with none.",
  },
  accountRawSignNotAllowed: {
    id: "core.account.raw-sign-not-allowed",
    kind: "error",
    group: "Library accounts",
    template:
      "the key of {address} does not set allowRawDigests: true, so its account cannot have sign({ hash }). Set it on the key in the Hardhat config to use rawSign",
    cause:
      "`getAccount(address, { rawSign: true })` asks for an account that signs any 32-byte digest, which can be a transaction, a permit or an EIP-7702 authorization. Only a key with `allowRawDigests: true` in the Hardhat config gets one. A key given with `--kms` has no config, so it never does. The plugin refuses before it signs anything, and before any KMS call when the config alone shows that no key at that address opts in.",
    fix: "Set `allowRawDigests: true` on the key in `kms.keys` or the network's `kmsAccounts` if its owner needs `sign`, such as a Coinbase smart account. Otherwise drop `rawSign`.",
  },
  accountOption: {
    id: "core.account.option",
    kind: "error",
    group: "Library accounts",
    template:
      "{name} is not an option of getAccount; the options are rawSign, allowChainZeroAuthorization and signal",
    cause:
      "The options object of `getAccount` has a key the plugin does not know, often a typo. It is refused so that a misspelled option is not silently ignored.",
    fix: "Correct or remove the option.",
  },
  accountField: {
    id: "core.account.field",
    kind: "error",
    group: "Library accounts",
    template: "{field} must be {expected}",
    cause:
      "A value given to `getAccount` or to one of the account's methods does not have the type or form viem gives it. Nothing was signed.",
    fix: "Pass the value in the form the message names, as viem's own actions pass it.",
  },
  accountNotKms: {
    id: "core.account.not-kms",
    kind: "error",
    group: "Library accounts",
    template: "{address} is not a KMS account of network {network}.{accounts}",
    cause:
      "`getAccount` was given an address that none of the connection's KMS keys has. The message lists the addresses it has.",
    fix: "Pass one of the listed addresses, or add the key to the network's `kmsAccounts`.",
  },
  accountTxType: {
    id: "core.account.tx-type",
    kind: "error",
    group: "Library accounts",
    template:
      "transaction type {type} is not signed: KMS accounts sign legacy, eip2930, eip1559 and eip7702 transactions",
    cause:
      "The account's `signTransaction` got a transaction whose `type` is not one it signs, such as a chain-specific deposit type. Nothing was signed.",
    fix: "Send the transaction from another account, or as one of the listed types.",
  },
  accountTxNoType: {
    id: "core.account.tx-no-type",
    kind: "error",
    group: "Library accounts",
    template:
      "the transaction's type cannot be told from its fields: set type, gasPrice or maxFeePerGas",
    cause:
      "The transaction has no `type` and no fee field, so neither viem nor the plugin can tell how to encode it. viem's actions always set one.",
    fix: "Set `type`, or the fee fields of the type you want.",
  },
  accountTxNoChain: {
    id: "core.account.tx-no-chain",
    kind: "error",
    group: "Library accounts",
    template: "the transaction has no chainId; a KMS account signs only for its network's chain",
    cause:
      "The account's `signTransaction` got a transaction without `chainId`. A transaction without one is valid on every chain, so it is refused.",
    fix: "Set `chainId` to the network's chain. viem's actions set it.",
  },
  accountTxWrongChain: {
    id: "core.account.tx-wrong-chain",
    kind: "error",
    group: "Library accounts",
    template: "the transaction is for chain {requested}, but network {network} is chain {chainId}",
    cause:
      "The transaction's `chainId` is another chain than the one of the connection the account comes from. Nothing was signed.",
    fix: "Get the account from a connection to that chain's network.",
  },
  accountTxInvalid: {
    id: "core.account.tx-invalid",
    kind: "error",
    group: "Library accounts",
    template: "the transaction cannot be encoded: {reason}",
    cause:
      "The plugin's transaction encoder refused a value of the transaction, for example a number too large for its field. Nothing was signed.",
    fix: "Correct the value the reason names.",
  },
  accountSerializerFailed: {
    id: "core.account.serializer-failed",
    kind: "error",
    group: "Library accounts",
    template: "{serializer} failed on the transaction ({errorName}), so it was not signed",
    cause:
      "Before signing, the account encodes the transaction with viem's serializer, or with the chain serializer viem passed, to compare it with its own encoding. That serializer threw.",
    fix: "Check the transaction's fields: viem refuses values its types do not allow.",
  },
  accountSerializerMismatch: {
    id: "core.account.serializer-mismatch",
    kind: "error",
    group: "Library accounts",
    template:
      "{serializer} encodes the transaction differently from hardhat-kms, so it was not signed",
    cause:
      "The account signs the transaction as the plugin encodes it, and refuses when viem's serializer, or the chain serializer viem passed, encodes other bytes. A chain with its own transaction format, such as a field the plugin does not encode, causes this.",
    fix: "Send the transaction from another account. If the chain uses the standard transaction format, open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the transaction's fields.",
  },
  accountAuthChainZero: {
    id: "core.account.auth-chain-zero",
    kind: "error",
    group: "Library accounts",
    template:
      "an authorization for chain 0 is valid on every chain where the account's nonce matches. Pass `allowChainZeroAuthorization: true` to getAccount to sign it",
    cause:
      "The account's `signAuthorization` was asked for a chain-0 authorization, which any chain accepts.",
    fix: "Sign for the network's chain, or get the account with `allowChainZeroAuthorization: true` if a chain-0 authorization is intended.",
  },
  accountAuthWrongChain: {
    id: "core.account.auth-wrong-chain",
    kind: "error",
    group: "Library accounts",
    template:
      "the authorization is for chain {requested}, but network {network} is chain {chainId}",
    cause:
      "The account's `signAuthorization` was asked for another chain than the one of the connection the account comes from.",
    fix: "Get the account from a connection to that chain's network, or run `kms sign-auth --chain`.",
  },
  accountAuthNoRecovery: {
    id: "core.account.auth-no-recovery",
    kind: "error",
    group: "Library accounts",
    template: "the authorization does not recover to the account's address",
    cause:
      "The account checks the authorization it returns against its address, and the check failed.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },

  // Alchemy Wallet APIs: checkPreparedCalls, from hardhat-kms/alchemy. Each refusal comes before
  // anything is signed; the message names the field, never the API key or the policy id.
  alchemyInput: {
    id: "core.alchemy.input",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template: "checkPreparedCalls: the expected {field} is not valid. Expected {expected}",
    cause:
      "An argument of `checkPreparedCalls` that describes what you asked for is missing or malformed.",
    fix: "Pass the calls you gave `prepareCalls`, the key's address as `sender`, your chain's id, the delegate you pinned, the account's code from `getCode`, `sponsored: true` only when you passed a policy id, and `maxGasCost` in wei when you did not.",
  },
  alchemyResponseType: {
    id: "core.alchemy.response-type",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template:
      "the prepared calls are {type}; only a user-operation-v070, or an array of one user-operation-v070 and at most one authorization, is accepted",
    cause:
      "`prepareCalls` returned another kind of response, such as `paymaster-permit` (ERC-20 gas), a lone `authorization` (undelegation) or an EntryPoint v0.6 user operation. The check cannot rebuild what those ask the key to sign.",
    fix: "Do not sign it. Prepare plain calls for an EIP-7702 account, with the gas paid by the account or by a policy.",
  },
  alchemyMalformed: {
    id: "core.alchemy.malformed",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template: "the prepared {part} has no valid {field}",
    cause:
      "A field of the response is missing or has the wrong type. `checkPreparedCalls` reads the object that `prepareCalls` of `@alchemy/wallet-apis` returns, with bigint quantities and a number chain id, not the raw JSON-RPC response.",
    fix: "Pass the result of `client.prepareCalls(...)` unchanged. If you did, the response format has changed: do not sign it, and open an issue at https://github.com/aelmanaa/hardhat-kms/issues.",
  },
  alchemySignatureRequest: {
    id: "core.alchemy.signature-request",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template:
      "the user operation asks for a {type} signature; only personal_sign over a raw 32-byte hash is accepted",
    cause:
      "The signature request is `eth_signTypedData_v4`, another type, or missing. The SDK would sign typed data as given, and the check cannot tie it to your calls.",
    fix: "Do not sign it.",
  },
  alchemySignatureText: {
    id: "core.alchemy.signature-text",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template:
      "the user operation asks for personal_sign over a text message, not over a raw 32-byte hash",
    cause:
      "The `personal_sign` request's `data` is a string, or an object without a hex `raw` hash. The check can only tie a raw user operation hash to your calls.",
    fix: "Do not sign it.",
  },
  alchemyChain: {
    id: "core.alchemy.chain",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template: "the prepared {part} is for chain {returned}, not chain {expected}",
    cause:
      "The response names another chain than the one you pass. The SDK signs an authorization for the chain the response names.",
    fix: "Do not sign it. Check the client's `chain` and the `chainId` you pass to `checkPreparedCalls`.",
  },
  alchemySender: {
    id: "core.alchemy.sender",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template: "the user operation's sender is {returned}, not {expected}",
    cause:
      "The user operation would run from another account than the key's address, for example because the client was given an `account`.",
    fix: "Do not sign it. Pass the key's address as `sender`, and leave the client's `account` unset for an EIP-7702 account.",
  },
  alchemyFactory: {
    id: "core.alchemy.factory",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template: "the user operation names a factory; an EIP-7702 account is never deployed by one",
    cause:
      "The user operation has `factory` or `factoryData`. An EIP-7702 account is the key's own address, delegated by an authorization, so its user operations have no factory.",
    fix: "Do not sign it.",
  },
  alchemyHash: {
    id: "core.alchemy.hash",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template:
      "the hash in the signature request is not the EntryPoint v0.7 hash of the returned user operation on chain {chainId}",
    cause:
      "The key would sign a hash that does not belong to the user operation in the response, so the calls the check reads are not what the signature authorizes.",
    fix: "Do not sign it, and report it to Alchemy with the time of the call.",
  },
  alchemyCallsFunction: {
    id: "core.alchemy.calls-function",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template:
      "the user operation's callData is not a Modular Account v2 execute or executeBatch call",
    cause:
      "`callData` calls another function of the account, such as `upgradeToAndCall`, a selector the account does not have, or does not decode.",
    fix: "Do not sign it. Only plain calls are accepted.",
  },
  alchemyCallsEncoding: {
    id: "core.alchemy.calls-encoding",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template: "the user operation's callData is not the standard encoding of its {name} call",
    cause:
      "`callData` decodes, but encoding the decoded call again gives other bytes: it has extra bytes or non-standard offsets.",
    fix: "Do not sign it.",
  },
  alchemyCallsCount: {
    id: "core.alchemy.calls-count",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template: "the user operation makes {returned} calls, and you requested {expected}",
    cause: "The prepared calls add or drop calls.",
    fix: "Do not sign it. Check that the `calls` you pass to `checkPreparedCalls` are the ones you gave `prepareCalls`.",
  },
  alchemyCallsDiffer: {
    id: "core.alchemy.calls-differ",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template: "call {index} of the user operation has another {field} than the call you requested",
    cause:
      "A prepared call goes to another address, sends another value or carries other data than the requested call at the same position. A missing `value` counts as 0 and missing `data` as `0x`.",
    fix: "Do not sign it. Check that the `calls` you pass to `checkPreparedCalls` are the ones you gave `prepareCalls`, in the same order.",
  },
  alchemyNoPaymaster: {
    id: "core.alchemy.no-paymaster",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template:
      "a policy is set, but the user operation names no paymaster, so the account would pay the gas",
    cause:
      "You passed `sponsored: true` for a gas sponsorship policy, and the response has no `paymaster`: the policy id is wrong, its rules refused the user operation, or its budget is spent.",
    fix: "Check the policy id and its rules in the Alchemy dashboard, or prepare the calls without a policy and pass `sponsored: false` to pay the gas from the account.",
  },
  alchemyNotSponsored: {
    id: "core.alchemy.not-sponsored",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template: "a policy is set, but the response's feePayment says the gas is not sponsored",
    cause:
      "You passed `sponsored: true` for a gas sponsorship policy, and the response's `feePayment.sponsored` is `false`.",
    fix: "Check the policy id and its rules in the Alchemy dashboard, or prepare the calls without a policy and pass `sponsored: false` to pay the gas from the account.",
  },
  alchemyGasCost: {
    id: "core.alchemy.gas-cost",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template:
      "the user operation's maximum gas cost is {cost} wei, which exceeds maxGasCost {max} wei",
    cause:
      "The response's gas limits (call, verification, pre-verification and paymaster) times its `maxFeePerGas` exceed the `maxGasCost` you passed. When no paymaster pays, EntryPoint v0.7 takes that amount from the account up front, and the bundler keeps what the user operation is charged.",
    fix: "Do not sign it. Prepare the calls again when fees are lower, or raise `maxGasCost` if the cost is one you accept.",
  },
  alchemyAuthNonce: {
    id: "core.alchemy.auth-nonce",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template: "the authorization is for nonce {returned}, not the account's nonce {expected}",
    cause:
      "The EIP-7702 authorization in the response names another nonce than the `accountNonce` you passed. Another transaction from the account may have moved the nonce, or the response asks for a delegation that could be applied later.",
    fix: "Read the account's nonce again just before `prepareCalls`, and prepare the calls again.",
  },
  alchemyDelegate: {
    id: "core.alchemy.delegate",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template: "the authorization delegates the account to {returned}, not to {expected}",
    cause:
      "The EIP-7702 authorization in the response names another contract than the delegate you pinned. Alchemy may request an authorization to a delegate it recorded for the account without reading the chain.",
    fix: "Do not sign it. If you meant to move to that delegate, change the `delegate` you pass.",
  },
  alchemyDelegatedElsewhere: {
    id: "core.alchemy.delegated-elsewhere",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template: "the account is delegated to {current}, not to {expected}",
    cause:
      "The account's code is an EIP-7702 delegation to another contract. Signing would run the user operation under that contract, or, with an authorization, re-delegate the account.",
    fix: "Clear the other delegation first, or change the `delegate` you pass if that contract is the one you trust.",
  },
  alchemyAccountCode: {
    id: "core.alchemy.account-code",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template: "the account has contract code that is not an EIP-7702 delegation",
    cause:
      "`accountCode` is neither empty nor `0xef0100` followed by an address, so the address holds a contract, not a key's account.",
    fix: "Pass the code of the key's own address, read with `getCode` on the chain you send on.",
  },
  alchemyNotDelegated: {
    id: "core.alchemy.not-delegated",
    kind: "error",
    group: "Alchemy Wallet APIs",
    template: "the account has no delegation, and the response has no authorization",
    cause:
      "The key's address has no code, so the user operation cannot run as a smart account without an authorization, and the response has none.",
    fix: "Read the account's code again just before `prepareCalls`, then prepare the calls again.",
  },

  // EIP-7702 delegates: a key's allowedDelegates, checked before any KMS call by kms sign-auth,
  // signAuthorization and the self-authorizations of a transaction.
  delegateNotAllowed: {
    id: "core.delegate.not-allowed",
    kind: "error",
    group: "EIP-7702 delegates",
    template:
      "key {keyName} may not delegate to {delegate} on chain {chain}: no entry of its allowedDelegates allows that delegate on that chain. Nothing was signed",
    cause:
      'The key has `allowedDelegates`, and none of its entries names the delegate with this chain id or with `chains: "all"`. No flag overrides the list.',
    fix: "Check the delegate address and the chain. If the delegate is intended, add it to the key's `allowedDelegates` for that chain.",
  },
  delegateNotAllowedChainZero: {
    id: "core.delegate.not-allowed-chain-zero",
    kind: "error",
    group: "EIP-7702 delegates",
    template:
      'key {keyName} may not delegate to {delegate} on chain 0, which is every chain: only an allowedDelegates entry with chains: "all" allows a chain-0 authorization. Nothing was signed',
    cause:
      'An authorization for chain 0 is valid on every chain. An entry that lists chain ids allows the delegate on those chains only, so it does not match a chain-0 authorization. Only `chains: "all"` does, as in Ledger\'s Ethereum app.',
    fix: 'Sign the authorization for one chain. If the delegate is meant for every chain, set its entry\'s `chains` to `"all"`.',
  },
  delegateCommandLineKey: {
    id: "core.delegate.command-line-key",
    kind: "error",
    group: "EIP-7702 delegates",
    template:
      "the --kms key {name} is the same KMS key as {other}, which has allowedDelegates. Name {other} instead, so its list applies. Nothing was signed",
    cause:
      "A key from `--kms` has no config and so no `allowedDelegates`. It names the same KMS key, or has the same address pin, as a config key that limits its delegates, so signing an authorization with it would skip that key's list.",
    fix: "Run the task with the config key's name instead of `--kms`.",
  },
  delegateNotListedNetwork: {
    id: "core.delegate.not-listed-network",
    kind: "error",
    group: "EIP-7702 delegates",
    template:
      "key {keyName} may not delegate to {delegate} on network {network}: no entry of its allowedDelegates names that delegate. Nothing was signed",
    cause:
      "`kms sign-auth --network` checks the delegate against the key's `allowedDelegates` before it connects to the network, and no entry names it for any chain.",
    fix: "Check the delegate address. If the delegate is intended, add it to the key's `allowedDelegates`.",
  },
  delegateCodeNoNetwork: {
    id: "core.delegate.code-no-network",
    kind: "error",
    group: "EIP-7702 delegates",
    template:
      "key {keyName} pins the code hash of delegate {delegate}, and with --chain there is no network to read its code from. Pass --network instead. Nothing was signed",
    cause:
      "The key's `allowedDelegates` entry for this delegate has a `codeHash`. `kms sign-auth --chain` opens no connection, so the plugin cannot read the delegate's code, and it refuses rather than sign unchecked.",
    fix: "Run `kms sign-auth` with `--network <name>` for the chain the authorization is for. For a chain-0 authorization, which needs `--chain 0`, use an entry without `codeHash`.",
  },
  delegateCodeMismatch: {
    id: "core.delegate.code-mismatch",
    kind: "error",
    group: "EIP-7702 delegates",
    template:
      "the code of delegate {delegate} on chain {chain} has hash {actual}, which no codeHash in the allowedDelegates of key {keyName} matches. Nothing was signed",
    cause:
      "The key's `allowedDelegates` pins the delegate's code hash, and the node returned other code: the address is wrong for this chain, the contract was replaced, or the node is not the one you expect.",
    fix: "Check the delegate address and the network. If the new code is intended, update `codeHash` to the hash shown.",
  },
  delegateNoCode: {
    id: "core.delegate.no-code",
    kind: "error",
    group: "EIP-7702 delegates",
    template:
      "delegate {delegate} has no code on chain {chain}, and the allowedDelegates of key {keyName} pin its code hash. Nothing was signed",
    cause:
      "The key's `allowedDelegates` pins the delegate's code hash, and the node says the address has no code on this chain.",
    fix: "Check that the delegate is deployed on this chain at this address, and that `--network` is the network you mean.",
  },
  delegateCodeUnreadable: {
    id: "core.delegate.code-unreadable",
    kind: "error",
    group: "EIP-7702 delegates",
    template:
      "the node's eth_getCode answer for delegate {delegate} is not hex data, so its pinned code hash cannot be checked. Nothing was signed",
    cause:
      "The key's `allowedDelegates` pins the delegate's code hash, and the node's `eth_getCode` answer is not a `0x` hex string of whole bytes.",
    fix: "Check the network's URL and node. Retry with another node if it persists.",
  },
  // Internal: only a bug or a broken install reaches these. They are plain `Error`s.
  identifierPartMissing: {
    id: "core.internal.identifier-part",
    kind: "internal",
    group: "Internal",
    template: "an identifier part has no value",
    cause: "Joining the parts of a key id found a part without a value. Every part always has one.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  wrongProvider: {
    id: "core.internal.wrong-provider",
    kind: "internal",
    group: "Internal",
    template: 'Expected a "{expected}" key, got "{actual}"',
    cause:
      "A provider's config resolver was given another provider's key. Validation dispatches on `provider`, so this is a guard.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  unvalidatedKey: {
    id: "core.internal.unvalidated-key",
    kind: "internal",
    group: "Internal",
    template: 'Unknown key "{account}" in networks.{network}.kmsAccounts',
    cause:
      "Config resolution met a key name that validation would have refused, so the config was not validated first.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  kmsOptionNoValue: {
    id: "core.internal.kms-option-no-value",
    kind: "internal",
    group: "Internal",
    template: "no value for {name}",
    cause:
      "A `--kms` key asked for a variable the option had not read. It only asks for the ones it read.",
    fix: "Open an issue at https://github.com/aelmanaa/hardhat-kms/issues with the message and the stack trace.",
  },
  noPackageVersion: {
    id: "core.internal.no-package-version",
    kind: "internal",
    group: "Internal",
    template: "{packageName}/package.json has no version",
    cause: "An installed package's package.json has no `version`, so the install is broken.",
    fix: "Reinstall the dependencies. If it repeats, open an issue at https://github.com/aelmanaa/hardhat-kms/issues.",
  },
} as const;

/** Every entry, checked against the entry type. */
export const ENTRIES: readonly ErrorEntry[] = Object.values(ERRORS);
