import type { ErrorEntry } from "./errors.ts";

/*
 * Every error the core package builds, with its cause and fix. First-party code builds errors
 * only from these entries, through catalogError, catalogMessage and internalError in errors.ts;
 * `pnpm run docs:check` fails on a throw that bypasses them. `pnpm run docs:errors` writes
 * docs/user/reference/errors.md from this file.
 *
 * Templates keep the messages as they were before the catalogue. A placeholder holds a value (a
 * name, a number, a list); where only the wording around a value changed, the entry is split.
 */

/** The core package's error catalogue. */
export const ERRORS = {
  // Configuration: validation messages, which Hardhat shows after the config path.
  timeoutType: {
    id: "core.config.timeout-type",
    kind: "validation",
    group: "Configuration",
    template: "Expected a number of milliseconds",
    cause: "A `timeoutMs` or `approvalTimeoutMs`, on a key or in `kms.defaults`, is not a number.",
    fix: "Set it to a number of milliseconds, such as `30_000`.",
  },
  timeoutInteger: {
    id: "core.config.timeout-integer",
    kind: "validation",
    group: "Configuration",
    template: "Expected an integer number of milliseconds",
    cause: "A `timeoutMs` or `approvalTimeoutMs` has a fraction.",
    fix: "Use a whole number of milliseconds.",
  },
  timeoutMin: {
    id: "core.config.timeout-min",
    kind: "validation",
    group: "Configuration",
    template: "Expected at least 1 ms",
    cause: "A `timeoutMs` or `approvalTimeoutMs` is 0 or negative.",
    fix: "Use a positive number of milliseconds. The default `timeoutMs` is 30000.",
  },
  timeoutMax: {
    id: "core.config.timeout-max",
    kind: "validation",
    group: "Configuration",
    template: "Expected at most 2147483647 ms",
    cause:
      "A `timeoutMs` or `approvalTimeoutMs` is larger than Node.js timers accept (2^31 - 1 ms, about 24.8 days).",
    fix: "Use a smaller value.",
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
  providerMisspelled: {
    id: "core.config.provider-misspelled",
    kind: "validation",
    group: "Configuration",
    template: 'Unknown provider "{provider}". Did you mean "{suggestion}"?',
    cause:
      "A key's `provider` matches a built-in provider id (`aws`, `gcp`, `azure`) in another case, or is one edit away from one, such as `AWS` or `gpc`.",
    fix: "Use the id the message suggests. A third-party provider needs an id that does not look like a built-in one.",
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
    cause: "An AWS `keyId` is an ARN in another region than the key's `region`.",
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
    fix: "Use the suggested id. `--kms` reads only the built-in providers' variables.",
  },
  kmsOptionUnknown: {
    id: "core.kms-option.unknown-provider",
    kind: "error",
    group: "The `--kms` option",
    template: "--kms {provider}: unknown provider. Expected aws, gcp or azure",
    cause:
      "`--kms` names a provider other than `aws`, `gcp` and `azure`. Third-party providers are configured in `kms.keys` only.",
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
  adapterNoSigning: {
    id: "core.provider.adapter-no-signing",
    kind: "error",
    group: "Provider plugins",
    template: "the adapter for this key has no signing method ({methods})",
    cause: "The adapter implements none of `signDigest`, `signMessage` and `signTypedData`.",
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
    cause: "The provider is planned, but its adapter is not released yet.",
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
      "A first-party provider package and hardhat-kms have different versions. They are released together, and npm refuses such an install, but pnpm and Yarn only warn.",
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
      "the key derives to {address}, but the configured address is {expected}. If the key was rotated or an alias now points to another key, update the configuration.",
    cause:
      "The key's public key gives another address than its `address` pin: the key id, alias or version now names another key, or the pin is wrong. Nothing was signed.",
    fix: "Check which key the config names. If the change is intended, update `address`; see the key rotation guide.",
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
      "The key's adapter has no `signDigest`, and no method for this kind of payload (`signMessage` or `signTypedData`).",
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
  txBlob: {
    id: "core.tx.blob",
    kind: "error",
    group: "Transactions",
    template:
      "blob transactions (EIP-4844) cannot be signed with KMS accounts; send them from another account",
    cause:
      "The transaction has blobs, blob versioned hashes, `maxFeePerBlobGas` or type `0x3`. The plugin does not sign blob transactions.",
    fix: "Send blob transactions from another account.",
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
      "The EIP-712 encoder refused the typed data, for example for an unknown type or a value that does not fit its type. The message is the encoder's own.",
    fix: "Fix the type or value the message names.",
  },
  typedDataUnsafeInteger: {
    id: "core.typed-data.unsafe-integer",
    kind: "reason",
    group: "Typed data",
    template:
      "a number is above 2^53 - 1 (read as {value}), so JSON cannot hold it exactly; write it as a string",
    cause:
      "The typed data JSON has an integer too large for a JavaScript number, which would be rounded and signed as another value.",
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
    template: "the transaction file {file} is not valid JSON: {reason}",
    cause: "The file given to `kms sign-tx` is not JSON. The reason is the JSON parser's.",
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
    cause: "The network's node did not answer `eth_getTransactionCount` with a hex number.",
    fix: "Check the network's RPC URL, or pass `--nonce`.",
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
    fix: "Give the credentials the provider's sign permission: `kms:Sign` on AWS, `cloudkms.cryptoKeyVersions.useToSign` on Google Cloud, `Microsoft.KeyVault/vaults/keys/sign/action` (the Key Vault Crypto User role) or the `sign` key permission on Azure. The text after the colon says what failed.",
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
