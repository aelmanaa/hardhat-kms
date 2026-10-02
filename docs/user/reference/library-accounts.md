# Library accounts reference

Audience: Users and library authors who need a viem account object for a KMS key, for example for viem's `signAuthorization`, a smart-account SDK or a script outside a wallet client.

Status: `connection.kms.getAccount` is implemented ([#51](https://github.com/aelmanaa/hardhat-kms/issues/51)). The rule for bare digests is [decision 0014](../../contributor/decisions/0014-library-account-raw-sign.md).

## `connection.kms.getAccount`

Every network connection has a `kms` field. Its `getAccount` method returns a viem [`LocalAccount`](https://viem.sh/docs/accounts/local) whose key is one of the connection's KMS keys:

```ts
// Loads the types of `connection.kms`. hardhat.config.ts already does this in a project.
import "hardhat-kms";
import { network } from "hardhat";
import { createWalletClient, custom } from "viem";
import { sepolia } from "viem/chains";

const connection = await network.create("sepolia");
// The deployer key's address, from `npx hardhat kms address deployer`.
const account = await connection.kms.getAccount("0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826");

const signature = await account.signMessage({ message: "hello" });
const wallet = createWalletClient({
  account,
  chain: sepolia,
  transport: custom(connection.provider),
});
```

| Signature                                                    | Returns                      |
| ------------------------------------------------------------ | ---------------------------- |
| `getAccount(address)`                                        | `Promise<KmsAccount>`        |
| `getAccount(address, { rawSign: true })`                     | `Promise<KmsRawSignAccount>` |
| `getAccount(address, { allowChainZeroAuthorization: true })` | `Promise<KmsAccount>`        |

`address` must be the address of one of the connection's KMS accounts, from the network's `kmsAccounts` or from `--kms`. Any other address fails with the KMS addresses the connection has.

`getAccount` needs the `viem` package in the project. viem is an optional peer dependency of hardhat-kms: nothing else in the plugin loads it, and a project without it runs every task. Calling `getAccount` there fails with `connection.kms.getAccount needs the viem package, which could not be loaded`. The lowest viem version tested is the floor of the peer range, `^2.47.6`.

`getAccount` asks the KMS for the key's public key once, which also checks the key's `address` pin. Each method of the account then makes one KMS signing call.

The types are exported from `hardhat-kms/types` (`KmsAccount`, `KmsRawSignAccount`, `KmsAccountOptions`, `KmsNetworkConnection`), and are written without viem's types, so a project without viem still typechecks. A test checks that they are assignable to viem's `LocalAccount`.

## Options

| Option                        | Default | Effect                                                                                                                                                             |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rawSign`                     | `false` | Adds `sign({ hash })`, which signs a 32-byte digest as it is. A warning is printed each time such an account is made.                                              |
| `allowChainZeroAuthorization` | `false` | Lets `signAuthorization` sign for chain 0. A chain-0 authorization is valid on every chain where the account's nonce matches, as `kms sign-auth --force` signs it. |

Any other key in the options object is refused, so that a misspelled option is not silently ignored.

## Methods

| Member              | What it signs                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `address`           | The checksummed address.                                                                                                                                                                                      |
| `publicKey`         | The uncompressed public key, as `0x04` and 64 bytes of hex.                                                                                                                                                   |
| `signMessage`       | An EIP-191 message, as `personal_sign`: a string is UTF-8, `{ raw }` is bytes as hex or a `Uint8Array`.                                                                                                       |
| `signTypedData`     | EIP-712 typed data, as `eth_signTypedData_v4`. `types` may leave out `EIP712Domain`. When `domain.chainId` is set, it must be the connection's chain unless `kms.allowCrossChainTypedData` is `true`.         |
| `signTransaction`   | A transaction of type `legacy`, `eip2930`, `eip1559` or `eip7702`, whose `chainId` must be the connection's chain. It returns the signed, serialized transaction.                                             |
| `signAuthorization` | An EIP-7702 authorization for the connection's chain, or for chain 0 with `allowChainZeroAuthorization`. It returns viem's `SignedAuthorization`: `address`, `chainId`, `nonce`, `r`, `s`, `v` and `yParity`. |
| `sign`              | Only with `rawSign: true`: a bare 32-byte digest, with no prefix.                                                                                                                                             |

The account holds no signer, key config or key material, only these fields and functions, and it is frozen. Every signature goes through the same checks as the RPC path ([Signing pipeline](../../contributor/signing-pipeline.md)): low S, the recovery bit found against the known key, and a final check that the signature recovers to the account's address. With the same key, the account returns the same bytes as viem's `privateKeyToAccount`.

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

viem sends a local account's transactions itself. It fills the nonce and fees, calls `signTransaction`, then sends `eth_sendRawTransaction`, so the plugin's send lock, nonce high-water mark and retry cache never see those sends ([RPC methods](rpc-methods.md#parallel-sends-and-failed-broadcasts)). Two clients sending from one account at once can pick the same nonce.

To send transactions from a KMS account, use `connection.viem.getWalletClient(address)` from hardhat-viem, which sends through the plugin. Use the account for what a JSON-RPC account cannot do: viem's `signAuthorization`, a smart-account owner, and signatures in code that has no wallet client.

## Examples

A KMS account signs an EIP-7702 authorization, and another account sends it (the sponsored case):

```ts
import "hardhat-kms";
import { network } from "hardhat";
import { createWalletClient, custom } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const connection = await network.create("sepolia");
const authority = await connection.kms.getAccount("0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826");
const transport = custom(connection.provider);

const authorization = await createWalletClient({
  account: authority,
  chain: sepolia,
  transport,
}).signAuthorization({ contractAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3" });

// The sponsor pays for the transaction; its key is a local key here.
const sponsor = createWalletClient({
  account: privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  ),
  chain: sepolia,
  transport,
});
await sponsor.sendTransaction({ authorizationList: [authorization], to: authority.address });
```

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
