---
title: Use a KMS key with Alchemy Wallet APIs
description: "Make a KMS key the signer of an Alchemy smart wallet: what the key signs, what Alchemy does, a script that checks the signatures, and a sponsored send."
---

# Use a KMS key with Alchemy Wallet APIs

This guide makes a KMS key the signer of a smart wallet through Alchemy's Wallet APIs, for example to have gas sponsored. It checks the key's signatures without sending anything, then sends a call.

You need a working KMS key setup, such as [Set up an AWS KMS key](aws-kms-setup.md), and to know what a viem account is; no prior knowledge of ERC-4337 or EIP-7702 is needed.

> [!NOTE]
> Audience: users who want a KMS key to own a smart wallet through Alchemy's Wallet APIs.
>
> Checked with `@alchemy/wallet-apis` 5.3.0 on 2026-10-08, with viem 2.57.1 and Hardhat 3.18.0. The script in [step 3](#3-check-the-signatures-without-sending) ran on that date with an AWS KMS key on Sepolia: the authorization, a `personal_sign` over an example user operation hash and a typed-data signature each recovered to the key's address, and nothing was sent. The send in [step 4](#4-send-a-call) needs an Alchemy API key and was not run. This repository does not install `@alchemy/wallet-apis`, so its checks do not typecheck the scripts in steps 3 and 4; a later release of the package can change the calls they make.

`connection.kms.getAccount` returns a viem `LocalAccount` for a KMS key ([Library accounts reference](../reference/library-accounts.md)). `@alchemy/wallet-apis` takes a `LocalAccount` as the signer of a smart wallet, so the KMS key can be that signer with no adapter. The plugin adds nothing Alchemy-specific.

## What the key signs and what Alchemy does

By default the Wallet APIs use EIP-7702: the KMS key's own address becomes the smart wallet, delegated to Alchemy's Modular Account v2 contract. The client's account is the signer's address unless you pass another (`src/client.ts` in the package). Alchemy's [EIP-7702 page](https://www.alchemy.com/docs/wallets/transactions/using-eip-7702) gives the default delegate as Modular Account v2 v1.1.0 at `0x77021100bD87b7008E5E1989d0eB38555d0d0000`.

| Step                                   | Who does it                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Build the user operation, estimate gas | Alchemy, in `prepareCalls` (`wallet_prepareCalls`)                                               |
| Apply a gas sponsorship policy         | Alchemy, when you pass a policy id                                                               |
| Sign the EIP-7702 authorization        | The KMS key, through `signAuthorization`, on the first send on a chain only                      |
| Sign the user operation                | The KMS key, through `signMessage` (`personal_sign`) or `signTypedData` (`eth_signTypedData_v4`) |
| Bundle and submit                      | Alchemy, in `sendPreparedCalls`                                                                  |

Alchemy's response says which of the two user operation signature types to use, and the client passes it to the account unchanged (`src/actions/signSignatureRequest.ts`). The KMS key never signs a transaction for the Wallet APIs: Alchemy's [third-party signer page](https://www.alchemy.com/docs/wallets/third-party/signers/custom-integration) notes that `signTransaction` is unused by the client.

Each signature goes through the plugin's usual checks before the client gets it: low S, the recovery bit, and a check that it recovers to the key's address ([Every signature is verified](../explanation/security-model.md#every-signature-is-verified)). The account also refuses an authorization for another chain than its connection's, and typed data whose domain names another chain, so connect to the chain the smart wallet client uses.

If you used the Account Kit packages before: `@alchemy/wallet-apis` replaces `@account-kit/wallet-client`, `@account-kit/infra` and `@aa-sdk/core`, and the `LocalAccountSigner` and `WalletClientSigner` wrappers are gone; you pass the viem account directly ([Alchemy's v5 migration guide](https://www.alchemy.com/docs/wallets/resources/migration-v5)).

## 1. Install the Wallet APIs package

`@alchemy/wallet-apis` 5.3.0 has viem `^2.45.0` as a peer dependency. `getAccount` needs viem 2.55.13 or later ([Library accounts reference](../reference/library-accounts.md#connectionkmsgetaccount)), so keep viem at 2.55.13 or later. A new install takes the newest viem release, which meets both ranges:

::: code-group

```sh [npm]
npm install --save-dev @alchemy/wallet-apis viem
```

```sh [pnpm]
pnpm add --save-dev @alchemy/wallet-apis viem
```

```sh [Yarn]
yarn add --dev @alchemy/wallet-apis viem
```

:::

## 2. Configure the key and the network

The scripts below use a key named `owner` with its `address` pinned, on a `sepolia` network that lists it in `kmsAccounts`. Use your own key name and address:

```ts
import hardhatKmsAws from "@hardhat-kms/aws";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    keys: {
      owner: {
        provider: "aws",
        keyId: configVariable("AWS_KMS_KEY_ID"),
        // The key's address, from `npx hardhat kms address owner`.
        address: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826",
      },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["owner"],
    },
  },
});
```

## 3. Check the signatures without sending

This script builds the smart wallet client with the KMS account as its signer, then asks the client for the two signatures a first send needs: the EIP-7702 authorization and a `personal_sign` over a user operation hash. It also signs typed data, the other user operation signature type. Each request goes through `signSignatureRequest`, the client action that `signPreparedCalls` calls for each signature a send needs. The script checks that every signature recovers to the key's address.

It needs no Alchemy API key: signing does not call Alchemy, so the transport is never used. It reads the account's nonce and code through the Sepolia connection, and sends nothing. The user operation is an example with fixed gas values; in a real send, Alchemy fills it.

Save it as `scripts/check-alchemy-owner.ts`:

<!-- docs-check: skip -->

```ts
// The project's hardhat.config.ts loads the plugin's types; the import makes the file stand alone.
import "hardhat-kms";
import hre from "hardhat";
import { alchemyWalletTransport, createSmartWalletClient } from "@alchemy/wallet-apis";
import {
  createPublicClient,
  custom,
  isAddressEqual,
  parseSignature,
  recoverMessageAddress,
  recoverTypedDataAddress,
  type Address,
} from "viem";
import { entryPoint07Address, getUserOperationHash } from "viem/account-abstraction";
import { sepolia } from "viem/chains";
import { recoverAuthorizationAddress } from "viem/utils";

// The default EIP-7702 delegate of the Wallet APIs, from Alchemy's EIP-7702 page.
const MODULAR_ACCOUNT_V2: Address = "0x77021100bD87b7008E5E1989d0eB38555d0d0000";

const ownerAddress = hre.config.kms.keys["owner"]?.address;
if (ownerAddress === undefined) {
  throw new Error("pin the owner key's address in hardhat.config.ts first");
}

const connection = await hre.network.create("sepolia");
const owner = await connection.kms.getAccount(ownerAddress);
const client = createSmartWalletClient({
  signer: owner,
  // Signing does not call Alchemy, so this check runs without an API key.
  transport: alchemyWalletTransport({ apiKey: process.env.ALCHEMY_API_KEY ?? "unused" }),
  chain: sepolia,
});
const publicClient = createPublicClient({ chain: sepolia, transport: custom(connection.provider) });

// With EIP-7702, the smart wallet is the key's own address.
console.log("smart wallet:", client.account.address);
const nonce = await publicClient.getTransactionCount({ address: owner.address });
const code = await publicClient.getCode({ address: owner.address });
console.log("delegated already:", code !== undefined);

// 1. The EIP-7702 authorization of a first send, for the account's current nonce.
const authorization = await client.signSignatureRequest({
  type: "eip7702Auth",
  data: { address: MODULAR_ACCOUNT_V2, chainId: sepolia.id, nonce },
});
const { r, s, yParity = 0 } = parseSignature(authorization.data);
const authorizationSigner = await recoverAuthorizationAddress({
  authorization: { address: MODULAR_ACCOUNT_V2, chainId: sepolia.id, nonce, r, s, yParity },
});
console.log("authorization signed by the key:", isAddressEqual(authorizationSigner, owner.address));

// 2. A user operation for EntryPoint v0.7, which Modular Account v2 uses (src/ma-v2/mav2StaticImpl.ts
// in @alchemy/smart-accounts 5.2.0), signed as personal_sign over its hash.
const userOpHash = getUserOperationHash({
  chainId: sepolia.id,
  entryPointAddress: entryPoint07Address,
  entryPointVersion: "0.7",
  userOperation: {
    sender: owner.address,
    nonce: 0n,
    callData: "0x",
    callGasLimit: 100_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    signature: "0x",
  },
});
const userOpSignature = await client.signSignatureRequest({
  type: "personal_sign",
  data: { raw: userOpHash },
});
const userOpSigner = await recoverMessageAddress({
  message: { raw: userOpHash },
  signature: userOpSignature.data,
});
console.log("user operation signed by the key:", isAddressEqual(userOpSigner, owner.address));

// 3. Typed data, the other user operation signature type.
const typedData = {
  domain: { name: "check", version: "1", chainId: sepolia.id, verifyingContract: owner.address },
  types: { Check: [{ name: "hash", type: "bytes32" }] },
  primaryType: "Check",
  message: { hash: userOpHash },
} as const;
const typedDataSignature = await client.signSignatureRequest({
  type: "eth_signTypedData_v4",
  data: typedData,
});
const typedDataSigner = await recoverTypedDataAddress({
  ...typedData,
  signature: typedDataSignature.data,
});
console.log("typed data signed by the key:", isAddressEqual(typedDataSigner, owner.address));

await connection.close();
```

Run it with the variables the config reads set, such as `SEPOLIA_RPC_URL`:

```sh
npx hardhat run scripts/check-alchemy-owner.ts
```

Each `signed by the key` line prints `true`. Each signature is usually one KMS sign request; retries can add more ([How many sign requests one call can send](../explanation/security-model.md#how-many-sign-requests-one-call-can-send)).

## 4. Send a call

A send needs an Alchemy API key, and a gas sponsorship policy if Alchemy pays the gas. Both come from the Alchemy dashboard ([Sponsor gas](https://www.alchemy.com/docs/wallets/transactions/sponsor-gas)). Keep the API key out of the config and out of git: this script reads it, and the policy id, from environment variables.

`sendCalls` runs `prepareCalls`, `signPreparedCalls` and `sendPreparedCalls` in turn. On the first send on a chain, the KMS key signs the authorization and the user operation; after that, only the user operation:

<!-- docs-check: skip -->

```ts
import "hardhat-kms";
import hre from "hardhat";
import { alchemyWalletTransport, createSmartWalletClient } from "@alchemy/wallet-apis";
import { sepolia } from "viem/chains";

const apiKey = process.env.ALCHEMY_API_KEY;
const policyId = process.env.ALCHEMY_POLICY_ID;
const ownerAddress = hre.config.kms.keys["owner"]?.address;
if (apiKey === undefined || policyId === undefined || ownerAddress === undefined) {
  throw new Error("set ALCHEMY_API_KEY and ALCHEMY_POLICY_ID, and pin the owner key's address");
}

const connection = await hre.network.create("sepolia");
const client = createSmartWalletClient({
  signer: await connection.kms.getAccount(ownerAddress),
  transport: alchemyWalletTransport({ apiKey }),
  chain: sepolia,
  paymaster: { policyId },
});

// A call with no data and no value to the zero address, as in Alchemy's own example.
const { id } = await client.sendCalls({
  calls: [{ to: "0x0000000000000000000000000000000000000000", value: 0n, data: "0x" }],
});
const status = await client.waitForCallsStatus({ id, timeout: 60_000 });
console.log("transaction:", status.receipts?.[0]?.transactionHash);

await connection.close();
```

## Before you delegate a deployer key

- After the first send, the key's address has code: it is delegated to Modular Account v2 on that chain. Tools that treat an address with code as a contract treat it that way too: [Return the funds from a KMS address](return-funds.md) refuses this address as `RETURN_TO`. The key can still send from it, so returning its own funds works as before. `@alchemy/wallet-apis` has an `undelegateAccount` action; its source comment says Alchemy sponsors that transaction only on the Enterprise plan (`src/actions/undelegateAccount.ts`).
- After delegation, a `personal_sign` or typed-data signature from the key can authorize a user operation that spends from the address, whether it comes from `kms sign`, `eth_sign` or `getAccount().signMessage`. Sign messages with this key only through the smart wallet client, and only for calls you prepared.
- The authorization is signed for the account's nonce at the time `prepareCalls` runs. If the same key sends a transaction through Hardhat before the user operation is included, the nonce moves on and EIP-7702 skips the authorization. Prepare the calls again after such a send.
- To keep the key's address free of code, use a separate smart contract account instead: Alchemy's [EIP-7702 page](https://www.alchemy.com/docs/wallets/transactions/using-eip-7702) shows `requestAccount` with `creationHint: { accountType: "sma-b" }`, then `sendCalls` with that `account`. The KMS key then signs only user operations, no authorization.

## Related

- [Library accounts reference](../reference/library-accounts.md): `getAccount`, its options and what it refuses.
- [Security model](../explanation/security-model.md#every-signature-is-verified): the checks on each signature.
- Alchemy's [third-party signer page](https://www.alchemy.com/docs/wallets/third-party/signers/custom-integration): the methods a signer must have.
