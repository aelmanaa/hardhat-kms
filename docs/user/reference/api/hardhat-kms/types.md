---
title: hardhat-kms/types
description: "Public types of hardhat-kms/types: the kms config section, each provider's key config and the resolved forms Hardhat passes to plugins."
---

# hardhat-kms/types

Public types of hardhat-kms: the `kms` config section, key configs and their resolved forms.

Third-party providers add their key config type by augmenting [KmsProviderUserConfigs](#kmsprovideruserconfigs).

## Interfaces

### AccountEntry

One key in the output of `kms accounts`.

#### Extends

- [`AccountName`](#accountname)

#### Properties

##### address

> **address**: `string` \| `null`

The EIP-55 address, or `null` if the key failed.

##### balance?

> `optional` **balance?**: `string` \| `null`

Only with `--balances`: the address's balance on the `--network` network, in wei, as a decimal
string, or `null` if the key or the read failed.

##### endpoint?

> `optional` **endpoint?**: `string` \| `null`

AWS keys only, and only with `--show-ids`: the configured endpoint, or `null`.

##### error

> **error**: `string` \| `null`

Why the key failed, or `null`. A pin mismatch names both addresses. A failed balance read and a
failed sign check are each described, separated by `; `.

##### keyId

> **keyId**: `string`

The key id. Values read from configuration variables show as `<VARIABLE_NAME>` unless
`--show-ids` is given. A merged row shows the id of its first entry.

##### name

> **name**: `string`

The name a task takes for this entry.

###### Inherited from

[`AccountName`](#accountname).[`name`](#name-1)

##### otherNames

> **otherNames**: [`AccountName`](#accountname)[]

Other entries for the same KMS key with the same pin, listed in this row without `--network`.

##### pin

> **pin**: `string` \| `null`

The configured `address` pin, or `null`.

##### pinStatus

> **pinStatus**: `"match"` \| `"none"` \| `"unchecked"` \| `null`

`match`: the KMS confirmed the pin or, with `--check-sign`, the key signed and its signature
recovered to the pin. `none`: no pin. `unchecked`: the provider cannot report the address, so
`address` is the pin. `null` if the key failed.

##### profile?

> `optional` **profile?**: `string` \| `null`

AWS keys only: the configured profile, or `null` for the SDK's default. A profile from a
configuration variable shows as `<VARIABLE_NAME>` unless `--show-ids` is given. With
`--show-ids`, an empty value shows as `null`.

##### provider

> **provider**: `string`

##### region?

> `optional` **region?**: `string` \| `null`

AWS keys only: the configured region, or `null` for the SDK's default. A region from a
configuration variable shows as `<VARIABLE_NAME>` unless `--show-ids` is given, and one that
falls back to `kms.defaults.aws.region` shows both forms, such as
`<AWS_KMS_REGION> or us-east-1`. An empty value is `null` with `--show-ids`.

##### signCheck?

> `optional` **signCheck?**: `"ok"` \| `null`

Only with `--check-sign`: `ok` when the key signed a random EIP-191 message and the signature
recovered to its address, or `null` if the key or the signature failed.

##### source

> **source**: [`AccountSource`](#accountsource)

###### Inherited from

[`AccountName`](#accountname).[`source`](#source-1)

---

### AccountName

A name a key goes by, and where that entry is defined.

#### Extended by

- [`AccountEntry`](#accountentry)

#### Properties

##### name

> **name**: `string`

The name a task takes for this entry.

##### source

> **source**: [`AccountSource`](#accountsource)

---

### AccountsReport

What `kms accounts` returns, in a successful result or, if any key failed, a failed one, and
what `--json` prints.

#### Properties

##### accounts

> **accounts**: [`AccountEntry`](#accountentry)[]

##### version

> **version**: `1`

The version of this shape.

---

### AwsKmsKeyConfig

A resolved AWS KMS key.

#### Extends

- [`KmsKeyCommonConfig`](#kmskeycommonconfig)

#### Properties

##### address?

> `optional` **address?**: `string`

The checksummed address pin, if one was configured.

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`address`](#address-14)

##### displayId

> **displayId**: `string`

A description of the key that is safe to print, such as `aws:alias/deployer`. It never contains
a configuration variable's value.

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`displayId`](#displayid-5)

##### endpoint?

> `optional` **endpoint?**: `string`

##### keyId

> **keyId**: [`KmsIdentifier`](#kmsidentifier)

##### name

> **name**: `string`

The key's name in `kms.keys`, or `<network>.kmsAccounts[<index>]` for an inline key.

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`name`](#name-6)

##### profile?

> `optional` **profile?**: [`KmsIdentifier`](#kmsidentifier)

The profile. Its value is read on demand; an empty value means no profile.

##### provider

> **provider**: `"aws"`

##### region?

> `optional` **region?**: [`KmsIdentifier`](#kmsidentifier)

The first region set among a literal key ARN, the key's `region` and `kms.defaults.aws.region`.
Its value is read on demand; an empty value means no region, so the AWS SDK decides. A `region`
from a configuration variable whose value is empty falls back to `kms.defaults.aws.region`.
When `keyId` comes from a configuration variable and holds an ARN, the ARN's region is used
instead, and a conflicting `region` is an error when the key is first used.

##### timeoutMs

> **timeoutMs**: `number`

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`timeoutMs`](#timeoutms-9)

---

### AwsKmsKeyUserConfig

An AWS KMS key.

#### Extends

- [`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig)

#### Properties

##### address?

> `optional` **address?**: `string`

The address the key must derive to. Optional, recommended: the plugin then skips a KMS call to
learn the address, and refuses to sign if the key turns out to be different.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`address`](#address-15)

##### endpoint?

> `optional` **endpoint?**: `string`

Custom KMS endpoint URL, for example a LocalStack instance.

##### keyId

> **keyId**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

A key id, key ARN, alias name (`alias/...`) or alias ARN.

##### profile?

> `optional` **profile?**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

Named profile from the AWS shared config files, literal or a configuration variable. A
variable is read when the key is first used; an empty value means no profile, so the AWS SDK's
default credential chain decides. `configVariable("AWS_KMS_PROFILE", { default: "" })` makes
the profile optional.

##### provider

> **provider**: `"aws"`

##### region?

> `optional` **region?**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

AWS region, literal or a configuration variable. A region inside an ARN takes precedence and
must not conflict with this one. A variable is read when the key is first used; an empty value
means no region, so `kms.defaults.aws.region` or the AWS SDK decides.

##### timeoutMs?

> `optional` **timeoutMs?**: `number`

Time budget for each KMS call for this key, in milliseconds. Overrides `kms.defaults.timeoutMs`.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`timeoutMs`](#timeoutms-10)

---

### AzureKmsKeyComponentsUserConfig

An Azure Key Vault or Managed HSM key, given as its components.

#### Extends

- [`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig)

#### Properties

##### address?

> `optional` **address?**: `string`

The address the key must derive to. Optional, recommended: the plugin then skips a KMS call to
learn the address, and refuses to sign if the key turns out to be different.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`address`](#address-15)

##### keyName

> **keyName**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

##### keyVersion?

> `optional` **keyVersion?**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

##### provider

> **provider**: `"azure"`

##### timeoutMs?

> `optional` **timeoutMs?**: `number`

Time budget for each KMS call for this key, in milliseconds. Overrides `kms.defaults.timeoutMs`.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`timeoutMs`](#timeoutms-10)

##### vaultUrl

> **vaultUrl**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

`https://<vault>.vault.azure.net`, or a Managed HSM or sovereign-cloud equivalent.

---

### AzureKmsKeyConfig

A resolved Azure Key Vault or Managed HSM key.

#### Extends

- [`KmsKeyCommonConfig`](#kmskeycommonconfig)

#### Properties

##### address?

> `optional` **address?**: `string`

The checksummed address pin, if one was configured.

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`address`](#address-14)

##### displayId

> **displayId**: `string`

A description of the key that is safe to print, such as `aws:alias/deployer`. It never contains
a configuration variable's value.

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`displayId`](#displayid-5)

##### keyId

> **keyId**: [`KmsIdentifier`](#kmsidentifier)

The key identifier URL, versioned or not.

##### name

> **name**: `string`

The key's name in `kms.keys`, or `<network>.kmsAccounts[<index>]` for an inline key.

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`name`](#name-6)

##### provider

> **provider**: `"azure"`

##### timeoutMs

> **timeoutMs**: `number`

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`timeoutMs`](#timeoutms-9)

---

### AzureKmsKeyIdUserConfig

An Azure Key Vault or Managed HSM key, given as its full key identifier URL.

#### Extends

- [`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig)

#### Properties

##### address?

> `optional` **address?**: `string`

The address the key must derive to. Optional, recommended: the plugin then skips a KMS call to
learn the address, and refuses to sign if the key turns out to be different.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`address`](#address-15)

##### keyId

> **keyId**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

`https://<vault>.vault.azure.net/keys/<name>[/<version>]`, or a Managed HSM or sovereign-cloud
equivalent. An unversioned key is resolved once and that version is then used.

##### provider

> **provider**: `"azure"`

##### timeoutMs?

> `optional` **timeoutMs?**: `number`

Time budget for each KMS call for this key, in milliseconds. Overrides `kms.defaults.timeoutMs`.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`timeoutMs`](#timeoutms-10)

---

### ExternalKmsKeyConfig

A resolved key of a third-party provider. The plugin validates only the fields every key shares;
the rest of `userConfig` is left to the provider. Configuration variables inside `userConfig`
are resolved, as Hardhat does for its own config.

#### Extends

- [`KmsKeyCommonConfig`](#kmskeycommonconfig)

#### Type Parameters

| Type Parameter                | Default type |
| ----------------------------- | ------------ |
| `Provider` _extends_ `string` | `string`     |

#### Properties

##### address?

> `optional` **address?**: `string`

The checksummed address pin, if one was configured.

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`address`](#address-14)

##### displayId

> **displayId**: `string`

A description of the key that is safe to print, such as `aws:alias/deployer`. It never contains
a configuration variable's value.

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`displayId`](#displayid-5)

##### name

> **name**: `string`

The key's name in `kms.keys`, or `<network>.kmsAccounts[<index>]` for an inline key.

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`name`](#name-6)

##### provider

> **provider**: `Provider`

##### timeoutMs

> **timeoutMs**: `number`

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`timeoutMs`](#timeoutms-9)

##### userConfig

> **userConfig**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

---

### GcpKmsKeyComponentsUserConfig

A Google Cloud KMS key version, given as its components.

#### Extends

- [`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig)

#### Properties

##### address?

> `optional` **address?**: `string`

The address the key must derive to. Optional, recommended: the plugin then skips a KMS call to
learn the address, and refuses to sign if the key turns out to be different.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`address`](#address-15)

##### keyName

> **keyName**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

##### keyRing

> **keyRing**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

##### keyVersion

> **keyVersion**: `number` \| [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

The key version. Always required: the plugin never picks a version for you.

##### location

> **location**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

##### projectId

> **projectId**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

##### provider

> **provider**: `"gcp"`

##### timeoutMs?

> `optional` **timeoutMs?**: `number`

Time budget for each KMS call for this key, in milliseconds. Overrides `kms.defaults.timeoutMs`.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`timeoutMs`](#timeoutms-10)

---

### GcpKmsKeyConfig

A resolved Google Cloud KMS key version.

#### Extends

- [`KmsKeyCommonConfig`](#kmskeycommonconfig)

#### Properties

##### address?

> `optional` **address?**: `string`

The checksummed address pin, if one was configured.

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`address`](#address-14)

##### displayId

> **displayId**: `string`

A description of the key that is safe to print, such as `aws:alias/deployer`. It never contains
a configuration variable's value.

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`displayId`](#displayid-5)

##### keyVersionName

> **keyVersionName**: [`KmsIdentifier`](#kmsidentifier)

The full key version resource name.

##### name

> **name**: `string`

The key's name in `kms.keys`, or `<network>.kmsAccounts[<index>]` for an inline key.

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`name`](#name-6)

##### provider

> **provider**: `"gcp"`

##### timeoutMs

> **timeoutMs**: `number`

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`timeoutMs`](#timeoutms-9)

---

### GcpKmsKeyVersionNameUserConfig

A Google Cloud KMS key version, given as its full resource name.

#### Extends

- [`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig)

#### Properties

##### address?

> `optional` **address?**: `string`

The address the key must derive to. Optional, recommended: the plugin then skips a KMS call to
learn the address, and refuses to sign if the key turns out to be different.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`address`](#address-15)

##### keyVersionName

> **keyVersionName**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

`projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>/cryptoKeyVersions/<v>`.

##### provider

> **provider**: `"gcp"`

##### timeoutMs?

> `optional` **timeoutMs?**: `number`

Time budget for each KMS call for this key, in milliseconds. Overrides `kms.defaults.timeoutMs`.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`timeoutMs`](#timeoutms-10)

---

### KeyDescription

What a key is, in terms that are safe to print.

Stable from 1.0: a minor may add optional fields; changing or removing one needs a major.

#### Properties

##### displayId

> **displayId**: `string`

How to show the key to users; identifiers that came from configuration variables are masked.

##### pinnedId

> **pinnedId**: `string`

The key the adapter signs with, as configured and safe to print. A provider that resolves a
more exact id on first use, such as the AWS key ARN, signs with that id.

##### provider

> **provider**: `string`

Provider id, for example `aws`.

---

### KmsAccessListEntry

An entry of an access list.

#### Properties

##### address

> **address**: `` `0x${string}` ``

##### storageKeys

> **storageKeys**: readonly `` `0x${string}` ``[]

---

### KmsAccount

A viem local account whose key is a KMS key, from `connection.kms.getAccount`. Pass it to
viem as `account`, or as the owner of a smart account.

viem fills the account's transactions and sends them with `eth_sendRawTransaction` itself.
Through `custom(connection.provider)`, the account's `nonceManager` and the plugin's send lock
keep those sends and the plugin's own sends from one key on distinct nonces, one after the
other. Not so for a client with its own transport, such as `http(url)`: only its nonce is
reserved. These sends have no retry cache.

After `connection.close()`, every method refuses before any KMS call.

#### Extended by

- [`KmsRawSignAccount`](#kmsrawsignaccount)

#### Properties

##### address

> `readonly` **address**: `` `0x${string}` ``

The checksummed address.

##### nonceManager

> `readonly` **nonceManager**: [`KmsNonceManager`](#kmsnoncemanager)

viem's nonce manager for the account's sends; see [KmsNonceManager](#kmsnoncemanager).

##### publicKey

> `readonly` **publicKey**: `` `0x${string}` ``

The uncompressed public key, 65 bytes starting with `0x04`.

##### signAuthorization

> `readonly` **signAuthorization**: (`parameters`: [`KmsAuthorizationRequest`](#kmsauthorizationrequest)) => `Promise`\<[`KmsSignedAuthorization`](#kmssignedauthorization)\>

Signs an EIP-7702 authorization for the connection's chain. Chain 0 needs the
`allowChainZeroAuthorization` option of `getAccount`.

###### Parameters

| Parameter    | Type                                                  | Description                    |
| ------------ | ----------------------------------------------------- | ------------------------------ |
| `parameters` | [`KmsAuthorizationRequest`](#kmsauthorizationrequest) | The delegate, chain and nonce. |

###### Returns

`Promise`\<[`KmsSignedAuthorization`](#kmssignedauthorization)\>

The signed authorization.

##### signMessage

> `readonly` **signMessage**: (`parameters`: \{ `message`: [`KmsSignableMessage`](#kmssignablemessage); \}) => `Promise`\<`` `0x${string}` ``\>

Signs an EIP-191 personal message.

###### Parameters

| Parameter            | Type                                                          | Description  |
| -------------------- | ------------------------------------------------------------- | ------------ |
| `parameters`         | \{ `message`: [`KmsSignableMessage`](#kmssignablemessage); \} | The message. |
| `parameters.message` | [`KmsSignableMessage`](#kmssignablemessage)                   | -            |

###### Returns

`Promise`\<`` `0x${string}` ``\>

The 65-byte `r || s || v` signature.

##### signTransaction

> `readonly` **signTransaction**: (`transaction`: [`KmsTransactionRequest`](#kmstransactionrequest), `options?`: [`KmsSignTransactionOptions`](#kmssigntransactionoptions)) => `Promise`\<`` `0x${string}` ``\>

Signs a transaction of type `legacy`, `eip2930`, `eip1559` or `eip7702`, whose `chainId`
must be the connection's.

###### Parameters

| Parameter     | Type                                                      | Description                               |
| ------------- | --------------------------------------------------------- | ----------------------------------------- |
| `transaction` | [`KmsTransactionRequest`](#kmstransactionrequest)         | The transaction.                          |
| `options?`    | [`KmsSignTransactionOptions`](#kmssigntransactionoptions) | The chain serializer viem passes, if any. |

###### Returns

`Promise`\<`` `0x${string}` ``\>

The signed transaction, serialized.

##### signTypedData

> `readonly` **signTypedData**: (`parameters`: [`KmsTypedDataDefinition`](#kmstypeddatadefinition)) => `Promise`\<`` `0x${string}` ``\>

Signs EIP-712 typed data. Typed data whose `domain.chainId` is another chain than the
connection's is refused, unless `kms.allowCrossChainTypedData` is set.

###### Parameters

| Parameter    | Type                                                | Description     |
| ------------ | --------------------------------------------------- | --------------- |
| `parameters` | [`KmsTypedDataDefinition`](#kmstypeddatadefinition) | The typed data. |

###### Returns

`Promise`\<`` `0x${string}` ``\>

The 65-byte `r || s || v` signature.

##### source

> `readonly` **source**: `"hardhat-kms"`

Where the account comes from.

##### type

> `readonly` **type**: `"local"`

Always `local`: viem signs with it rather than asking the node.

---

### KmsAccountOptions

Options of `connection.kms.getAccount`.

#### Properties

##### allowChainZeroAuthorization?

> `optional` **allowChainZeroAuthorization?**: `boolean`

Let `signAuthorization` sign for chain 0, which makes the authorization valid on every chain.

##### rawSign?

> `optional` **rawSign?**: `boolean`

Add `sign({ hash })`, which signs a bare digest. Off by default (decision 0014); some smart
account owners need it. A warning is printed when it is on.

---

### KmsAuditConfig

The resolved `kms.audit` section.

#### Properties

##### azure?

> `optional` **azure?**: \{ `workspaceId`: [`KmsIdentifier`](#kmsidentifier); \}

Set when `kms.audit.azure.workspaceId` is.

###### workspaceId

> **workspaceId**: [`KmsIdentifier`](#kmsidentifier)

The Log Analytics workspace id, checked to be a GUID when read.

---

### KmsAuditUserConfig

Where `kms history` reads each provider's audit log, for providers that need a setting.

#### Properties

##### azure?

> `optional` **azure?**: \{ `workspaceId?`: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig); \}

Azure Key Vault's audit log.

###### workspaceId?

> `optional` **workspaceId?**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

The Log Analytics workspace that the vault's diagnostic setting sends `AuditEvent` logs to,
as its workspace id (a GUID). Literal or a configuration variable.

---

### KmsAuthorizationListEntry

A signed EIP-7702 authorization in a transaction's `authorizationList`, as viem takes it.

#### Properties

##### address

> **address**: `` `0x${string}` ``

##### chainId

> **chainId**: `number`

##### nonce

> **nonce**: `number`

##### r

> **r**: `` `0x${string}` ``

##### s

> **s**: `` `0x${string}` ``

##### v?

> `optional` **v?**: `bigint`

27 or 28; used when `yParity` is absent.

##### yParity?

> `optional` **yParity?**: `number`

0 or 1.

---

### KmsAuthorizationRequest

An EIP-7702 authorization to sign, as viem's `AuthorizationRequest`.

#### Properties

##### address?

> `optional` **address?**: `` `0x${string}` ``

The address of the code to delegate to.

##### chainId

> **chainId**: `number`

The chain the authorization is valid on; 0 is every chain.

##### contractAddress?

> `optional` **contractAddress?**: `` `0x${string}` ``

Another name for `address`, as in viem.

##### nonce

> **nonce**: `number`

The authority's nonce.

---

### KmsConfig

The resolved `kms` section.

#### Properties

##### allowCrossChainTypedData

> **allowCrossChainTypedData**: `boolean`

##### audit

> **audit**: [`KmsAuditConfig`](#kmsauditconfig)

##### defaults

> **defaults**: \{ `aws`: \{ `region?`: [`KmsIdentifier`](#kmsidentifier); \}; `timeoutMs`: `number`; \}

###### aws

> **aws**: \{ `region?`: [`KmsIdentifier`](#kmsidentifier); \}

`region` is read on demand; an empty value means no region.

###### aws.region?

> `optional` **region?**: [`KmsIdentifier`](#kmsidentifier)

###### timeoutMs

> **timeoutMs**: `number`

##### keys

> **keys**: `Record`\<`string`, [`KmsKeyConfig`](#kmskeyconfig)\>

##### simulatedBalance?

> `optional` **simulatedBalance?**: `bigint`

---

### KmsHistoryEntry

One sign event in the output of `kms history`.

#### Properties

##### digest

> **digest**: `string` \| `null`

The signed digest as `0x` hex, where the provider logs it.

##### error

> **error**: \{ `code`: `string` \| `null`; `message`: `string` \| `null`; \} \| `null`

For a failed request, the provider's error code, and with `--show-ids` its message, which can
name accounts and keys. `null` for a request that succeeded.

##### extra

> **extra**: `Record`\<`string`, [`KmsHistoryExtraValue`](#kmshistoryextravalue)\>

Other fields of the log entry. Ids of keys, accounts and credentials only with `--show-ids`.

##### keyResource

> **keyResource**: `string` \| `null`

The key as the log names it. Without `--show-ids` it shows as the key's display id, since a
key ARN, resource name or key URL names the account, project or vault.

##### keyVersion

> **keyVersion**: `string` \| `null`

The version id of the key version that signed, as logged.

##### operation

> **operation**: `string`

The provider's name for the operation, such as `Sign`.

##### outcome

> **outcome**: `"success"` \| `"failed"`

##### principal

> **principal**: `string` \| `null`

Who made the request, as logged.

##### requestId

> **requestId**: `string` \| `null`

The id the provider assigned to the request, as logged.

##### sourceIp

> **sourceIp**: `string` \| `null`

The caller's IP address, as logged.

##### time

> **time**: `string`

When the provider logged the request, in UTC.

##### userAgent

> **userAgent**: `string` \| `null`

The user agent the client reported. Any client can send any value.

---

### KmsHistoryEvent

One sign event as the provider's audit log records it. Every field is copied from the log
entry, with no value guessed or filled in. A field the provider records but left empty in this
entry is `null`, and so is a field listed in [KmsHistoryResult.notLogged](#notlogged-1).

`kms history` prints `principal`, `sourceIp`, `userAgent`, `requestId`, `keyVersion`, `digest`
and `extra` as they are, and the error code. It shows `keyResource`, `errorMessage` and
`extraIds` only with `--show-ids`. By default it replaces a key resource found in another field
with the key's display id, and an `extraIds` value with `<hidden>`.

Stable from 1.0: a minor may add optional fields; changing or removing one needs a major.

#### Properties

##### digest

> **digest**: `string` \| `null`

The signed digest as `0x`-prefixed lowercase hex.

##### errorCode

> **errorCode**: `string` \| `null`

The provider's error code for a failed request, such as `AccessDeniedException`.

##### errorMessage

> **errorMessage**: `string` \| `null`

The provider's error message. It can name accounts, projects and keys.

##### extra?

> `optional` **extra?**: `Readonly`\<`Record`\<`string`, [`KmsHistoryExtraValue`](#kmshistoryextravalue)\>\>

Other fields of the entry, shown as they are. Never put key ids or account ids here. Each name
starts with a letter, then up to 63 letters, digits, `_` and `.`.

##### extraIds?

> `optional` **extraIds?**: `Readonly`\<`Record`\<`string`, `string` \| `null`\>\>

Other fields of the entry that identify keys, accounts or credentials, such as an AWS access
key id. Shown only with `--show-ids`; without it, their values are masked as `<hidden>`
wherever they appear. Names as in `extra`.

##### keyResource

> **keyResource**: `string` \| `null`

The key as the log names it: a key ARN, a resource name or a key URL.

##### keyVersion

> **keyVersion**: `string` \| `null`

The key version that signed: the version id alone, such as `1` or an Azure version segment,
never a resource name or URL. Letters, digits, `.`, `_` and `-`, at most 64 characters.

##### operation

> **operation**: `string`

The provider's name for the operation, such as `Sign`, `AsymmetricSign` or `KeySign`.

##### outcome

> **outcome**: `"success"` \| `"failed"`

Whether the provider reports the request as served or refused.

##### principal

> **principal**: `string` \| `null`

Who made the request: an ARN, an email address or a token claim.

##### requestId

> **requestId**: `string` \| `null`

The id the provider assigned to the request. A provider that logs none, such as Google Cloud,
lists `requestId` in `notLogged`; a log entry's own id, such as Google Cloud's `insertId`, goes
in `extra`.

##### sourceIp

> **sourceIp**: `string` \| `null`

The caller's IP address, or the provider's placeholder for it.

##### time

> **time**: `string`

When the provider logged the request: an ISO 8601 date and time that exists, with `Z` or an
offset. The plugin shows it in UTC, to the millisecond.

##### userAgent

> **userAgent**: `string` \| `null`

The user agent the client sent. The client chooses it, so it proves nothing.

---

### KmsHistoryNote

A note a reader adds to the result, printed on standard error and listed in the JSON output.

Stable from 1.0: a minor may add optional fields; changing or removing one needs a major.

#### Properties

##### code

> **code**: `string`

A stable code in lowercase letters, digits and `-`, such as `other-account`.

##### message

> **message**: `string`

The note for the user, in one or two sentences. No key ids or account ids.

---

### KmsHistoryReport

What `kms history` returns and what `--json` prints.

#### Properties

##### events

> **events**: [`KmsHistoryEntry`](#kmshistoryentry)[]

The events, newest first.

##### key

> **key**: \{ `displayId`: `string`; `name`: `string`; `provider`: `string`; \}

The key, by the name the task was given and its display id.

###### displayId

> **displayId**: `string`

###### name

> **name**: `string`

###### provider

> **provider**: `string`

##### notes

> **notes**: [`KmsHistoryNote`](#kmshistorynote)[]

Warnings about what the events may not show, also printed on standard error.

##### notLogged

> **notLogged**: [`KmsHistoryField`](#kmshistoryfield)[]

The fields this provider never records. They are `null` in every event.

##### range

> **range**: \{ `since`: `string`; `until`: `string`; \}

The range read, in UTC, on whole seconds.

###### since

> **since**: `string`

###### until

> **until**: `string`

##### scope

> **scope**: `string` \| `null`

Which part of the log the read covered, such as `account <hidden>, us-east-1`, or `null` when
the reader does not say. Ids in it show only with `--show-ids`.

##### source

> **source**: `string`

Where the events come from, such as `cloudtrail-event-history`.

##### truncated

> **truncated**: `boolean`

Whether the log may hold events in the range that the report leaves out.

##### truncatedReason

> **truncatedReason**: `"limit"` \| `"scan-limit"` \| `null`

Why: `limit` when the log holds more events than `--limit`, `scan-limit` when the reader
stopped before reading the whole range. `null` when not truncated.

##### version

> **version**: `1`

The version of this shape.

---

### KmsHistoryRequest

What `kms history` asks a reader for: the sign events of one key in a time range, newest first.

The history covers the whole key: every version, even when the config pins one. Each event
names its version in `keyVersion` where the provider logs it.

Stable from 1.0: a minor may add optional fields; changing or removing one needs a major.

#### Properties

##### key

> **key**: [`KmsKeyConfig`](#kmskeyconfig)

The resolved key, as `kms.createKeyAdapter` receives it.

##### limit

> **limit**: `number`

How many events `kms history` shows, the newest ones. Return at most `limit + 1` events: the
extra one tells the plugin there are more, and it then marks the result truncated. An
integer from 1 to 1000.

##### signal?

> `optional` **signal?**: `AbortSignal`

Aborts when `kms history` stops waiting for the reader: 120 seconds after the read starts.
Pass it to the log SDK's calls and stop paging when it fires. The plugin fails the read with
`core.history.timed-out` at that time even when the reader ignores it. Set by the plugin on
every request; optional so that a reader called by other code still type-checks.

##### since

> **since**: `Date`

The start of the range, inclusive, on a whole second. Filter the provider's answer to the
range too: provider queries may round their bounds.

##### until

> **until**: `Date`

The end of the range, inclusive, on a whole second. Always after `since`.

---

### KmsHistoryResult

What a reader returns: the events it read, newest first, and what the provider's log can and
cannot show. A reader that cannot read the log throws instead; it never returns an empty
result for a log it could not read.

Never put key ids, account ids or other identifiers in `source`, `scope.description`,
`setupHint`, note messages or the errors a reader throws: they are printed without
`--show-ids`.

Stable from 1.0: a minor may add optional fields; changing or removing one needs a major.

#### Properties

##### completeForKey

> **completeForKey**: `boolean`

Whether every sign request on this key is visible to this read: the provider logs every
sign request with no setting that turns it off, and the credentials and location of the
read see all of them. On AWS this holds only when the caller's account is the key ARN's
account and the read is in the key's Region, since CloudTrail event history is kept per
account and Region. When it is `false`, an empty result gets the `logging-not-confirmed`
note.

##### deliveryDelayMinutes?

> `optional` **deliveryDelayMinutes?**: `number`

How many minutes the provider documents an event can take to appear, if it documents it.

##### events

> **events**: readonly [`KmsHistoryEvent`](#kmshistoryevent)[]

The events in the range, newest first, at most `limit + 1` of them.

##### hiddenValues?

> `optional` **hiddenValues?**: readonly `string`[]

Other values that must not print, such as the key ARN an alias resolved to. Without
`--show-ids`, the plugin replaces them and the parts they contain, in any case and in their
URL-encoded and `/`-escaped forms, with `<hidden>` wherever they appear.

##### notes?

> `optional` **notes?**: readonly [`KmsHistoryNote`](#kmshistorynote)[]

Notes of the reader's own.

##### notLogged

> **notLogged**: readonly [`KmsHistoryField`](#kmshistoryfield)[]

The fields this provider never records for a sign request.

##### retentionDays?

> `optional` **retentionDays?**: `number`

How many days the log keeps events, when that does not depend on the user's settings.

##### scope?

> `optional` **scope?**: [`KmsHistoryScope`](#kmshistoryscope)

Which part of the log the read covered, such as one account and Region.

##### setupHint?

> `optional` **setupHint?**: `string`

What to check when the log returns no events, such as the setting that turns logging on.
Added to the `logging-not-confirmed` note.

##### source

> **source**: `string`

Where the events come from, as a stable id of lowercase words joined by `-`, such as
`cloudtrail-event-history`: letters only, no digits, at most 64 characters. It is printed as
it is, so it cannot carry an account or project number.

##### truncated

> **truncated**: `boolean`

Whether the log may hold events in the range that the result leaves out. Also set when the
reader stopped early; see `truncatedReason`.

##### truncatedReason?

> `optional` **truncatedReason?**: `"limit"` \| `"scan-limit"`

Why the result is truncated, required when `truncated` is `true` and refused otherwise:
`limit` when the log holds more events in the range than `limit`, with at least `limit` events
returned, and `scan-limit` when the reader stopped before reading the whole range, for example
after scanning as many log entries as it allows itself. A result with `limit + 1` events and
`truncated: false` is marked truncated by `limit` by the plugin.

---

### KmsHistoryScope

Which part of the log a read covered, printed in the header of `kms history`.

Stable from 1.0: a minor may add optional fields; changing or removing one needs a major.

#### Properties

##### description

> **description**: `string`

What the read covered, free of ids, such as `us-east-1`.

##### ids?

> `optional` **ids?**: `Readonly`\<`Record`\<`string`, `string`\>\>

Ids that bound the read, by name, such as `{ account: "111122223333" }`. Shown only with
`--show-ids`; otherwise each prints as `<name> <hidden>`, and its value is masked as `<hidden>`
wherever it appears, except in principals, which are shown as logged. Names as in
[KmsHistoryEvent.extra](#extra-1).

---

### KmsHooks

The `kms` hook category, which provider plugins use to add their adapters.

Stable from 1.0: a minor may add methods; changing or removing one needs a major.

#### Methods

##### createKeyAdapter()

> **createKeyAdapter**(`context`: `HookContext`, `key`: [`KmsKeyConfig`](#kmskeyconfig), `next`: (`nextContext`: `HookContext`, `nextKey`: [`KmsKeyConfig`](#kmskeyconfig)) => `Promise`\<[`KmsKeyAdapter`](#kmskeyadapter)\>): `Promise`\<[`KmsKeyAdapter`](#kmskeyadapter)\>

Builds the adapter for one key. A handler builds adapters for its own provider ids and calls
`next` for any other key. The first-party provider packages, such as @hardhat-kms/aws, use
this hook too. A key that no handler claims fails with an error; for `aws`, `gcp` and `azure`
keys, the error names the package to install.

The plugin validates only the fields every key shares. A handler validates the rest of an
`ExternalKmsKeyConfig`'s `userConfig` itself; configuration variables in it are
`ResolvedConfigurationVariable` objects. The plugin rejects an adapter without `describe()`,
without a signing method, or without `getPublicKey` or `getAddress` when the key has no
`address` pin. It verifies every signature an adapter returns.

###### Parameters

| Parameter | Type                                                                                                                         | Description                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `context` | `HookContext`                                                                                                                | The Hardhat runtime, without tasks. |
| `key`     | [`KmsKeyConfig`](#kmskeyconfig)                                                                                              | The resolved key.                   |
| `next`    | (`nextContext`: `HookContext`, `nextKey`: [`KmsKeyConfig`](#kmskeyconfig)) => `Promise`\<[`KmsKeyAdapter`](#kmskeyadapter)\> | Passes the key to the next handler. |

###### Returns

`Promise`\<[`KmsKeyAdapter`](#kmskeyadapter)\>

The key's adapter.

##### readSignHistory()

> **readSignHistory**(`context`: `HookContext`, `request`: [`KmsHistoryRequest`](#kmshistoryrequest), `next`: (`nextContext`: `HookContext`, `nextRequest`: [`KmsHistoryRequest`](#kmshistoryrequest)) => `Promise`\<[`KmsHistoryResult`](#kmshistoryresult)\>): `Promise`\<[`KmsHistoryResult`](#kmshistoryresult)\>

Reads one key's sign events from its provider's audit log, for `kms history`. A handler
reads the log for its own provider ids and calls `next` for any other key. When no handler
reads a key's provider, `kms history` fails with an error that names the provider. The
first-party provider packages add their readers through this method.

The reader copies each event from the log and fills in nothing. It lists the fields its
provider never records in `notLogged`. It throws when it cannot read the log, for example
without permission, and never returns an empty result instead. The plugin checks the result,
keeps the newest `limit` events, masks key ids and adds notes for an empty result, a recent
`until` and a `since` past the log's retention.

Settings a reader needs, such as `kms.audit.azure.workspaceId`, are in
`context.config.kms.audit`.

###### Parameters

| Parameter | Type                                                                                                                                             | Description                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `context` | `HookContext`                                                                                                                                    | The Hardhat runtime, without tasks.                    |
| `request` | [`KmsHistoryRequest`](#kmshistoryrequest)                                                                                                        | The key, the time range and the most events to return. |
| `next`    | (`nextContext`: `HookContext`, `nextRequest`: [`KmsHistoryRequest`](#kmshistoryrequest)) => `Promise`\<[`KmsHistoryResult`](#kmshistoryresult)\> | Passes the request to the next handler.                |

###### Returns

`Promise`\<[`KmsHistoryResult`](#kmshistoryresult)\>

The events and what the log can show.

---

### KmsIdentifier

A resolved identifier. `get()` reads its value on demand, trimmed of surrounding whitespace.
`display` is safe to print: a value from a configuration variable displays as `<VARIABLE_NAME>`.

#### Properties

##### display

> `readonly` **display**: `string`

#### Methods

##### get()

> **get**(): `Promise`\<`string`\>

###### Returns

`Promise`\<`string`\>

---

### KmsKeyAdapter

The contract every KMS/HSM provider implements.

An adapter needs at least one way to identify the key (`getPublicKey` or `getAddress`) and
at least one way to sign. The core prefers the structured methods when present and falls back
to `signDigest`; it always verifies the returned signature against the key.

Stable from 1.0: a minor may add optional methods; changing or removing one needs a major.

#### Methods

##### close()?

> `optional` **close**(): `Promise`\<`void`\>

Releases SDK clients and connections.

###### Returns

`Promise`\<`void`\>

##### describe()

> **describe**(): [`KeyDescription`](#keydescription)

Describes the key for messages and logs.

###### Returns

[`KeyDescription`](#keydescription)

##### getAddress()?

> `optional` **getAddress**(`ctx`: [`SignContext`](#signcontext)): `Promise`\<`string`\>

Returns the key's address, for signers that cannot export a public key.

###### Parameters

| Parameter | Type                          |
| --------- | ----------------------------- |
| `ctx`     | [`SignContext`](#signcontext) |

###### Returns

`Promise`\<`string`\>

##### getPublicKey()?

> `optional` **getPublicKey**(`ctx`: [`SignContext`](#signcontext)): `Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

Returns the 65-byte uncompressed public key. Called once per key and cached.

###### Parameters

| Parameter | Type                          |
| --------- | ----------------------------- |
| `ctx`     | [`SignContext`](#signcontext) |

###### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

##### signDigest()?

> `optional` **signDigest**(`request`: \{ `digest`: `Uint8Array`; \}, `ctx`: [`SignContext`](#signcontext)): `Promise`\<[`SignatureOutput`](#signatureoutput)\>

Signs a 32-byte digest.

###### Parameters

| Parameter        | Type                          |
| ---------------- | ----------------------------- |
| `request`        | \{ `digest`: `Uint8Array`; \} |
| `request.digest` | `Uint8Array`                  |
| `ctx`            | [`SignContext`](#signcontext) |

###### Returns

`Promise`\<[`SignatureOutput`](#signatureoutput)\>

##### signMessage()?

> `optional` **signMessage**(`request`: \{ `digest`: `Uint8Array`; `message`: `Uint8Array`; \}, `ctx`: [`SignContext`](#signcontext)): `Promise`\<[`SignatureOutput`](#signatureoutput)\>

Signs an EIP-191 message; `digest` is what the core expects to be signed.

###### Parameters

| Parameter         | Type                                                   |
| ----------------- | ------------------------------------------------------ |
| `request`         | \{ `digest`: `Uint8Array`; `message`: `Uint8Array`; \} |
| `request.digest`  | `Uint8Array`                                           |
| `request.message` | `Uint8Array`                                           |
| `ctx`             | [`SignContext`](#signcontext)                          |

###### Returns

`Promise`\<[`SignatureOutput`](#signatureoutput)\>

##### signTypedData()?

> `optional` **signTypedData**(`request`: \{ `digest`: `Uint8Array`; `typedData`: [`TypedData`](#typeddata); \}, `ctx`: [`SignContext`](#signcontext)): `Promise`\<[`SignatureOutput`](#signatureoutput)\>

Signs EIP-712 typed data; `digest` is what the core expects to be signed.

###### Parameters

| Parameter           | Type                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `request`           | \{ `digest`: `Uint8Array`; `typedData`: [`TypedData`](#typeddata); \} |
| `request.digest`    | `Uint8Array`                                                          |
| `request.typedData` | [`TypedData`](#typeddata)                                             |
| `ctx`               | [`SignContext`](#signcontext)                                         |

###### Returns

`Promise`\<[`SignatureOutput`](#signatureoutput)\>

---

### KmsKeyCommonConfig

Resolved settings shared by every key.

#### Extended by

- [`AwsKmsKeyConfig`](#awskmskeyconfig)
- [`GcpKmsKeyConfig`](#gcpkmskeyconfig)
- [`AzureKmsKeyConfig`](#azurekmskeyconfig)
- [`ExternalKmsKeyConfig`](#externalkmskeyconfig)

#### Properties

##### address?

> `optional` **address?**: `string`

The checksummed address pin, if one was configured.

##### displayId

> **displayId**: `string`

A description of the key that is safe to print, such as `aws:alias/deployer`. It never contains
a configuration variable's value.

##### name

> **name**: `string`

The key's name in `kms.keys`, or `<network>.kmsAccounts[<index>]` for an inline key.

##### timeoutMs

> **timeoutMs**: `number`

---

### KmsKeyCommonUserConfig

Settings shared by every key, whatever its provider.

#### Extended by

- [`AwsKmsKeyUserConfig`](#awskmskeyuserconfig)
- [`GcpKmsKeyVersionNameUserConfig`](#gcpkmskeyversionnameuserconfig)
- [`GcpKmsKeyComponentsUserConfig`](#gcpkmskeycomponentsuserconfig)
- [`AzureKmsKeyIdUserConfig`](#azurekmskeyiduserconfig)
- [`AzureKmsKeyComponentsUserConfig`](#azurekmskeycomponentsuserconfig)

#### Properties

##### address?

> `optional` **address?**: `string`

The address the key must derive to. Optional, recommended: the plugin then skips a KMS call to
learn the address, and refuses to sign if the key turns out to be different.

##### timeoutMs?

> `optional` **timeoutMs?**: `number`

Time budget for each KMS call for this key, in milliseconds. Overrides `kms.defaults.timeoutMs`.

---

### KmsNetworkConnection

What hardhat-kms adds to a network connection, as `connection.kms`.

#### Properties

##### getAccount

> `readonly` **getAccount**: \{(`address`: `string`, `options`: [`KmsAccountOptions`](#kmsaccountoptions) & \{ `rawSign`: `true`; \}): `Promise`\<[`KmsRawSignAccount`](#kmsrawsignaccount)\>; (`address`: `string`, `options?`: [`KmsAccountOptions`](#kmsaccountoptions)): `Promise`\<[`KmsAccount`](#kmsaccount)\>; \}

Returns a viem local account for a KMS account of this connection. It needs the `viem`
package, and asks the KMS for the key's public key once.

###### Call Signature

> (`address`: `string`, `options`: [`KmsAccountOptions`](#kmsaccountoptions) & \{ `rawSign`: `true`; \}): `Promise`\<[`KmsRawSignAccount`](#kmsrawsignaccount)\>

###### Parameters

| Parameter | Type                                                                 |
| --------- | -------------------------------------------------------------------- |
| `address` | `string`                                                             |
| `options` | [`KmsAccountOptions`](#kmsaccountoptions) & \{ `rawSign`: `true`; \} |

###### Returns

`Promise`\<[`KmsRawSignAccount`](#kmsrawsignaccount)\>

###### Call Signature

> (`address`: `string`, `options?`: [`KmsAccountOptions`](#kmsaccountoptions)): `Promise`\<[`KmsAccount`](#kmsaccount)\>

###### Parameters

| Parameter  | Type                                      |
| ---------- | ----------------------------------------- |
| `address`  | `string`                                  |
| `options?` | [`KmsAccountOptions`](#kmsaccountoptions) |

###### Returns

`Promise`\<[`KmsAccount`](#kmsaccount)\>

###### Param

**address**

The address of one of the connection's KMS accounts.

###### Param

**options**

Options; `rawSign: true` adds `sign({ hash })`.

###### Returns

The account.

---

### KmsNonceManager

The account's viem nonce manager. viem calls `consume` for each send that has no nonce, and
`reset` when that send fails. The nonce is chosen as the plugin's own sends would choose it,
under the account's send lock, and is kept from those sends until its raw transaction reaches
the node through the connection, `reset` is called, or 60 s pass.

#### Properties

##### consume

> `readonly` **consume**: (`parameters`: [`KmsNonceManagerParameters`](#kmsnoncemanagerparameters) & \{ `client`: `unknown`; \}) => `Promise`\<`number`\>

Chooses the next nonce and reserves it.

###### Parameters

| Parameter    | Type                                                                                   | Description                                 |
| ------------ | -------------------------------------------------------------------------------------- | ------------------------------------------- |
| `parameters` | [`KmsNonceManagerParameters`](#kmsnoncemanagerparameters) & \{ `client`: `unknown`; \} | The account, the chain and the viem client. |

###### Returns

`Promise`\<`number`\>

The nonce.

##### get

> `readonly` **get**: (`parameters`: [`KmsNonceManagerParameters`](#kmsnoncemanagerparameters) & \{ `client`: `unknown`; \}) => `Promise`\<`number`\>

Chooses the next nonce without reserving it.

###### Parameters

| Parameter    | Type                                                                                   | Description                                 |
| ------------ | -------------------------------------------------------------------------------------- | ------------------------------------------- |
| `parameters` | [`KmsNonceManagerParameters`](#kmsnoncemanagerparameters) & \{ `client`: `unknown`; \} | The account, the chain and the viem client. |

###### Returns

`Promise`\<`number`\>

The nonce.

##### increment

> `readonly` **increment**: (`parameters`: [`KmsNonceManagerParameters`](#kmsnoncemanagerparameters)) => `void`

Does nothing: each `consume` reads the node and the reservations again.

###### Parameters

| Parameter    | Type                                                      |
| ------------ | --------------------------------------------------------- |
| `parameters` | [`KmsNonceManagerParameters`](#kmsnoncemanagerparameters) |

###### Returns

`void`

##### reset

> `readonly` **reset**: (`parameters`: [`KmsNonceManagerParameters`](#kmsnoncemanagerparameters)) => `void`

Ends the reservation of a send that failed.

###### Parameters

| Parameter    | Type                                                      |
| ------------ | --------------------------------------------------------- |
| `parameters` | [`KmsNonceManagerParameters`](#kmsnoncemanagerparameters) |

###### Returns

`void`

---

### KmsNonceManagerParameters

What viem passes to a nonce manager.

#### Properties

##### address

> **address**: `` `0x${string}` ``

The account's address.

##### chainId

> **chainId**: `number`

The chain of the transaction.

---

### KmsProviderConfigs

Resolved key config types by provider id. A third-party provider that augments
[KmsProviderUserConfigs](#kmsprovideruserconfigs) augments this interface too, usually with
`ExternalKmsKeyConfig<"its-id">`, so that resolved keys can be narrowed on `provider`.

#### Properties

##### aws

> **aws**: [`AwsKmsKeyConfig`](#awskmskeyconfig)

##### azure

> **azure**: [`AzureKmsKeyConfig`](#azurekmskeyconfig)

##### gcp

> **gcp**: [`GcpKmsKeyConfig`](#gcpkmskeyconfig)

---

### KmsProviderUserConfigs

Key config types by provider id. Third-party providers augment this interface:

```ts
declare module "hardhat-kms/types" {
  interface KmsProviderUserConfigs {
    myvault: { provider: "myvault"; keyPath: string } & KmsKeyCommonUserConfig;
  }
}
```

#### Properties

##### aws

> **aws**: [`AwsKmsKeyUserConfig`](#awskmskeyuserconfig)

##### azure

> **azure**: [`AzureKmsKeyUserConfig`](#azurekmskeyuserconfig)

##### gcp

> **gcp**: [`GcpKmsKeyUserConfig`](#gcpkmskeyuserconfig)

---

### KmsRawSignAccount

A [KmsAccount](#kmsaccount) that also signs bare digests, from `getAccount(address, { rawSign: true })`.

#### Extends

- [`KmsAccount`](#kmsaccount)

#### Properties

##### address

> `readonly` **address**: `` `0x${string}` ``

The checksummed address.

###### Inherited from

[`KmsAccount`](#kmsaccount).[`address`](#address-11)

##### nonceManager

> `readonly` **nonceManager**: [`KmsNonceManager`](#kmsnoncemanager)

viem's nonce manager for the account's sends; see [KmsNonceManager](#kmsnoncemanager).

###### Inherited from

[`KmsAccount`](#kmsaccount).[`nonceManager`](#noncemanager)

##### publicKey

> `readonly` **publicKey**: `` `0x${string}` ``

The uncompressed public key, 65 bytes starting with `0x04`.

###### Inherited from

[`KmsAccount`](#kmsaccount).[`publicKey`](#publickey)

##### sign

> `readonly` **sign**: (`parameters`: \{ `hash`: `` `0x${string}` ``; \}) => `Promise`\<`` `0x${string}` ``\>

Signs a 32-byte digest as it is, with no prefix. Whatever the digest stands for is signed,
a transaction for any chain included.

###### Parameters

| Parameter         | Type                               | Description |
| ----------------- | ---------------------------------- | ----------- |
| `parameters`      | \{ `hash`: `` `0x${string}` ``; \} | The digest. |
| `parameters.hash` | `` `0x${string}` ``                | -           |

###### Returns

`Promise`\<`` `0x${string}` ``\>

The 65-byte `r || s || v` signature.

##### signAuthorization

> `readonly` **signAuthorization**: (`parameters`: [`KmsAuthorizationRequest`](#kmsauthorizationrequest)) => `Promise`\<[`KmsSignedAuthorization`](#kmssignedauthorization)\>

Signs an EIP-7702 authorization for the connection's chain. Chain 0 needs the
`allowChainZeroAuthorization` option of `getAccount`.

###### Parameters

| Parameter    | Type                                                  | Description                    |
| ------------ | ----------------------------------------------------- | ------------------------------ |
| `parameters` | [`KmsAuthorizationRequest`](#kmsauthorizationrequest) | The delegate, chain and nonce. |

###### Returns

`Promise`\<[`KmsSignedAuthorization`](#kmssignedauthorization)\>

The signed authorization.

###### Inherited from

[`KmsAccount`](#kmsaccount).[`signAuthorization`](#signauthorization)

##### signMessage

> `readonly` **signMessage**: (`parameters`: \{ `message`: [`KmsSignableMessage`](#kmssignablemessage); \}) => `Promise`\<`` `0x${string}` ``\>

Signs an EIP-191 personal message.

###### Parameters

| Parameter            | Type                                                          | Description  |
| -------------------- | ------------------------------------------------------------- | ------------ |
| `parameters`         | \{ `message`: [`KmsSignableMessage`](#kmssignablemessage); \} | The message. |
| `parameters.message` | [`KmsSignableMessage`](#kmssignablemessage)                   | -            |

###### Returns

`Promise`\<`` `0x${string}` ``\>

The 65-byte `r || s || v` signature.

###### Inherited from

[`KmsAccount`](#kmsaccount).[`signMessage`](#signmessage)

##### signTransaction

> `readonly` **signTransaction**: (`transaction`: [`KmsTransactionRequest`](#kmstransactionrequest), `options?`: [`KmsSignTransactionOptions`](#kmssigntransactionoptions)) => `Promise`\<`` `0x${string}` ``\>

Signs a transaction of type `legacy`, `eip2930`, `eip1559` or `eip7702`, whose `chainId`
must be the connection's.

###### Parameters

| Parameter     | Type                                                      | Description                               |
| ------------- | --------------------------------------------------------- | ----------------------------------------- |
| `transaction` | [`KmsTransactionRequest`](#kmstransactionrequest)         | The transaction.                          |
| `options?`    | [`KmsSignTransactionOptions`](#kmssigntransactionoptions) | The chain serializer viem passes, if any. |

###### Returns

`Promise`\<`` `0x${string}` ``\>

The signed transaction, serialized.

###### Inherited from

[`KmsAccount`](#kmsaccount).[`signTransaction`](#signtransaction)

##### signTypedData

> `readonly` **signTypedData**: (`parameters`: [`KmsTypedDataDefinition`](#kmstypeddatadefinition)) => `Promise`\<`` `0x${string}` ``\>

Signs EIP-712 typed data. Typed data whose `domain.chainId` is another chain than the
connection's is refused, unless `kms.allowCrossChainTypedData` is set.

###### Parameters

| Parameter    | Type                                                | Description     |
| ------------ | --------------------------------------------------- | --------------- |
| `parameters` | [`KmsTypedDataDefinition`](#kmstypeddatadefinition) | The typed data. |

###### Returns

`Promise`\<`` `0x${string}` ``\>

The 65-byte `r || s || v` signature.

###### Inherited from

[`KmsAccount`](#kmsaccount).[`signTypedData`](#signtypeddata)

##### source

> `readonly` **source**: `"hardhat-kms"`

Where the account comes from.

###### Inherited from

[`KmsAccount`](#kmsaccount).[`source`](#source-2)

##### type

> `readonly` **type**: `"local"`

Always `local`: viem signs with it rather than asking the node.

###### Inherited from

[`KmsAccount`](#kmsaccount).[`type`](#type)

---

### KmsSignedAuthorization

A signed EIP-7702 authorization, as `signAuthorization` returns it, in viem's form.

#### Properties

##### address

> **address**: `` `0x${string}` ``

The address of the code to delegate to, as it was requested.

##### chainId

> **chainId**: `number`

##### nonce

> **nonce**: `number`

##### r

> **r**: `` `0x${string}` ``

32 bytes.

##### s

> **s**: `` `0x${string}` ``

32 bytes, in the lower half of the curve order.

##### yParity

> **yParity**: `number`

0 or 1. There is no `v`; viem marks `v` on signatures as deprecated.

---

### KmsSignTransactionOptions

The options viem passes to `signTransaction`.

#### Properties

##### serializer?

> `optional` **serializer?**: (`transaction`: [`KmsTransactionRequest`](#kmstransactionrequest)) => `unknown`

A chain's transaction serializer. The account serializes with its own code; when a
serializer is given, its unsigned bytes must be the same, or nothing is signed.

###### Parameters

| Parameter     | Type                                              | Description      |
| ------------- | ------------------------------------------------- | ---------------- |
| `transaction` | [`KmsTransactionRequest`](#kmstransactionrequest) | The transaction. |

###### Returns

`unknown`

The serialized transaction, as hex.

---

### KmsTransactionRequest

A transaction for `signTransaction`, in viem's `TransactionSerializable` fields. Only types
`legacy`, `eip2930`, `eip1559` and `eip7702` are signed.

#### Properties

##### accessList?

> `optional` **accessList?**: readonly [`KmsAccessListEntry`](#kmsaccesslistentry)[]

##### authorizationList?

> `optional` **authorizationList?**: readonly [`KmsAuthorizationListEntry`](#kmsauthorizationlistentry)[]

##### chainId?

> `optional` **chainId?**: `number`

##### data?

> `optional` **data?**: `` `0x${string}` ``

##### gas?

> `optional` **gas?**: `bigint`

##### gasPrice?

> `optional` **gasPrice?**: `bigint`

##### maxFeePerGas?

> `optional` **maxFeePerGas?**: `bigint`

##### maxPriorityFeePerGas?

> `optional` **maxPriorityFeePerGas?**: `bigint`

##### nonce?

> `optional` **nonce?**: `number`

##### to?

> `optional` **to?**: `` `0x${string}` `` \| `null`

##### type?

> `optional` **type?**: `string`

##### value?

> `optional` **value?**: `bigint`

---

### KmsTypedDataDefinition

EIP-712 typed data, as viem's `signTypedData` takes it. The fields are typed loosely so that
viem's generic `TypedDataDefinition` is assignable to it; the account checks them at run time.

#### Properties

##### domain?

> `optional` **domain?**: `unknown`

The domain, an object; typed data without one has an empty domain.

##### message?

> `optional` **message?**: `unknown`

The values to sign, an object. Absent when `primaryType` is `EIP712Domain`.

##### primaryType

> **primaryType**: `unknown`

The name of the type of `message`.

##### types?

> `optional` **types?**: `unknown`

The struct types, each a list of `{ name, type }` fields. `EIP712Domain` may be left out: it
follows from `domain`. Absent when `primaryType` is `EIP712Domain`.

---

### KmsUserConfig

The `kms` section of the Hardhat config.

#### Properties

##### allowCrossChainTypedData?

> `optional` **allowCrossChainTypedData?**: `boolean`

Allow typed data whose `domain.chainId` differs from the connected chain. Default: `false`.

##### audit?

> `optional` **audit?**: [`KmsAuditUserConfig`](#kmsaudituserconfig)

Where `kms history` reads the providers' audit logs.

##### defaults?

> `optional` **defaults?**: \{ `aws?`: \{ `region?`: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig); \}; `timeoutMs?`: `number`; \}

###### aws?

> `optional` **aws?**: \{ `region?`: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig); \}

Defaults for AWS keys. The `region` here, a literal or a configuration variable, applies to
every key without a region of its own, including the keys that `--kms aws` adds.

###### aws.region?

> `optional` **region?**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

###### timeoutMs?

> `optional` **timeoutMs?**: `number`

Default time budget for each KMS call, in milliseconds. Default: 30000.

##### keys?

> `optional` **keys?**: `Record`\<`string`, [`KmsKeyUserConfig`](#kmskeyuserconfig)\>

Named keys, referenced by name from any network's `kmsAccounts`.

##### simulatedBalance?

> `optional` **simulatedBalance?**: `bigint`

On `edr-simulated` networks only, give each KMS address this balance, in wei.

---

### SignContext

Per-call context passed to provider adapters.

Stable from 1.0: a minor may add optional fields; changing or removing one needs a major.

#### Properties

##### requestId

> **requestId**: `string`

Identifies this call in the plugin's debug output.

##### signal

> **signal**: `AbortSignal`

Aborted when the call times out or the caller gives up; adapters should pass it to their SDK.

#### Methods

##### displayMessage()

> **displayMessage**(`message`: `string`): `Promise`\<`void`\>

Shows a status line to the user (for example while waiting for an approval).

###### Parameters

| Parameter | Type     |
| --------- | -------- |
| `message` | `string` |

###### Returns

`Promise`\<`void`\>

---

### TypedData

An EIP-712 typed-data payload, as accepted by `eth_signTypedData_v4`.

Requests arrive as untyped JSON, so the shape is kept loose here; the encoder validates it at
runtime.

#### Properties

##### domain

> **domain**: `Record`\<`string`, `unknown`\>

##### message

> **message**: `Record`\<`string`, `unknown`\>

##### primaryType

> **primaryType**: `string`

##### types

> **types**: `Record`\<`string`, readonly \{ `name`: `string`; `type`: `string`; \}[]\>

## Type Aliases

### AccountSource

> **AccountSource** = `"kms.keys"` \| `"kmsAccounts"` \| `"--kms"`

Where a key listed by `kms accounts` is defined.

---

### AzureKmsKeyUserConfig

> **AzureKmsKeyUserConfig** = [`AzureKmsKeyIdUserConfig`](#azurekmskeyiduserconfig) \| [`AzureKmsKeyComponentsUserConfig`](#azurekmskeycomponentsuserconfig)

An Azure Key Vault or Managed HSM key.

---

### GcpKmsKeyUserConfig

> **GcpKmsKeyUserConfig** = [`GcpKmsKeyVersionNameUserConfig`](#gcpkmskeyversionnameuserconfig) \| [`GcpKmsKeyComponentsUserConfig`](#gcpkmskeycomponentsuserconfig)

A Google Cloud KMS key version.

---

### KmsAccountUserConfig

> **KmsAccountUserConfig** = `string` \| [`KmsKeyUserConfig`](#kmskeyuserconfig)

An entry of a network's `kmsAccounts`: the name of a key in `kms.keys`, or an inline key.

---

### KmsHex

> **KmsHex** = `` `0x${string}` ``

A `0x`-prefixed hex string, as viem's `Hex`.

---

### KmsHistoryExtraValue

> **KmsHistoryExtraValue** = `string` \| `number` \| `boolean` \| `null`

A value a reader may put in [KmsHistoryEvent.extra](#extra-1).

---

### KmsHistoryField

> **KmsHistoryField** = `"principal"` \| `"sourceIp"` \| `"userAgent"` \| `"requestId"` \| `"keyVersion"` \| `"digest"`

A field of a sign event that a provider may not record. A reader lists the fields its
provider never logs in [KmsHistoryResult.notLogged](#notlogged-1), and sets them to `null` in every
event.

Stable from 1.0: a minor may add a value, together with an optional [KmsHistoryEvent](#kmshistoryevent) field,
so that a reader that does not know the value still returns valid events. Changing or removing a
value needs a major.

---

### KmsIdentifierUserConfig

> **KmsIdentifierUserConfig** = `string` \| `ConfigurationVariable`

A value that can be written literally or read from a configuration variable.

---

### KmsKeyConfig

> **KmsKeyConfig** = [`KmsProviderConfigs`](#kmsproviderconfigs)\[keyof [`KmsProviderConfigs`](#kmsproviderconfigs)\]

A resolved key of any registered provider. Narrow it with `key.provider === "aws"`.

---

### KmsKeyUserConfig

> **KmsKeyUserConfig** = [`KmsProviderUserConfigs`](#kmsprovideruserconfigs)\[keyof [`KmsProviderUserConfigs`](#kmsprovideruserconfigs)\]

A key of any registered provider.

---

### KmsSignableMessage

> **KmsSignableMessage** = `string` \| \{ `raw`: [`KmsHex`](#kmshex) \| `Uint8Array`; \}

A message for `signMessage`: UTF-8 text, or bytes given as hex or as a `Uint8Array`.

---

### KmsTransactionSerializer

> **KmsTransactionSerializer** = \{ `serialize`: `unknown`; \}\[`"serialize"`\]

A chain's transaction serializer, as viem passes it. Written as a method type, so that viem's
serializers, whose parameter is viem's own transaction type, are assignable to it.

---

### SignatureOutput

> **SignatureOutput** = \{ `bytes`: `Uint8Array`; `format`: `"der"` \| `"compact"`; \} \| \{ `r`: `bigint`; `s`: `bigint`; `yParity?`: `0` \| `1`; \}

A signature as returned by a provider adapter, before normalization.

- `der`: an ASN.1 DER `ECDSA-Sig-Value` (AWS KMS, GCP Cloud KMS).
- `compact`: 64 bytes `r || s` (Azure Key Vault, PKCS#11).
- `{ r, s, yParity }`: already split, as returned by API signers. `yParity` is ignored: the parity is always recovered against the known key.
