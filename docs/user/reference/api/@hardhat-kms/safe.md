---
title: "@hardhat-kms/safe"
description: "The @hardhat-kms/safe entry point: the plugin that adds kms safe propose, and proposeSafeTransaction, which proposes a Safe transaction from code."
---

# @hardhat-kms/safe

The `@hardhat-kms/safe` package: signs Safe multisig transactions with a hardhat-kms key and
proposes them to the Safe Transaction Service. The default export is the Hardhat plugin, which
adds `kms safe propose` and the `kmsSafe` config section; `proposeSafeTransaction` does the
same from code.

## Classes

### TransactionServiceClient

A client for the two calls the proposer makes to a Safe Transaction Service: the highest queued
nonce and the proposal. It uses the global `fetch` with a timeout, never follows a redirect, and
puts neither the API key nor the service's answer in an error, apart from the allow-listed
reasons of a 400 or 422.

#### Constructors

##### Constructor

> **new TransactionServiceClient**(`options`: [`TransactionServiceOptions`](#transactionserviceoptions)): [`TransactionServiceClient`](#transactionserviceclient)

###### Parameters

| Parameter | Type                                                      | Description                               |
| --------- | --------------------------------------------------------- | ----------------------------------------- |
| `options` | [`TransactionServiceOptions`](#transactionserviceoptions) | Where the service is and how to reach it. |

###### Returns

[`TransactionServiceClient`](#transactionserviceclient)

#### Accessors

##### url

###### Get Signature

> **get** **url**(): `string`

The service's root, without a trailing slash.

###### Returns

`string`

#### Methods

##### highestQueuedNonce()

> **highestQueuedNonce**(`safe`: `` `0x${string}` ``, `fromNonce`: `bigint`, `signal?`: `AbortSignal`): `Promise`\<`bigint` \| `undefined`\>

The highest nonce among the Safe's queued transactions from `fromNonce` on, as api-kit's
`getPendingTransactions` asks for them, sorted so that the first one is the highest.

###### Parameters

| Parameter   | Type                | Description                                       |
| ----------- | ------------------- | ------------------------------------------------- |
| `safe`      | `` `0x${string}` `` | The Safe, checksummed.                            |
| `fromNonce` | `bigint`            | The Safe's on-chain nonce: lower nonces have run. |
| `signal?`   | `AbortSignal`       | Stops the request.                                |

###### Returns

`Promise`\<`bigint` \| `undefined`\>

The highest queued nonce, or `undefined` when nothing is queued.

##### propose()

> **propose**(`safe`: `` `0x${string}` ``, `body`: `ProposalBody`, `signal?`: `AbortSignal`): `Promise`\<`void`\>

Posts a signed proposal. The service answers 201 with an empty body.

###### Parameters

| Parameter | Type                | Description                                |
| --------- | ------------------- | ------------------------------------------ |
| `safe`    | `` `0x${string}` `` | The Safe, checksummed.                     |
| `body`    | `ProposalBody`      | The proposal, as `proposalBody` builds it. |
| `signal?` | `AbortSignal`       | Stops the request.                         |

###### Returns

`Promise`\<`void`\>

## Interfaces

### Eip1193Provider

The part of an EIP-1193 provider the proposer uses, such as a Hardhat connection's `provider`.

#### Methods

##### request()

> **request**(`args`: \{ `method`: `string`; `params?`: `unknown`[]; \}): `Promise`\<`unknown`\>

Sends a JSON-RPC request.

###### Parameters

| Parameter      | Type                                              |
| -------------- | ------------------------------------------------- |
| `args`         | \{ `method`: `string`; `params?`: `unknown`[]; \} |
| `args.method`  | `string`                                          |
| `args.params?` | `unknown`[]                                       |

###### Returns

`Promise`\<`unknown`\>

---

### KmsSafeConfig

`kmsSafe` after Hardhat resolved the config.

#### Properties

##### apiKey

> **apiKey**: `ResolvedConfigurationVariable` \| `undefined`

The API key's variable, read only when a proposal goes to the service.

##### services

> **services**: `Record`\<`string`, `string`\>

Self-hosted services by decimal chain id.

##### timeoutMs

> **timeoutMs**: `number`

How long each request may take, in milliseconds.

---

### KmsSafeUserConfig

`kmsSafe` in the Hardhat config: where `kms safe propose` sends proposals.

#### Properties

##### apiKey?

> `optional` **apiKey?**: `ConfigurationVariable`

The Safe Transaction Service API key from developer.safe.global, as
`configVariable("SAFE_TRANSACTION_SERVICE_API_KEY")`. Never the key itself: config validation
refuses a string. Safe's hosted service needs it; a self-hosted one may not.

##### services?

> `optional` **services?**: `Record`\<`string`, `string`\>

The root of a self-hosted Transaction Service per decimal chain id, without `/api`, such as
`{ "11155111": "https://safe-transaction.example.com" }`. It replaces Safe's hosted service
for that chain.

##### timeoutMs?

> `optional` **timeoutMs?**: `number`

How long each request to the service may take, in milliseconds; 30000 by default.

---

### ProposeSafeTransactionOptions

What to propose, and where.

#### Properties

##### allowDelegateCall?

> `optional` **allowDelegateCall?**: `boolean`

Allow `operation: 1`, a delegatecall: the Safe runs the target's code with its own storage.

##### approve?

> `optional` **approve?**: (`review`: [`SafeTransactionReview`](#safetransactionreview)) => `Promise`\<`boolean`\>

Called after every check and before the key signs. Return `false` to stop: nothing is signed
and the call fails with `safe.task.declined`. The `kms safe propose` task asks a person here
when the threshold is 1.

###### Parameters

| Parameter | Type                                              |
| --------- | ------------------------------------------------- |
| `review`  | [`SafeTransactionReview`](#safetransactionreview) |

###### Returns

`Promise`\<`boolean`\>

##### call

> **call**: [`SafeCall`](#safecall)

The call the Safe makes.

##### expectedChainId?

> `optional` **expectedChainId?**: `bigint`

The chain the connection must be on, such as the network's configured `chainId`.

##### nonce?

> `optional` **nonce?**: `bigint`

The Safe nonce. By default the next one: one above the highest queued transaction, or the
Safe's nonce when nothing is queued. A nonce below the Safe's nonce is refused.

##### origin?

> `optional` **origin?**: `string`

A label the Safe app shows next to the transaction.

##### provider

> **provider**: [`Eip1193Provider`](#eip1193provider)

A connection that signs for `sender` with `eth_signTypedData_v4`, such as a Hardhat network
connection's `provider`.

##### safe

> **safe**: `string`

The Safe.

##### sender

> **sender**: `string`

The owner that signs: an address the connection signs for, such as a KMS account, a key in
the network's `accounts` or a Ledger address in its `ledgerAccounts`. The function sends the
signing request for this address to `provider` as it is: on a Hardhat `http` network whose
`accounts` is `"remote"`, Hardhat forwards a request for an address it does not hold to the
node, which signs with its own key. The `kms safe propose` task refuses that; this function
cannot tell, so pass only an address the connection signs for in this process.

##### service

> **service**: [`TransactionServiceClient`](#transactionserviceclient)

The Transaction Service to propose to.

##### signal?

> `optional` **signal?**: `AbortSignal`

Stops the requests to the service.

---

### SafeCall

What to propose: one call from the Safe. The gas refund fields are always zero.

#### Properties

##### data?

> `optional` **data?**: `string`

The call data, `0x`-prefixed hex; `0x` by default.

##### operation?

> `optional` **operation?**: [`Operation`](#operation-2)

`1` for a delegatecall, which needs `allowDelegateCall`; `0` by default.

##### to

> **to**: `string`

The target: a contract or an account.

##### value?

> `optional` **value?**: `bigint`

Wei the Safe sends; 0 by default.

---

### SafeProposal

A proposal the service stored.

#### Extends

- [`SafeTransactionReview`](#safetransactionreview)

#### Properties

##### chainId

> **chainId**: `bigint`

The connection's chain.

###### Inherited from

[`SafeTransactionReview`](#safetransactionreview).[`chainId`](#chainid-1)

##### domainHash

> **domainHash**: `` `0x${string}` ``

The EIP-712 domain separator of the Safe on this chain: the "Domain hash" a Ledger shows when
it signs blind, and the Safe app shows.

###### Inherited from

[`SafeTransactionReview`](#safetransactionreview).[`domainHash`](#domainhash-1)

##### link

> **link**: `string` \| `undefined`

The Safe app's page for the transaction, for a chain Safe's hosted service serves.

##### messageHash

> **messageHash**: `` `0x${string}` ``

The hash of the SafeTx struct: the "Message hash" a Ledger and the Safe app show.

###### Inherited from

[`SafeTransactionReview`](#safetransactionreview).[`messageHash`](#messagehash-1)

##### owners

> **owners**: `` `0x${string}` ``[]

The Safe's owners at the latest block.

###### Inherited from

[`SafeTransactionReview`](#safetransactionreview).[`owners`](#owners-1)

##### safe

> **safe**: `` `0x${string}` ``

The Safe, checksummed.

###### Inherited from

[`SafeTransactionReview`](#safetransactionreview).[`safe`](#safe-2)

##### safeNonce

> **safeNonce**: `bigint`

The Safe's on-chain nonce: the next transaction it executes.

###### Inherited from

[`SafeTransactionReview`](#safetransactionreview).[`safeNonce`](#safenonce-1)

##### safeTxHash

> **safeTxHash**: `` `0x${string}` ``

Its SafeTx hash, which the Safe's `getTransactionHash` returned too.

###### Inherited from

[`SafeTransactionReview`](#safetransactionreview).[`safeTxHash`](#safetxhash-1)

##### sender

> **sender**: `` `0x${string}` ``

The owner that signs.

###### Inherited from

[`SafeTransactionReview`](#safetransactionreview).[`sender`](#sender-2)

##### signature

> **signature**: `` `0x${string}` ``

The owner's 65-byte signature, with v 27 or 28.

##### threshold

> **threshold**: `bigint`

The Safe's threshold at the latest block.

###### Inherited from

[`SafeTransactionReview`](#safetransactionreview).[`threshold`](#threshold-1)

##### transaction

> **transaction**: [`SafeTransaction`](#safetransaction)

The transaction.

###### Inherited from

[`SafeTransactionReview`](#safetransactionreview).[`transaction`](#transaction-1)

##### version

> **version**: `"1.3.0"` \| `"1.4.1"` \| `"1.5.0"`

The Safe's `VERSION()`.

###### Inherited from

[`SafeTransactionReview`](#safetransactionreview).[`version`](#version-1)

---

### SafeTransaction

The fields of a `SafeTx`, as the Safe contract and the Transaction Service read them.

#### Properties

##### baseGas

> **baseGas**: `bigint`

Always 0.

##### data

> **data**: `` `0x${string}` ``

The call data, lowercase hex.

##### gasPrice

> **gasPrice**: `bigint`

Always 0: whoever executes pays the gas, and the Safe pays nobody back.

##### gasToken

> **gasToken**: `` `0x${string}` ``

Always the zero address.

##### nonce

> **nonce**: `bigint`

The Safe nonce the transaction takes.

##### operation

> **operation**: [`Operation`](#operation-2)

`0` for a call, `1` for a delegatecall.

##### refundReceiver

> **refundReceiver**: `` `0x${string}` ``

Always the zero address.

##### safeTxGas

> **safeTxGas**: `bigint`

Always 0: the plugin proposes no gas refund.

##### to

> **to**: `` `0x${string}` ``

The call's target, checksummed.

##### value

> **value**: `bigint`

Wei the Safe sends with the call.

---

### SafeTransactionReview

What the key is about to sign, after every check before signing passed.

#### Extended by

- [`SafeProposal`](#safeproposal)

#### Properties

##### chainId

> **chainId**: `bigint`

The connection's chain.

##### domainHash

> **domainHash**: `` `0x${string}` ``

The EIP-712 domain separator of the Safe on this chain: the "Domain hash" a Ledger shows when
it signs blind, and the Safe app shows.

##### messageHash

> **messageHash**: `` `0x${string}` ``

The hash of the SafeTx struct: the "Message hash" a Ledger and the Safe app show.

##### owners

> **owners**: `` `0x${string}` ``[]

The Safe's owners at the latest block.

##### safe

> **safe**: `` `0x${string}` ``

The Safe, checksummed.

##### safeNonce

> **safeNonce**: `bigint`

The Safe's on-chain nonce: the next transaction it executes.

##### safeTxHash

> **safeTxHash**: `` `0x${string}` ``

Its SafeTx hash, which the Safe's `getTransactionHash` returned too.

##### sender

> **sender**: `` `0x${string}` ``

The owner that signs.

##### threshold

> **threshold**: `bigint`

The Safe's threshold at the latest block.

##### transaction

> **transaction**: [`SafeTransaction`](#safetransaction)

The transaction.

##### version

> **version**: `"1.3.0"` \| `"1.4.1"` \| `"1.5.0"`

The Safe's `VERSION()`.

---

### TransactionServiceOptions

How to reach a Transaction Service.

#### Properties

##### apiKey?

> `optional` **apiKey?**: `string`

The API key, sent as `Authorization: Bearer <key>` and nowhere else.

##### fetch?

> `optional` **fetch?**: (`input`: `string` \| `URL` \| `Request`, `init?`: `RequestInit`) => `Promise`\<`Response`\>

The `fetch` to call; the global one by default.

###### Parameters

| Parameter | Type                           |
| --------- | ------------------------------ |
| `input`   | `string` \| `URL` \| `Request` |
| `init?`   | `RequestInit`                  |

###### Returns

`Promise`\<`Response`\>

##### timeoutMs?

> `optional` **timeoutMs?**: `number`

How long each request may take, in milliseconds; 30000 by default.

##### url

> **url**: `string`

The service's root, without `/api`: `https://api.safe.global/tx-service/<shortName>` for
Safe's hosted service, or the root of a self-hosted one.

## Type Aliases

### Operation

> **Operation** = `0` \| `1`

`0` is a call; `1` is a delegatecall, which runs the target's code in the Safe's storage.

---

### SupportedVersion

> **SupportedVersion** = _typeof_ [`SUPPORTED_VERSIONS`](#supported_versions)\[`number`\]

A Safe version the plugin proposes for.

## Variables

### default

> `const` **default**: `HardhatPlugin`

The @hardhat-kms/safe plugin: `kms safe propose` signs a Safe transaction with an owner the
network signs for, a KMS account by default or the `--from` address, and proposes it to the Safe
Transaction Service. It loads hardhat-kms itself.

Add it to the `plugins` array of your Hardhat config, next to the provider package of a KMS key
if one signs.

---

### SERVICE\_CHAINS

> `const` **SERVICE\_CHAINS**: `ReadonlyMap`\<`bigint`, `string`\>

The chains Safe's hosted Transaction Service serves, with the short name of each, as
`@safe-global/api-kit` 5.0.4 lists them (`networks` in `src/utils/config.ts`). The service of
a chain is `https://api.safe.global/tx-service/<shortName>`, and the Safe app names a Safe as
`<shortName>:<address>`. The conformance test checks this table against api-kit's.

---

### SUPPORTED\_VERSIONS

> `const` **SUPPORTED\_VERSIONS**: readonly \[`"1.3.0"`, `"1.4.1"`, `"1.5.0"`\]

The Safe versions the plugin proposes for. Older Safes have no `chainId` in their domain.

## Functions

### assertProposerSignsInProcess()

> **assertProposerSignsInProcess**(`hre`: `HardhatRuntimeEnvironment`, `connection`: `NetworkConnection`, `address`: `string`): `Promise`\<`void`\>

Checks that a Hardhat network connection signs for `address` in this process, the rule
`kms safe propose --from` applies, so that a script can apply it before
[proposeSafeTransaction](#proposesafetransaction), which sends the signing request for its `sender` as it is.

The address must be in the connection's `eth_accounts`. It is then accepted when it is a Ledger
address of the network's `ledgerAccounts`, the address of one of its `kmsAccounts`, or any
account of a network where Hardhat signs every listed account itself: `edr-simulated`, or `http`
with `accounts` set to a list of keys or an HD config. On an `http` network with
`accounts: "remote"`, the default, or a network config this package does not recognise, the
other listed accounts are the node's, which the node would sign for, and they are refused.
Nothing is signed.

#### Parameters

| Parameter    | Type                        | Description                                               |
| ------------ | --------------------------- | --------------------------------------------------------- |
| `hre`        | `HardhatRuntimeEnvironment` | The Hardhat runtime, which reads the KMS keys' addresses. |
| `connection` | `NetworkConnection`         | A connection from `hre.network.create()`.                 |
| `address`    | `string`                    | The proposer.                                             |

#### Returns

`Promise`\<`void`\>

#### Throws

`safe.key.sender` for an address that is not one, `safe.key.not-an-account` when the
connection does not list it, `safe.key.node-account` when the node would sign for it, or the
KMS's error when no key matched and one could not be read.

---

### proposeSafeTransaction()

> **proposeSafeTransaction**(`options`: [`ProposeSafeTransactionOptions`](#proposesafetransactionoptions)): `Promise`\<[`SafeProposal`](#safeproposal)\>

Proposes a Safe transaction signed by `sender`, an account the connection signs for, such as a
KMS key, a key in the network's `accounts` or a Ledger. It reads the Safe on the connection's
chain and refuses, before anything is signed: a Safe with no code, a version other than 1.3.0,
1.4.1 or 1.5.0, a sender that is not an owner, a nonce below the Safe's, a delegatecall without
`allowDelegateCall`, and a hash that differs from the Safe's own `getTransactionHash`. The
sender signs the SafeTx as EIP-712 typed data through the connection's `eth_signTypedData_v4`;
for a KMS account, hardhat-kms also checks the typed data's chain and verifies the signature.
The signature must then have v 27 or 28, recover to the sender and pass the Safe's
`checkNSignatures`. Only then is it posted to the service. Gas refund fields are always zero.

This function does not ask anyone before it signs. A Safe whose threshold is 1 can execute the
transaction with this signature alone; pass `approve` to decide.

#### Parameters

| Parameter | Type                                                              | Description                 |
| --------- | ----------------------------------------------------------------- | --------------------------- |
| `options` | [`ProposeSafeTransactionOptions`](#proposesafetransactionoptions) | What to propose, and where. |

#### Returns

`Promise`\<[`SafeProposal`](#safeproposal)\>

The proposal the service stored.

#### Throws

A `HardhatPluginError` built from the package's error catalogue for each refusal.

---

### safeAppLink()

> **safeAppLink**(`chainId`: `bigint`, `safe`: `` `0x${string}` ``, `safeTxHash`: `` `0x${string}` ``): `string` \| `undefined`

The Safe app's page for a queued transaction.

#### Parameters

| Parameter    | Type                | Description            |
| ------------ | ------------------- | ---------------------- |
| `chainId`    | `bigint`            | The chain.             |
| `safe`       | `` `0x${string}` `` | The Safe, checksummed. |
| `safeTxHash` | `` `0x${string}` `` | The SafeTx hash.       |

#### Returns

`string` \| `undefined`

The link, or `undefined` for a chain the table does not list.

---

### safeTxHash()

> **safeTxHash**(`chainId`: `bigint`, `safe`: `` `0x${string}` ``, `tx`: [`SafeTransaction`](#safetransaction)): `` `0x${string}` ``

The SafeTx hash, computed with viem, apart from hardhat-kms's encoder, which builds the digest
the key signs.

#### Parameters

| Parameter | Type                                  | Description       |
| --------- | ------------------------------------- | ----------------- |
| `chainId` | `bigint`                              | The Safe's chain. |
| `safe`    | `` `0x${string}` ``                   | The Safe.         |
| `tx`      | [`SafeTransaction`](#safetransaction) | The transaction.  |

#### Returns

`` `0x${string}` ``

The hash the owners sign and the Safe's `getTransactionHash` returns.

---

### serviceFor()

> **serviceFor**(`chainId`: `bigint`, `services`: `Readonly`\<`Record`\<`string`, `string`\>\>): \{ `hosted`: `boolean`; `url`: `string`; \} \| `undefined`

The root of the Transaction Service for a chain: the configured one, else Safe's hosted one.

#### Parameters

| Parameter  | Type                                         | Description                              |
| ---------- | -------------------------------------------- | ---------------------------------------- |
| `chainId`  | `bigint`                                     | The chain.                               |
| `services` | `Readonly`\<`Record`\<`string`, `string`\>\> | `kmsSafe.services`, by decimal chain id. |

#### Returns

\{ `hosted`: `boolean`; `url`: `string`; \} \| `undefined`

The root URL and whether it is Safe's hosted service, or `undefined` when neither
serves the chain.
