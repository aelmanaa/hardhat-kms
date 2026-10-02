# hardhat-kms/provider-utils

**`Experimental`**

Helpers for provider plugins: the first-party provider packages build on them, and third-party
providers may too.

This module may change before 1.0.

## Classes

### InvalidPublicKeyError

**`Experimental`**

Error thrown when a provider returns a public key that is not a usable secp256k1 key.

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new InvalidPublicKeyError**(`message?`: `string`): [`InvalidPublicKeyError`](#invalidpublickeyerror)

**`Experimental`**

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

**`Experimental`**

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

**`Experimental`**

###### Overrides

`Error.name`

## Interfaces

### EcJsonWebKey

**`Experimental`**

The JSON Web Key fields that describe an elliptic-curve public key.

#### Properties

##### crv?

> `optional` **crv?**: `string`

**`Experimental`**

Curve name. Azure uses `P-256K` for secp256k1.

##### kty?

> `optional` **kty?**: `string`

**`Experimental`**

Key type. Azure Key Vault uses `EC`, Managed HSM and HSM-backed vault keys use `EC-HSM`.

##### x?

> `optional` **x?**: `string` \| `Uint8Array`\<`ArrayBufferLike`\>

**`Experimental`**

X coordinate, big-endian. Azure may omit leading zero bytes.

##### y?

> `optional` **y?**: `string` \| `Uint8Array`\<`ArrayBufferLike`\>

**`Experimental`**

Y coordinate, big-endian. Azure may omit leading zero bytes.

---

### ErrorDetails

**`Experimental`**

The only details an error may carry. Everything here is safe to print: no credentials, no
tokens, no raw SDK error objects (they can hold request metadata and headers).

#### Properties

##### key?

> `optional` **key?**: `string`

**`Experimental`**

The key's display id (masked when it came from a configuration variable).

##### operation?

> `optional` **operation?**: `string`

**`Experimental`**

What was being done, for example `sign` or `get public key`.

##### provider?

> `optional` **provider?**: `string`

**`Experimental`**

Provider id, for example `aws`.

---

### ErrorEntry

**`Experimental`**

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

**`Experimental`**

What causes it, in a sentence or two.

##### fix

> `readonly` **fix**: `string`

**`Experimental`**

What to do about it.

##### group

> `readonly` **group**: `string`

**`Experimental`**

The heading the reference lists the entry under, such as `Signing`.

##### id

> `readonly` **id**: `string`

**`Experimental`**

Stable id, `<package>.<area>.<name>`, such as `aws.sign.response-key-mismatch`.

##### kind

> `readonly` **kind**: `Kind`

**`Experimental`**

What the entry describes.

##### template

> `readonly` **template**: `Template`

**`Experimental`**

The message, with `{name}` placeholders.

---

### ParsedAwsKeyId

**`Experimental`**

A parsed AWS KMS key reference.

#### Properties

##### kind

> **kind**: `"keyId"` \| `"keyArn"` \| `"aliasName"` \| `"aliasArn"`

**`Experimental`**

##### region?

> `optional` **region?**: `string`

**`Experimental`**

The region, for ARNs.

---

### ParsedAzureKeyId

**`Experimental`**

A parsed Azure key identifier.

#### Properties

##### keyName

> **keyName**: `string`

**`Experimental`**

##### keyVersion?

> `optional` **keyVersion?**: `string`

**`Experimental`**

##### vaultUrl

> **vaultUrl**: `string`

**`Experimental`**

`https://<host>`, without a trailing slash.

## Type Aliases

### ErrorKind

> **ErrorKind** = `"error"` \| `"reason"` \| `"validation"` \| `"internal"`

**`Experimental`**

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

**`Experimental`**

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

**`Experimental`**

A value a message template placeholder takes.

## Functions

### catalogError()

> **catalogError**\<`Template` _extends_ `string`\>(`entry`: [`ErrorEntry`](#errorentry)\<`Template`, `"error"`\>, `params`: [`TemplateParams`](#templateparams)\<`Template`\>, `details?`: [`ErrorDetails`](#errordetails)): `HardhatPluginError`

**`Experimental`**

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

**`Experimental`**

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

**`Experimental`**

Checks that a first-party provider package, such as hardhat-kms-aws, is the same version as the
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

**`Experimental`**

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

**`Experimental`**

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

### kmsError()

> **kmsError**(`message`: `string`, `details?`: [`ErrorDetails`](#errordetails)): `HardhatPluginError`

**`Experimental`**

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

**`Experimental`**

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

**`Experimental`**

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

**`Experimental`**

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

**`Experimental`**

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

**`Experimental`**

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
