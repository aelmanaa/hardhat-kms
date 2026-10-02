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

AWS keys only: the configured profile, or `null` for the SDK's default.

##### provider

> **provider**: `string`

##### region?

> `optional` **region?**: `string` \| `null`

AWS keys only: the configured region, or `null` for the SDK's default.

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

##### approvalTimeoutMs?

> `optional` **approvalTimeoutMs?**: `number`

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`approvalTimeoutMs`](#approvaltimeoutms-9)

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

> `optional` **profile?**: `string`

##### provider

> **provider**: `"aws"`

##### region?

> `optional` **region?**: `string`

The first region set among a literal key ARN, the key's `region` and `kms.defaults.aws.region`.
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

##### approvalTimeoutMs?

> `optional` **approvalTimeoutMs?**: `number`

Time budget for providers with an asynchronous approval step, in milliseconds. Overrides
`kms.defaults.approvalTimeoutMs`.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`approvalTimeoutMs`](#approvaltimeoutms-10)

##### endpoint?

> `optional` **endpoint?**: `string`

Custom KMS endpoint URL, for example a LocalStack instance.

##### keyId

> **keyId**: [`KmsIdentifierUserConfig`](#kmsidentifieruserconfig)

A key id, key ARN, alias name (`alias/...`) or alias ARN.

##### profile?

> `optional` **profile?**: `string`

Named profile from the AWS shared config files.

##### provider

> **provider**: `"aws"`

##### region?

> `optional` **region?**: `string`

AWS region. A region inside an ARN takes precedence and must not conflict with this one.

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

##### approvalTimeoutMs?

> `optional` **approvalTimeoutMs?**: `number`

Time budget for providers with an asynchronous approval step, in milliseconds. Overrides
`kms.defaults.approvalTimeoutMs`.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`approvalTimeoutMs`](#approvaltimeoutms-10)

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

##### approvalTimeoutMs?

> `optional` **approvalTimeoutMs?**: `number`

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`approvalTimeoutMs`](#approvaltimeoutms-9)

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

##### approvalTimeoutMs?

> `optional` **approvalTimeoutMs?**: `number`

Time budget for providers with an asynchronous approval step, in milliseconds. Overrides
`kms.defaults.approvalTimeoutMs`.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`approvalTimeoutMs`](#approvaltimeoutms-10)

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

##### approvalTimeoutMs?

> `optional` **approvalTimeoutMs?**: `number`

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`approvalTimeoutMs`](#approvaltimeoutms-9)

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

##### approvalTimeoutMs?

> `optional` **approvalTimeoutMs?**: `number`

Time budget for providers with an asynchronous approval step, in milliseconds. Overrides
`kms.defaults.approvalTimeoutMs`.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`approvalTimeoutMs`](#approvaltimeoutms-10)

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

##### approvalTimeoutMs?

> `optional` **approvalTimeoutMs?**: `number`

###### Inherited from

[`KmsKeyCommonConfig`](#kmskeycommonconfig).[`approvalTimeoutMs`](#approvaltimeoutms-9)

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

##### approvalTimeoutMs?

> `optional` **approvalTimeoutMs?**: `number`

Time budget for providers with an asynchronous approval step, in milliseconds. Overrides
`kms.defaults.approvalTimeoutMs`.

###### Inherited from

[`KmsKeyCommonUserConfig`](#kmskeycommonuserconfig).[`approvalTimeoutMs`](#approvaltimeoutms-10)

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

**`Experimental`**

What a key is, in terms that are safe to print.

May gain fields before 1.0.

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

Sends through it bypass the plugin's send lock, nonce tracking and retry cache: viem fills the
transaction and sends it with `eth_sendRawTransaction` itself. To send from a KMS account, use
`connection.viem.getWalletClient(address)` instead.

#### Extended by

- [`KmsRawSignAccount`](#kmsrawsignaccount)

#### Properties

##### address

> `readonly` **address**: `` `0x${string}` ``

The checksummed address.

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

##### defaults

> **defaults**: \{ `approvalTimeoutMs?`: `number`; `aws`: \{ `region?`: `string`; \}; `timeoutMs`: `number`; \}

###### approvalTimeoutMs?

> `optional` **approvalTimeoutMs?**: `number`

###### aws

> **aws**: \{ `region?`: `string`; \}

###### aws.region?

> `optional` **region?**: `string`

###### timeoutMs

> **timeoutMs**: `number`

##### keys

> **keys**: `Record`\<`string`, [`KmsKeyConfig`](#kmskeyconfig)\>

##### simulatedBalance?

> `optional` **simulatedBalance?**: `bigint`

---

### KmsHooks

**`Experimental`**

The `kms` hook category, which provider plugins use to add their adapters.

The hook may change before 1.0.

#### Methods

##### createKeyAdapter()

> **createKeyAdapter**(`context`: `HookContext`, `key`: [`KmsKeyConfig`](#kmskeyconfig), `next`: (`nextContext`: `HookContext`, `nextKey`: [`KmsKeyConfig`](#kmskeyconfig)) => `Promise`\<[`KmsKeyAdapter`](#kmskeyadapter)\>): `Promise`\<[`KmsKeyAdapter`](#kmskeyadapter)\>

Builds the adapter for one key. A handler builds adapters for its own provider ids and calls
`next` for any other key. The first-party provider packages, such as hardhat-kms-aws, use
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

**`Experimental`**

The contract every KMS/HSM provider implements.

An adapter needs at least one way to identify the key (`getPublicKey` or `getAddress`) and
at least one way to sign. The core prefers the structured methods when present and falls back
to `signDigest`; it always verifies the returned signature against the key.

Transaction methods are added in the transaction milestone; the contract is frozen
at 1.0.

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

##### approvalTimeoutMs?

> `optional` **approvalTimeoutMs?**: `number`

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

##### approvalTimeoutMs?

> `optional` **approvalTimeoutMs?**: `number`

Time budget for providers with an asynchronous approval step, in milliseconds. Overrides
`kms.defaults.approvalTimeoutMs`.

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

##### v

> **v**: `bigint`

27 or 28.

##### yParity

> **yParity**: `number`

0 or 1.

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

##### defaults?

> `optional` **defaults?**: \{ `approvalTimeoutMs?`: `number`; `aws?`: \{ `region?`: `string`; \}; `timeoutMs?`: `number`; \}

###### approvalTimeoutMs?

> `optional` **approvalTimeoutMs?**: `number`

Default time budget for providers with an asynchronous approval step, in milliseconds.

###### aws?

> `optional` **aws?**: \{ `region?`: `string`; \}

Defaults for AWS keys.

###### aws.region?

> `optional` **region?**: `string`

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

**`Experimental`**

Per-call context passed to provider adapters.

May gain fields before 1.0.

#### Properties

##### chainId?

> `optional` **chainId?**: `bigint`

The chain the signature is for, when known.

##### idempotencyKey?

> `optional` **idempotencyKey?**: `string`

Present for transaction sends; lets remote broadcasters deduplicate retries.

##### requestId

> **requestId**: `string`

Identifies this call in logs and in provider requests.

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
