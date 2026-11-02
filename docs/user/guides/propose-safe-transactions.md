---
title: Propose Safe transactions from Hardhat
description: "Sign a Safe multisig transaction with a KMS key in Hardhat 3 and propose it to the Safe Transaction Service, for the other owners to confirm."
---

# Propose Safe transactions from Hardhat

This guide signs a call from a Safe multisig with a KMS key that owns the Safe, and proposes it to the Safe Transaction Service. The other owners then see it in the Safe app, confirm it and execute it.

You need a working KMS key setup, such as [Set up an AWS KMS key](aws-kms-setup.md), and a Safe on the same chain with the key's address among its owners. The task takes the address that `npx hardhat kms accounts` prints.

> [!NOTE]
> Audience: users whose contracts are owned by a Safe, who want to propose admin and upgrade calls from Hardhat or CI.
>
> Checked on this repository's tests: Safes 1.3.0, 1.4.1 and 1.5.0 from their canonical bytecode, on Hardhat's own node, with a LocalStack AWS KMS key and a local service that applies the Transaction Service's checks. Each proposal's signature passed the Safe's `checkNSignatures`, and each Safe executed the transaction, with a second owner's signature where the threshold was 2. A proposal to Safe's hosted service on Sepolia has not been run yet.

## Why propose from Hardhat

The usual way to run contracts that a team controls is to deploy them from an externally owned account, such as a KMS key, and then hand ownership to a Safe. Every later admin or upgrade call then needs the Safe's owners to sign. `kms safe propose` lets one owner be a KMS key: the key signs, and the transaction waits in the Safe app for the others.

The private key stays in the KMS. The task signs the Safe transaction as EIP-712 typed data through the network connection, so hardhat-kms checks the chain in the typed data and verifies the signature, as for any other typed data.

## 1. Install

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/aws @hardhat-kms/safe viem
```

Use the provider package of your key: `@hardhat-kms/aws`, `@hardhat-kms/gcp`, `@hardhat-kms/azure` or `@hardhat-kms/turnkey`. `@hardhat-kms/safe` needs `hardhat-kms` at the same version, and `viem` 2.55.13 or later. [Install hardhat-kms](install-before-release.md) gives the pnpm and Yarn commands.

## 2. Store the Safe API key

Safe's hosted Transaction Service needs an API key. Create one at [developer.safe.global](https://developer.safe.global), then store it in Hardhat's keystore, which needs `@nomicfoundation/hardhat-keystore` in `plugins` (Hardhat's toolboxes include it):

```sh
npx hardhat keystore set SAFE_TRANSACTION_SERVICE_API_KEY
```

You can also set `SAFE_TRANSACTION_SERVICE_API_KEY` in the environment, for example from a CI secret. The config names the variable, never the key itself: config validation refuses a string. The plugin sends the key only as `Authorization: Bearer` to the service, and never prints it.

## 3. Configure

Add `@hardhat-kms/safe` to `plugins`, next to the provider package, and set `kmsSafe.apiKey`:

```ts
import hardhatKmsAws from "@hardhat-kms/aws";
import hardhatKmsSafe from "@hardhat-kms/safe";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKmsAws, hardhatKmsSafe],
  kms: {
    keys: {
      owner: { provider: "aws", keyId: "alias/safe-owner", region: "eu-west-1" },
    },
  },
  kmsSafe: {
    apiKey: configVariable("SAFE_TRANSACTION_SERVICE_API_KEY"),
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

The task signs with a KMS account of the network it runs on. With one KMS account, it uses that one. With several, pass `--key` with the one that owns the Safe.

The plugin picks the service from the chain: `https://api.safe.global/tx-service/sep` for Sepolia, and the chains Safe's own client, `@safe-global/api-kit` 5.0.4, lists. For a chain Safe does not serve, or for a self-hosted service, set its root per chain id. The plugin sends the API key only to Safe's hosted service, never to a self-hosted one, so a self-hosted service that requires a key is not supported:

<!-- docs-check: skip -->

```ts
kmsSafe: {
  services: { "43113": "https://safe-transaction.example.com" },
},
```

[Configuration reference](../reference/configuration.md#safe-proposals) lists every field.

## 4. Propose a call

Pass the Safe, the target and the call. `--function` and `--args` encode the call data for you:

```sh
npx hardhat --network sepolia kms safe propose <safe> <target> \
  --function "transferOwnership(address)" --args '["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"]'
```

Or pass the encoded call with `--data`, and wei with `--value`:

```sh
npx hardhat --network sepolia kms safe propose <safe> <recipient> --value 1000000000000000
```

Before the key signs, the task prints on standard error what it is about to sign: the Safe and its version, the threshold and owners, the signer, the target, value, data and operation, the function and each argument when `--function` encoded the call, the nonce and the SafeTx hash. Pass an integer above 2^53 - 1 in `--args` as a string, such as `"123456789012345678901"`: JSON rounds larger numbers, so the task refuses them. After the service stores the proposal, it prints the result on standard output:

```text
Proposed SafeTx 0x56d0c8521d3e248f74c1dd600311b5b2809fef7b70666a5badbebd5abbe91500
Safe 0xfFDBcab93921F1967577E66cc5E739571eB56F19 on chain 11155111, nonce 4
Threshold 2 of 3: 0x4a62316623ad457F02cDC5D997deD67a383EC569, 0x70997970C51812dc3A010C7d01b50e0d17dc79C8, 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
Signed by 0x4a62316623ad457F02cDC5D997deD67a383EC569
https://app.safe.global/transactions/tx?safe=sep:0xfFDBcab93921F1967577E66cc5E739571eB56F19&id=multisig_0xfFDBcab93921F1967577E66cc5E739571eB56F19_0x56d0c8521d3e248f74c1dd600311b5b2809fef7b70666a5badbebd5abbe91500
```

Open the link to see the transaction in the Safe app. The other owners confirm it there, and any of them executes it once the threshold is met.

The nonce is the next free one: one above the highest transaction already queued, or the Safe's own nonce when nothing is queued. The task takes at most 50 above the Safe's nonce from the service's queue; beyond that it refuses and asks for `--nonce`. Pass `--nonce` to choose it, for example to replace a queued transaction with another at the same nonce. [`kms safe propose`](../reference/tasks.md#kms-safe-propose) lists every option.

## What the task checks and refuses

Each of these fails before the KMS is asked to sign:

- The node's chain differs from the network's `chainId`.
- No service is known for the chain, or Safe's hosted service has no API key in the config.
- There is no contract at the Safe's address on this chain.
- The Safe's `VERSION()` is not 1.3.0, 1.4.1 or 1.5.0. Older Safes sign without the chain id, so their signatures would also be valid on other chains.
- The key's address is not among the Safe's current owners.
- `--nonce` is below the Safe's nonce, so the transaction could never run.
- The call is a delegatecall and `--delegatecall` is not passed. A delegatecall runs the target's code with the Safe's storage and funds, so it can change the owners.
- The Safe's own `getTransactionHash` gives another hash than the plugin computed.

The task always sets the gas refund fields to zero, so executing the transaction pays nobody from the Safe.

After the key signs, the task checks that the signature recovers to the key and that the Safe's own `checkNSignatures` accepts it. Only then does it post. The [errors reference](../reference/errors.md) lists every `safe.` error with its cause and fix.

## Threshold 1

When the Safe's threshold is 1, the key's signature alone executes the transaction, and anyone who reads it from the service can submit it. The task shows what it is about to sign and asks first:

```text
Sign? [y/N]
```

Only `y` or `yes` signs. Without a terminal, as in CI, the task refuses unless you pass `--yes`. A Safe with a threshold of 2 or more is not asked about.

## Use it from CI

The task needs no person when the Safe's threshold is 2 or more, so a CI job can propose and leave the confirmation to the owners. Give the job its cloud access through OpenID Connect, as [Sign from GitHub Actions without stored credentials](github-actions-oidc.md) shows, and the API key as a secret in `SAFE_TRANSACTION_SERVICE_API_KEY`. Run `npx hardhat kms accounts --check-sign` first to check the key.

A job that proposes to a 1-of-N Safe must pass `--yes`, which shows in the workflow file that it does.

## From code

`proposeSafeTransaction` runs the same checks from a script, with any EIP-1193 connection:

```ts
import { proposeSafeTransaction, TransactionServiceClient } from "@hardhat-kms/safe";
import { network } from "hardhat";

const connection = await network.create("sepolia");
try {
  const proposal = await proposeSafeTransaction({
    provider: connection.provider,
    sender: "0x4a62316623ad457F02cDC5D997deD67a383EC569", // the KMS account
    safe: "0xfFDBcab93921F1967577E66cc5E739571eB56F19",
    call: { to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", value: 1n },
    service: new TransactionServiceClient({
      url: "https://api.safe.global/tx-service/sep",
      apiKey: process.env.SAFE_TRANSACTION_SERVICE_API_KEY,
    }),
  });
  console.log(proposal.safeTxHash, proposal.link);
} finally {
  await connection.close();
}
```

The function does not ask anyone before it signs. Pass `approve` to decide, for a Safe whose threshold is 1. The [API reference](../reference/api/@hardhat-kms/safe.md) lists its options.

## What it does not do

- It does not execute the transaction. The owners do that in the Safe app, or with any tool once the threshold is met.
- It does not confirm a transaction another owner proposed. The KMS key proposes; confirm others' proposals in the Safe app.
- Hardhat Ignition cannot deploy through a Safe: Ignition has no `safe` strategy, and a plugin cannot add one. Deploy with Ignition from the KMS account, then hand ownership to the Safe and propose later calls with this task, as [Deploy with Hardhat Ignition](deploy-with-ignition.md#hand-ownership-to-a-safe) shows.
- It supports Safe 1.3.0, 1.4.1 and 1.5.0 only.
- Where Safe's service does not run and you run none, there is nothing to propose to. Collect the owners' signatures another way and execute the transaction from the Safe directly.

## Next steps

- [Security model](../explanation/security-model.md#safe-proposals): what a proposal protects against and what it does not.
- [A KMS key or a Ledger](../explanation/kms-or-ledger.md#both-as-safe-owners): a KMS key as the CI owner, with Ledger co-owners.
