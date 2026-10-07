---
title: Library accounts reference
description: "connection.kms.getAccount returns a viem account for a KMS key, for signAuthorization, smart accounts and scripts: options, refusals, sending."
---

# Library accounts reference

Audience: Users and library authors who need a viem account object for a KMS key, for example for viem's `signAuthorization`, a smart-account SDK or a script outside a wallet client.

> [!WARNING]
> Send the account's transactions with a viem client whose transport is `custom(connection.provider)`. viem fills a local account's transaction and sends it with `eth_sendRawTransaction` itself. Through the connection, the account's sends and the plugin's own sends from the same key take turns and do not share a nonce, within the cases in [Sending](#sending). A client with its own transport, such as `http(url)`, never goes through Hardhat: its nonce is reserved for 60 s, but its broadcast is not ordered. If the same key also sends through the plugin, or through a second client, two failures can follow:
>
> - nonce too low: the two paths pick the same nonce, and the node refuses the second transaction;
> - on a real network, a same-nonce higher-fee replacement whose receipt viem returns as yours: the node keeps whichever transaction pays more, and viem's `waitForTransactionReceipt` follows the replacement and returns its receipt, so the code reads another transaction's receipt as the one it sent.
>
> Such a client prints a warning the first time it asks the account for a nonce.

## `connection.kms.getAccount`

Every network connection has a `kms` field. Its `getAccount` method returns a viem [`LocalAccount`](https://viem.sh/docs/accounts/local) whose key is one of the connection's KMS keys. Here the account signs an EIP-7702 authorization, and nothing is sent:

```ts
// Loads the types of `connection.kms`. hardhat.config.ts already does this in a project.
import "hardhat-kms";
import { network } from "hardhat";
import { createWalletClient, custom } from "viem";
import { sepolia } from "viem/chains";

const connection = await network.create("sepolia");
// The deployer key's address, from `npx hardhat kms address deployer`.
const account = await connection.kms.getAccount("0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826");

// The wallet client fills the chain id and the account's nonce, then the KMS key signs.
const authorization = await createWalletClient({
  account,
  chain: sepolia,
  transport: custom(connection.provider),
}).signAuthorization({ contractAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3" });
```

| Signature                                                    | Returns                      |
| ------------------------------------------------------------ | ---------------------------- |
| `getAccount(address)`                                        | `Promise<KmsAccount>`        |
| `getAccount(address, { rawSign: true })`                     | `Promise<KmsRawSignAccount>` |
| `getAccount(address, { allowChainZeroAuthorization: true })` | `Promise<KmsAccount>`        |

`address` must be the address of one of the connection's KMS accounts, from the network's `kmsAccounts` or from `--kms`. Any other address fails with the KMS addresses the connection has.

`getAccount` needs the `viem` package in the project. viem is an optional peer dependency of hardhat-kms: nothing else in the plugin loads it, and a project without it runs every task. Calling `getAccount` there fails with `connection.kms.getAccount needs the viem package, which could not be loaded`. The lowest viem version tested is 2.55.13, the floor of the peer range `^2.55.13`: earlier releases do not reset the account's nonce manager after every failed send, or can reset it for a send that never asked it for a nonce ([Sending](#sending)). Depending on the package manager and the project's own viem range, an install can leave viem below the range ([Package managers and the peer ranges](#package-managers-and-the-peer-ranges)), so `getAccount` checks viem's version too and refuses one below 2.55.13 with [`core.account.viem-too-old`](errors.md#library-accounts), before any KMS call. The check reads the viem that hardhat-kms resolves. In a workspace where the client's code resolves another, nested copy of viem, the check can pass while the client runs an older one; it is a best-effort check.

`getAccount` asks the KMS for the key's public key once, which also checks the key's `address` pin. Each method of the account then makes one KMS signing call.

The account belongs to its connection. After `connection.close()`, `getAccount` and every method of the accounts it returned refuse, before any KMS call, with `the connection to network … is closed`.

The types are exported from `hardhat-kms/types` (`KmsAccount`, `KmsRawSignAccount`, `KmsAccountOptions`, `KmsNetworkConnection`), and are written without viem's types, so a project without viem still typechecks. A test checks that they are assignable to viem's `LocalAccount`.

## Package managers and the peer ranges

hardhat-kms declares viem as an optional peer dependency with the range `^2.55.13`, and each provider package declares hardhat-kms as a peer dependency at its own exact version. Whether a project ends up outside these ranges depends on the package manager and on what the project already asks for.

The first table covers projects whose own spec allows no release in the peer range: viem pinned to `2.55.11`, viem `~2.54.0`, or a provider package at another version than hardhat-kms. Each project is new, with no lockfile, and installs hardhat-kms and `@hardhat-kms/aws` together:

| Package manager                         | viem `2.55.11` or `~2.54.0` in the project                                    | hardhat-kms at another version than the provider package                           |
| --------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| npm                                     | Stops with `ERESOLVE`, exit code 1.                                           | Stops with `ERESOLVE`, exit code 1.                                                |
| npm with `--legacy-peer-deps`           | Installs that viem. `getAccount` refuses it with `core.account.viem-too-old`. | Installs both. The first use of a key fails with `core.provider.version-mismatch`. |
| pnpm 12.8.1                             | Warns, installs that viem. `getAccount` refuses it.                           | Warns, installs both. The first use of a key fails.                                |
| Yarn 1.22.22                            | Installs that viem with no warning. `getAccount` refuses it.                  | Warns, installs both. The first use of a key fails.                                |
| Yarn 4.18.1, `nodeLinker: node-modules` | Warns (`YN0060`), installs that viem. `getAccount` refuses it.                | Warns, installs both. The first use of a key fails.                                |

With `~2.54.0`, each package manager in the table that installed resolved 2.54.6, the newest 2.54 release when measured.

The second table covers a project that has only `hardhat` and `viem` installed, with viem `^2.47.6` in `package.json` (the range Hardhat's viem template uses, which overlaps the peer range) and the older 2.52.2 in the lockfile. The plugin packages are then added with the package manager's add command, such as `npm install --save-dev hardhat-kms @hardhat-kms/aws`:

| Package manager                         | viem after adding the plugin packages                                             |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| npm                                     | Exit code 0. npm moves viem to the newest release, 2.57.2 when measured.          |
| npm with `--legacy-peer-deps`           | Exit code 0. viem stays at 2.52.2, and `getAccount` refuses it.                   |
| pnpm 12.8.1                             | Exit code 0. viem stays at 2.52.2, and `getAccount` refuses it.                   |
| Yarn 1.22.22                            | Exit code 0. viem stays at 2.52.2, and `getAccount` refuses it.                   |
| Yarn 4.18.1, `nodeLinker: node-modules` | Exit code 0, warns (`YN0060`). viem stays at 2.52.2, and `getAccount` refuses it. |

To move viem into the range with pnpm or Yarn, upgrade it as the fix of [`core.account.viem-too-old`](errors.md#library-accounts) shows.

Measured with Hardhat 3.18.0, Node 24.16.0 and npm 11.15.0; CI repeats the installs on Linux with the npm that ships with Node 24 (npm 11.19.0 on Node 24.21.0 for the first table).

## Options

| Option                        | Default | Effect                                                                                                                                                             |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rawSign`                     | `false` | Adds `sign({ hash })`, which signs a 32-byte digest as it is. A warning is printed each time such an account is made.                                              |
| `allowChainZeroAuthorization` | `false` | Lets `signAuthorization` sign for chain 0. A chain-0 authorization is valid on every chain where the account's nonce matches, as `kms sign-auth --force` signs it. |

Any other key in the options object is refused, so that a misspelled option is not silently ignored. Only the object's own properties count: an option inherited from a prototype, such as one a prototype-pollution bug sets on `Object.prototype`, is ignored.

## Methods

| Member              | What it signs                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `address`           | The checksummed address.                                                                                                                                                                                                                                                  |
| `publicKey`         | The uncompressed public key, as `0x04` and 64 bytes of hex.                                                                                                                                                                                                               |
| `signMessage`       | An EIP-191 message, as `personal_sign`: a string is UTF-8, `{ raw }` is bytes as hex or a `Uint8Array`.                                                                                                                                                                   |
| `signTypedData`     | EIP-712 typed data, as `eth_signTypedData_v4`. `types` may leave out `EIP712Domain`. When `domain.chainId` is set, it must be the connection's chain unless `kms.allowCrossChainTypedData` is `true`.                                                                     |
| `signTransaction`   | A transaction of type `legacy`, `eip2930`, `eip1559` or `eip7702`, whose `chainId` must be the connection's chain. It returns the signed, serialized transaction.                                                                                                         |
| `signAuthorization` | An EIP-7702 authorization for the connection's chain, or for chain 0 with `allowChainZeroAuthorization`. It returns viem's `SignedAuthorization`: `address`, `chainId`, `nonce`, `r`, `s` and `yParity`. There is no `v`, which viem marks as deprecated; read `yParity`. |
| `sign`              | Only with `rawSign: true`: a bare 32-byte digest, with no prefix.                                                                                                                                                                                                         |

The account holds no signer, key config or key material, only these fields and functions, and it is frozen. Every signature goes through the same checks as the RPC path ([Security model](../explanation/security-model.md#every-signature-is-verified)): low S, the recovery bit found against the known key, and a final check that the signature recovers to the account's address. With the same key and viem-typed inputs, the account returns the same bytes as viem's `privateKeyToAccount`.

Outside viem's types, the two can differ. A string `domain.chainId`, such as `"11155111"`, is one: viem's `hashTypedData` leaves it out of the domain, and the plugin encodes it as the `uint256` it stands for, so the plugin's digest is the one a contract whose domain has that chain id expects.

## What is refused before any KMS call

| Request                                                                                                                    | Error                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A transaction without `chainId`, or for another chain than the connection's                                                | `the transaction has no chainId…`, `the transaction is for chain …, but network … is chain …`                 |
| A blob transaction (type 3), by `type` or by its blob fields                                                               | `blob transactions (EIP-4844) cannot be signed with KMS accounts…`                                            |
| Another `type`, such as a chain's deposit type                                                                             | `transaction type … is not signed…`                                                                           |
| A transaction that viem's serializer, or the chain serializer viem passes, encodes differently from the plugin, or refuses | `… encodes the transaction differently from hardhat-kms, so it was not signed`, `… failed on the transaction` |
| An authorization for chain 0 without `allowChainZeroAuthorization`                                                         | `an authorization for chain 0 is valid on every chain…`                                                       |
| An authorization for another chain than the connection's                                                                   | `the authorization is for chain …, but network … is chain …`                                                  |
| Typed data for another chain, without `kms.allowCrossChainTypedData`                                                       | `the typed data is for chain …, but network … is chain …`                                                     |
| A value of a form viem never passes                                                                                        | `… must be …`                                                                                                 |

Each error is listed with its cause and fix in the [errors reference](errors.md#library-accounts).

### Serializers

`signTransaction` signs the bytes of the plugin's own serializer, micro-eth-signer as in Hardhat's local accounts. First, though, it serializes the same transaction with viem's `serializeTransaction`, or with the serializer viem passes for a chain that has one, and refuses when the unsigned bytes differ. So a chain whose transactions carry fields the standard types lack, such as a fee currency, cannot sign through the account.

## Sending

The account has a viem `nonceManager`. For each send that has no `nonce` of its own (`sendTransaction`, `writeContract`, `deployContract`, `sendTransactionSync`, `writeContractSync`), viem asks it for the nonce, then fills the fees, calls `signTransaction` and sends `eth_sendRawTransaction`, or `eth_sendRawTransactionSync` ([EIP-7966](https://eips.ethereum.org/EIPS/eip-7966)) for the `Sync` actions, which wait for the receipt. When the send fails, viem calls the manager's `reset`. Through the connection, the plugin orders these sends with the account's sends through the plugin in the same process, such as `connection.viem.getWalletClient(address)`, scripts and Ignition:

- The nonce is chosen under the account's send lock, as a send through the plugin chooses it: the node's pending count, read through the connection, past the nonces the plugin used on this connection. A send through the plugin in progress is broadcast first.
- The send then keeps the lock until its raw transaction goes out, as a send through the plugin keeps it from its fill to its broadcast. The account's other sends, through the plugin or the account, wait for it, then count it. When viem resets the send after a failure, at its gas estimate for example, the lock is released at once and the nonce is free again.
- The raw transaction goes to the node unchanged, and the node's answer comes back unchanged. When the node takes it (a hash, or a receipt for `eth_sendRawTransactionSync`), answers that it already has it, or answers EIP-7966's timeout (code 4: in the pool, no receipt yet), its nonce raises the plugin's high-water mark, so the next send takes a higher nonce even from a node whose pending count lags. When the node gives no answer, the plugin's next send first asks the node whether it has the transaction.

No RPC answer is rewritten: `eth_getTransactionCount` and every other read come back as the node answered. A read changes nothing and waits for nothing.

Some cases stay outside this:

- A client with its own transport, such as `http(url)` or `webSocket(url)`. Its nonce is still chosen under the lock and kept from the plugin's sends until viem resets it or 60 s pass, but the plugin never sees its broadcast, and on an automining node a send through the plugin can be refused ([below](#clients-with-their-own-transport-on-an-automining-node)). A `custom` transport over another provider looks like `custom(connection.provider)` to the plugin: its send keeps the account's lock until viem resets it or 60 s pass, and the timer keeps the process alive until then. Another process is not ordered either.
- Clients of both kinds for one account at the same time. viem's `reset` names neither the client nor the nonce. When a send through the connection holds the lock and a send with its own transport has a reserved nonce the node does not have yet, a `reset` ends the reservation and the hold stays, so a send through the plugin never takes the held nonce. If the held send was the one that failed, the account's sends wait until its 60 s limit, or until the other send's own `reset`.
- A transaction that viem signs with a `nonce` you pass, or that you prepare, sign and send step by step: viem does not ask the nonce manager. Its raw transaction is still ordered and counted when it goes through the connection.
- A blob transaction (type 3) in its network form, with its blobs, is passed on without being decoded, and is not counted.
- A raw transaction from a KMS address goes on untouched until the connection has looked up its KMS addresses, which `getAccount`, a send and `eth_accounts` do, unless a library send of that address holds the lock: then its raw transaction ends the hold on any connection to the chain, with no KMS call.
- A send of the account started by code that runs inside a send from the same account, such as a network hook during the fill, fails at once and is not signed or sent: it would wait for itself. Its error is `core.account.nonce-reentrant` ([Errors](errors.md#library-accounts)).
- A send whose raw transaction does not reach the plugin and that viem does not reset keeps the account's lock for at most 60 s; the timer keeps the process alive until then. If that send's `reset` comes after the 60 s, it can end the hold of the account's next library send.

These rules need viem 2.55.13 or later ([`getAccount`](#connectionkmsgetaccount)).

`connection.viem.getWalletClient(address)` from hardhat-viem is still the simpler way to send from a KMS account: the plugin fills, signs and broadcasts under one lock, and a retry after a broadcast that got no answer sends the same bytes again; raw transactions have no retry cache. Use the account for what a JSON-RPC account cannot do: viem's `signAuthorization`, a smart-account owner, and signatures in code that has no wallet client.

### Clients with their own transport on an automining node

A client with its own transport gets its nonce under the lock, but its broadcast does not reach the plugin. A send through the plugin skips the reserved nonce and takes the next one. If that send reaches the node before the library send's transaction, a node that mines each transaction as it arrives refuses it: Hardhat's simulated network does so by default. Through viem the error reads:

```text
Nonce provided for the transaction is higher than the next one expected.
(request details)
Details: Nonce too high. Expected nonce to be 0 but got 1. Note that transactions can't be queued when automining.
```

The first line is viem's `NonceTooHighError`; it shows the nonce in parentheses, as `(1)`, only when the send passed a nonce. The `Details:` line is EDR's own message (EDR 0.22.0). To avoid it, send the library account through `custom(connection.provider)`, so the plugin orders the broadcast, or wait for the library send's receipt (`waitForTransactionReceipt`) before the next send through the plugin. A node that queues transactions, such as a public RPC node or a simulated network with `mining: { auto: false }`, takes both.

### Warnings

- When a send has waited 5 s for the account's lock while a library send holds it, a warning names the account, the chain and the held nonce. It prints at most once per held send and at most once per waiting send, so a send that waits behind two holds in a row prints one: `hardhat-kms: a send from 0x… on chain 31337 has waited 5 s for a connection.kms.getAccount send that chose nonce 3 and has not broadcast it through the connection. …` The send keeps waiting until that raw transaction goes out, viem resets that send, or 60 s after the nonce was chosen. A wait that reaches 60 s means the client's broadcast never reached the plugin: send it through `custom(connection.provider)`.
- When the 60 s limit ends a hold, a warning says so: `hardhat-kms: a connection.kms.getAccount send from 0x… on chain 31337 chose nonce 3, and after 60 s it has neither broadcast it through the connection nor been reset by viem, so the plugin released the account's send lock. …` The raw transaction did not reach the plugin, as with a `custom` transport over another provider. If it is broadcast later, it and the account's next send share a nonce, and the node refuses one of them. Send the library account through `custom(connection.provider)`.
- When a library account's nonce is chosen for a client whose transport does not go through Hardhat, such as `http(url)`, a warning prints once per process: `hardhat-kms: a connection.kms.getAccount account sends with a viem "http" transport, which does not go through Hardhat. The plugin chose the transaction's nonce and keeps it from its own sends for 60 s, but it does not order or see the broadcast, so a node that mines each transaction on arrival, such as Hardhat's simulated network, can refuse the plugin's next send with "Nonce too high". Send through custom(connection.provider); …` See [Clients with their own transport on an automining node](#clients-with-their-own-transport-on-an-automining-node).

## Examples

A KMS account signs an EIP-7702 authorization, and another account sends it (the sponsored case):

```ts
import "hardhat-kms";
import "@nomicfoundation/hardhat-viem";
import { network } from "hardhat";
import { createWalletClient, custom } from "viem";
import { sepolia } from "viem/chains";

const connection = await network.create("sepolia");
const authority = await connection.kms.getAccount("0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826");

const authorization = await createWalletClient({
  account: authority,
  chain: sepolia,
  transport: custom(connection.provider),
}).signAuthorization({ contractAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3" });

// The sponsor pays for the transaction. It is another account of the network, such as a second
// KMS key, and hardhat-viem's wallet client sends through the plugin.
const sponsor = await connection.viem.getWalletClient("0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB");
await sponsor.sendTransaction({ authorizationList: [authorization], to: authority.address });
```

The sponsor can also be a key from a config variable in the network's `accounts`, such as `accounts: [configVariable("SPONSOR_KEY")]`. Never put a private key in the code: the well-known keys of Hardhat's test accounts are drained on public networks as soon as they are funded.

A Coinbase smart account needs `sign` from its owner, so its owner needs `rawSign`:

```ts
import "hardhat-kms";
import { network } from "hardhat";
import { createPublicClient, custom } from "viem";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { sepolia } from "viem/chains";

const connection = await network.create("sepolia");
const owner = await connection.kms.getAccount("0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826", {
  rawSign: true,
});
const smartAccount = await toCoinbaseSmartAccount({
  client: createPublicClient({ chain: sepolia, transport: custom(connection.provider) }),
  owners: [owner],
  version: "1.1",
});
```

With `rawSign`, the owner signs any 32-byte digest it is given, which can be the hash of a transaction or a permit for any chain. Ask for it only for an owner that needs it.

viem types the owner of `toSimple7702SmartAccount` as a `PrivateKeyAccount`, whose `source` is `"privateKey"`, so no KMS account matches that type, with or without `rawSign`. The function calls only the owner's `address`, `signMessage`, `signTypedData` and `signAuthorization`, so the account works there, but the call site needs a cast, such as `owner: account as unknown as PrivateKeyAccount`. Making the account a `PrivateKeyAccount` is not a goal: it would claim a key the account does not hold.
