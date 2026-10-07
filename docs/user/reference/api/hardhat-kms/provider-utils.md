---
title: hardhat-kms/provider-utils
description: Helpers for writing a KMS provider plugin for hardhat-kms, the same ones the AWS, Google Cloud and Azure packages use; experimental.
---

# hardhat-kms/provider-utils

**`Experimental`**

Helpers for provider plugins: the first-party provider packages build on them, and third-party
providers may too.

This module may change before 1.0.

## Classes

### InvalidPublicKeyError

Error thrown when a provider returns a public key that is not a usable secp256k1 key.

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new InvalidPublicKeyError**(`message?`: `string`): [`InvalidPublicKeyError`](#invalidpublickeyerror)

###### Parameters

| Parameter  | Type     |
| ---------- | -------- |
| `message?` | `string` |

###### Returns

[`InvalidPublicKeyError`](#invalidpublickeyerror)

###### Inherited from

`Error.constructor`

##### Constructor

> **new InvalidPublicKeyError**(`message?`: `string`, `options?`: `ErrorOptions`): [`InvalidPublicKeyError`](#invalidpublickeyerror)

###### Parameters

| Parameter  | Type           |
| ---------- | -------------- |
| `message?` | `string`       |
| `options?` | `ErrorOptions` |

###### Returns

[`InvalidPublicKeyError`](#invalidpublickeyerror)

###### Inherited from

`Error.constructor`

#### Properties

##### name

> `readonly` **name**: `"InvalidPublicKeyError"` = `"InvalidPublicKeyError"`

###### Overrides

`Error.name`

## Interfaces

### EcJsonWebKey

The JSON Web Key fields that describe an elliptic-curve public key.

#### Properties

##### crv?

> `optional` **crv?**: `string`

Curve name. Azure uses `P-256K` for secp256k1.

##### kty?

> `optional` **kty?**: `string`

Key type. Azure Key Vault uses `EC`, Managed HSM and HSM-backed vault keys use `EC-HSM`.

##### x?

> `optional` **x?**: `string` \| `Uint8Array`\<`ArrayBufferLike`\>

X coordinate, big-endian. Azure may omit leading zero bytes.

##### y?

> `optional` **y?**: `string` \| `Uint8Array`\<`ArrayBufferLike`\>

Y coordinate, big-endian. Azure may omit leading zero bytes.

---

### ErrorDetails

The only details an error may carry. Everything here is safe to print: no credentials, no
tokens, no raw SDK error objects (they can hold request metadata and headers).

#### Properties

##### key?

> `optional` **key?**: `string`

The key's display id (masked when it came from a configuration variable).

##### operation?

> `optional` **operation?**: `string`

What was being done, for example `sign` or `get public key`.

##### provider?

> `optional` **provider?**: `string`

Provider id, for example `aws`.

---

### ErrorEntry

One entry of an error catalogue: a stable id, a message template, and what causes the error and
how to fix it. `docs/user/reference/errors.md` is generated from the catalogues.

#### Type Parameters

| Type Parameter                             | Default type              |
| ------------------------------------------ | ------------------------- |
| `Template` _extends_ `string`              | `string`                  |
| `Kind` _extends_ [`ErrorKind`](#errorkind) | [`ErrorKind`](#errorkind) |

#### Properties

##### cause

> `readonly` **cause**: `string`

What causes it, in a sentence or two.

##### fix

> `readonly` **fix**: `string`

What to do about it.

##### group

> `readonly` **group**: `string`

The heading the reference lists the entry under, such as `Signing`.

##### id

> `readonly` **id**: `string`

Stable id, `<package>.<area>.<name>`, such as `aws.sign.response-key-mismatch`.

##### kind

> `readonly` **kind**: `Kind`

What the entry describes.

##### template

> `readonly` **template**: `Template`

The message, with `{name}` placeholders.

---

### KmsDebugLogger()

A logger that only accepts plain values; see [kmsDebug](#kmsdebug).

> **KmsDebugLogger**(`format`: `string`, ...`values`: [`DebugValue`](#debugvalue)[]): `void`

A logger that only accepts plain values; see [kmsDebug](#kmsdebug).

#### Parameters

| Parameter   | Type                          |
| ----------- | ----------------------------- |
| `format`    | `string`                      |
| ...`values` | [`DebugValue`](#debugvalue)[] |

#### Returns

`void`

#### Properties

##### enabled

> `readonly` **enabled**: `boolean`

---

### ParsedAwsKeyId

A parsed AWS KMS key reference.

#### Properties

##### kind

> **kind**: `"keyId"` \| `"keyArn"` \| `"aliasName"` \| `"aliasArn"`

##### region?

> `optional` **region?**: `string`

The region, for ARNs.

---

### ParsedAzureKeyId

A parsed Azure key identifier.

#### Properties

##### keyName

> **keyName**: `string`

##### keyVersion?

> `optional` **keyVersion?**: `string`

##### vaultUrl

> **vaultUrl**: `string`

`https://<host>`, without a trailing slash.

## Type Aliases

### DebugValue

> **DebugValue** = `string` \| `number` \| `bigint` \| `boolean` \| `undefined`

A value a debug line may contain. Objects and errors are refused: they print whole.

---

### ErrorKind

> **ErrorKind** = `"error"` \| `"reason"` \| `"validation"` \| `"internal"`

What an error catalogue entry describes:

- `error`: an error the plugin throws, built with [catalogError](#catalogerror) (or with
  [catalogMessage](#catalogmessage) for an error class of its own).
- `reason`: text that another entry's message includes in a placeholder, such as why a public
  key was refused. Built with [catalogMessage](#catalogmessage).
- `validation`: a config validation message, which Hardhat shows after the config path.
  Built with [catalogMessage](#catalogmessage).
- `internal`: a plain `Error` that only a bug or a broken install can cause, built with
  [internalError](#internalerror).

---

### TemplateParams

> **TemplateParams**\<`Template` _extends_ `string`\> = `string` _extends_ `Template` ? `never` : \[`PlaceholderName`\<`Template`\>\] _extends_ \[`never`\] ? `Readonly`\<`Record`\<`string`, `never`\>\> : `{ readonly [Name in PlaceholderName<Template>]: TemplateValue }`

The values a message template needs: one per `{name}` placeholder, and no other key. Braces
around anything other than a name, such as `{name, type}`, are literal text, and a template is
read from each `{` to the next `}`, as the catalogue helpers fill it.

- For a union of templates, such as an entry picked from a map, the values must fill every one.
- A template without placeholders takes an empty object.
- A template typed only as `string` has unknown placeholders, so no value can be given for it.

#### Type Parameters

| Type Parameter                |
| ----------------------------- |
| `Template` _extends_ `string` |

---

### TemplateValue

> **TemplateValue** = `string` \| `number` \| `bigint`

A value a message template placeholder takes.

## Functions

### auditLogAccessDenied()

> **auditLogAccessDenied**(`permission`: `string` \| readonly `string`[], `details?`: [`ErrorDetails`](#errordetails)): `HardhatPluginError`

The error a history reader throws when the provider refuses to return log entries: it names the
permissions to grant. Throwing it, rather than returning no events, keeps `kms history` from
reporting an empty history for a log it could not read.

A value that looks like it could carry an id is not printed: the error then says that the read
was refused and that the reader named the permission in a form the plugin does not print.

#### Parameters

| Parameter    | Type                            | Description                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission` | `string` \| readonly `string`[] | What to grant, such as `cloudtrail:LookupEvents`, or several values, such as the two Azure permissions. Never an id: each at most 200 letters, digits, spaces and `. , : ; ( ) _ / * -`, with no URL, ARN, alias, `projects/` path, Azure host, or run of five digits or eight hex characters. |
| `details?`   | [`ErrorDetails`](#errordetails) | The provider, the operation and the key's display id.                                                                                                                                                                                                                                          |

#### Returns

`HardhatPluginError`

The error to throw.

---

### auditLogThrottled()

> **auditLogThrottled**(`limit`: `string`, `details?`: [`ErrorDetails`](#errordetails)): `HardhatPluginError`

The error a history reader throws when the provider keeps throttling its reads after the
reader's own retries.

#### Parameters

| Parameter  | Type                            | Description                                                                                                                                                  |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `limit`    | `string`                        | The provider's documented limit, such as `2 requests per second`. Never an id, with the same rules as a permission. A value that breaks them is not printed. |
| `details?` | [`ErrorDetails`](#errordetails) | The provider, the operation and the key's display id.                                                                                                        |

#### Returns

`HardhatPluginError`

The error to throw.

---

### catalogError()

> **catalogError**\<`Template` _extends_ `string`\>(`entry`: [`ErrorEntry`](#errorentry)\<`Template`, `"error"`\>, `params`: [`TemplateParams`](#templateparams)\<`Template`\>, `details?`: [`ErrorDetails`](#errordetails)): `HardhatPluginError`

Builds the `HardhatPluginError` a catalogue entry describes, with [kmsError](#kmserror)'s prefix.

For hardhat-kms and its first-party provider packages; a third-party provider uses
[kmsError](#kmserror).

#### Type Parameters

| Type Parameter                |
| ----------------------------- |
| `Template` _extends_ `string` |

#### Parameters

| Parameter  | Type                                                 | Description                                                 |
| ---------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| `entry`    | [`ErrorEntry`](#errorentry)\<`Template`, `"error"`\> | An `error` entry.                                           |
| `params`   | [`TemplateParams`](#templateparams)\<`Template`\>    | A value for each placeholder of its template.               |
| `details?` | [`ErrorDetails`](#errordetails)                      | Optional context, limited to fields that are safe to print. |

#### Returns

`HardhatPluginError`

The error to throw.

---

### catalogMessage()

> **catalogMessage**\<`Template` _extends_ `string`\>(`entry`: [`ErrorEntry`](#errorentry)\<`Template`, `"error"` \| `"reason"` \| `"validation"`\>, `params`: [`TemplateParams`](#templateparams)\<`Template`\>): `string`

Builds the text of a `reason` or `validation` entry, or of an `error` entry for an error class
of its own, such as one that carries a transaction hash.

For hardhat-kms and its first-party provider packages; a third-party provider uses
[kmsError](#kmserror).

#### Type Parameters

| Type Parameter                |
| ----------------------------- |
| `Template` _extends_ `string` |

#### Parameters

| Parameter | Type                                                                                 | Description                                   |
| --------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| `entry`   | [`ErrorEntry`](#errorentry)\<`Template`, `"error"` \| `"reason"` \| `"validation"`\> | A `reason`, `validation` or `error` entry.    |
| `params`  | [`TemplateParams`](#templateparams)\<`Template`\>                                    | A value for each placeholder of its template. |

#### Returns

`string`

The text.

---

### checkProviderVersion()

> **checkProviderVersion**(`packageName`: `string`, `version`: `string`, `details?`: [`ErrorDetails`](#errordetails)): `void`

Checks that a first-party provider package, such as @hardhat-kms/aws, is the same version as the
installed hardhat-kms. They are released together, and the `kms` hook may change between
versions before 1.0. npm refuses such an install, but pnpm and Yarn only warn. Third-party
providers have their own versions and should not call this.

#### Parameters

| Parameter     | Type                            | Description                                                     |
| ------------- | ------------------------------- | --------------------------------------------------------------- |
| `packageName` | `string`                        | The provider package.                                           |
| `version`     | `string`                        | The provider package's version.                                 |
| `details?`    | [`ErrorDetails`](#errordetails) | Context for the error, such as the provider, operation and key. |

#### Returns

`void`

#### Throws

A `HardhatPluginError` that names both versions and the install command.

---

### crc32c()

> **crc32c**(`bytes`: `Uint8Array`): `number`

Computes the CRC-32C checksum of `bytes`.

#### Parameters

| Parameter | Type         | Description           |
| --------- | ------------ | --------------------- |
| `bytes`   | `Uint8Array` | The data to checksum. |

#### Returns

`number`

The checksum as an unsigned 32-bit integer.

---

### internalError()

> **internalError**\<`Template` _extends_ `string`\>(`entry`: [`ErrorEntry`](#errorentry)\<`Template`, `"internal"`\>, `params`: [`TemplateParams`](#templateparams)\<`Template`\>): `Error`

Builds the plain `Error` an `internal` entry describes: a state that only a bug or a broken
install can reach.

For hardhat-kms and its first-party provider packages; a third-party provider uses
[kmsError](#kmserror).

#### Type Parameters

| Type Parameter                |
| ----------------------------- |
| `Template` _extends_ `string` |

#### Parameters

| Parameter | Type                                                    | Description                                   |
| --------- | ------------------------------------------------------- | --------------------------------------------- |
| `entry`   | [`ErrorEntry`](#errorentry)\<`Template`, `"internal"`\> | An `internal` entry.                          |
| `params`  | [`TemplateParams`](#templateparams)\<`Template`\>       | A value for each placeholder of its template. |

#### Returns

`Error`

The error to throw.

---

### kmsDebug()

> **kmsDebug**(`namespace`: `string`): [`KmsDebugLogger`](#kmsdebuglogger)

Creates a logger under the plugin's `hardhat:kms:*` debug namespace, for a provider package. It
writes to standard error when `DEBUG` matches, for example `DEBUG=hardhat:kms:*`, and `DEBUG` is
read when the logger is created.

A provider package logs under its provider id, such as `azure` or `myvault`. The namespaces of
hardhat-kms itself (`account`, `config`, `history`, `providers`, `rpc` and `signer`) are refused,
so a provider's lines cannot pass for the core's.

Log only what is safe to print: display ids, addresses, digests, provider ids, operation names,
the plugin's own request ids, timings, error class names and SDK package details. Never log
configuration variable values, credentials, a provider's request details or its error text.
The logger accepts plain values only, and replaces any object or error it is given. A string is
printed as given, with only its control characters escaped, so never pass a variable's value or
a secret. Write the format as a string literal and pass every value through a `%s` or `%d`
placeholder: text built into the format is neither type-checked nor escaped.

#### Parameters

| Parameter   | Type     | Description                                                                                                    |
| ----------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `namespace` | `string` | The sub-namespace: the provider id, made of 1 to 64 lowercase letters, digits and `-`, starting with a letter. |

#### Returns

[`KmsDebugLogger`](#kmsdebuglogger)

The logger.

#### Throws

A `HardhatPluginError`: `core.provider.debug-namespace-reserved` for one of the core's
namespaces, and `core.provider.debug-namespace-invalid` for a name in any other form.

---

### kmsError()

> **kmsError**(`message`: `string`, `details?`: [`ErrorDetails`](#errordetails)): `HardhatPluginError`

Builds a `HardhatPluginError` from a message and allow-listed details.

#### Parameters

| Parameter  | Type                            | Description                                                 |
| ---------- | ------------------------------- | ----------------------------------------------------------- |
| `message`  | `string`                        | What went wrong and, when possible, how to fix it.          |
| `details?` | [`ErrorDetails`](#errordetails) | Optional context, limited to fields that are safe to print. |

#### Returns

`HardhatPluginError`

The error to throw.

---

### parseAwsKeyId()

> **parseAwsKeyId**(`value`: `string`): [`ParsedAwsKeyId`](#parsedawskeyid) \| `undefined`

Parses an AWS KMS key reference: a key id, key ARN, alias name or alias ARN.

#### Parameters

| Parameter | Type     | Description    |
| --------- | -------- | -------------- |
| `value`   | `string` | The reference. |

#### Returns

[`ParsedAwsKeyId`](#parsedawskeyid) \| `undefined`

Its kind, and the region for ARNs, or `undefined` if the value is not a valid reference.

---

### parseAzureKeyId()

> **parseAzureKeyId**(`value`: `string`): [`ParsedAzureKeyId`](#parsedazurekeyid) \| `undefined`

Parses a key identifier such as `https://my-vault.vault.azure.net/keys/deployer/0123abcd`.

#### Parameters

| Parameter | Type     | Description                           |
| --------- | -------- | ------------------------------------- |
| `value`   | `string` | The key identifier, versioned or not. |

#### Returns

[`ParsedAzureKeyId`](#parsedazurekeyid) \| `undefined`

Its parts, or `undefined` if it is not an Azure key identifier.

---

### publicKeyFromJwk()

> **publicKeyFromJwk**(`jwk`: [`EcJsonWebKey`](#ecjsonwebkey)): `Uint8Array`

Builds the uncompressed public key from a JSON Web Key (as returned by Azure Key Vault).

Coordinates may be raw bytes or base64url strings, and may be shorter than 32 bytes when
the service strips leading zeros; they are left-padded before use.

#### Parameters

| Parameter | Type                            | Description       |
| --------- | ------------------------------- | ----------------- |
| `jwk`     | [`EcJsonWebKey`](#ecjsonwebkey) | The JSON Web Key. |

#### Returns

`Uint8Array`

The 65-byte uncompressed public key.

#### Throws

If the key type or curve is wrong, or the point is not on the curve.

---

### publicKeyFromSpkiDer()

> **publicKeyFromSpkiDer**(`der`: `Uint8Array`): `Uint8Array`

Parses a DER-encoded SubjectPublicKeyInfo (as returned by AWS KMS `GetPublicKey`).

#### Parameters

| Parameter | Type         | Description                      |
| --------- | ------------ | -------------------------------- |
| `der`     | `Uint8Array` | The SPKI structure, DER encoded. |

#### Returns

`Uint8Array`

The 65-byte uncompressed public key.

#### Throws

If the key is not a valid secp256k1 key.

---

### publicKeyFromSpkiPem()

> **publicKeyFromSpkiPem**(`pem`: `string`): `Uint8Array`

Parses a PEM-encoded SubjectPublicKeyInfo (as returned by GCP Cloud KMS `getPublicKey`).

#### Parameters

| Parameter | Type     | Description                      |
| --------- | -------- | -------------------------------- |
| `pem`     | `string` | The SPKI structure, PEM encoded. |

#### Returns

`Uint8Array`

The 65-byte uncompressed public key.

#### Throws

If the key is not a valid secp256k1 key.
