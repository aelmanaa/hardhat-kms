---
title: Propose Safe transactions from Hardhat
description: "Sign a Safe multisig transaction in Hardhat 3 with a local key, a Ledger or a KMS key, and propose it to the Safe Transaction Service."
---

# Propose Safe transactions from Hardhat

This guide signs a call from a Safe multisig with an account that owns the Safe, and proposes it to the Safe Transaction Service. The other owners then see it in the Safe app, confirm it and execute it.

The proposer can be any owner the Hardhat network signs for in your project, and needs no KMS key:

- a private key in the network's `accounts`, such as a burner wallet stored with `hardhat-keystore`;
- a Ledger in the network's `ledgerAccounts`, with `@nomicfoundation/hardhat-ledger`;
- a KMS key in the network's `kmsAccounts`, in AWS KMS, Google Cloud KMS, Azure Key Vault or Turnkey.

You need a Safe on the network's chain with the proposer's address among its owners. For a first try, create a test Safe on Sepolia in the [Safe app](https://app.safe.global), with the proposer among its owners and a threshold of 2.

> [!NOTE]
> Audience: users whose contracts are owned by a Safe, who want to propose admin and upgrade calls from Hardhat or CI.
>
> Checked on this repository's tests: Safes 1.3.0, 1.4.1 and 1.5.0 from their canonical bytecode, on Hardhat's own node, with a LocalStack AWS KMS key, a key in a network's `accounts`, a key read through a configuration variable, and a local service that applies the Transaction Service's checks. Each proposal's signature passed the Safe's `checkNSignatures`, and each Safe executed the transaction, with a second owner's signature where the threshold was 2. The Ledger path has not been run on a device: see [Propose from a Ledger](#propose-from-a-ledger).
>
> Checked on Sepolia on 2026-11-03 against Safe's hosted Transaction Service, with `@hardhat-kms/safe` packed from `main`: a 2-of-3 Safe 1.4.1 ([`0x2564…24eE`](https://sepolia.etherscan.io/address/0x256437Bf9031765071Ea3EBdFF1061D6bf6424eE)) took three proposals, one from a key in an environment variable, one from a key in the development keystore of `hardhat-keystore`, and one from an AWS KMS key. Each is queued with the proposer's signature, 1 of 2 confirmations.

## Why propose from Hardhat

The usual way to run contracts that a team controls is to deploy them from an externally owned account and then hand ownership to a Safe. Every later admin or upgrade call then needs the Safe's owners to sign. `kms safe propose` lets one owner propose from Hardhat: it signs, and the transaction waits in the Safe app for the others.

The task signs the Safe transaction as EIP-712 typed data through the network connection, with `eth_signTypedData_v4`. Hardhat signs it for a key in the network's `accounts`, hardhat-ledger for a Ledger, and hardhat-kms for a KMS key, which also checks the chain in the typed data and verifies the signature. The task's own checks, before and after signing, are the same for every proposer.

## Which account proposes

| Proposer                          | Where the key is                                                        | Use it for                                                     |
| --------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| A key in the network's `accounts` | On disk, encrypted by `hardhat-keystore`, or in an environment variable | A burner wallet that only proposes, a test Safe, a quick start |
| A Ledger in `ledgerAccounts`      | On the device; a person approves each signature                         | An owner who proposes now and then, at a desk                  |
| A KMS key in `kmsAccounts`        | In the cloud KMS; it never leaves it                                    | CI and long-lived owners: recommended                          |

A KMS key is the recommended proposer for CI and for an owner that stays for years. No key file sits on a laptop or in a CI secret, so there is nothing to copy. The cloud's IAM decides who may sign, CI signs through OpenID Connect without a stored credential, and the cloud's audit log records each signature ([Find who signed with a key](who-signed.md)). A local key is fine for a burner wallet that only proposes, since the other owners must still confirm each call, but whoever reads the key can propose too, and with a threshold of 1 execute. [A KMS key or a private key in .env](../explanation/kms-or-env-key.md) compares the two.

## 1. Install

For a local key or a Ledger:

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/safe viem @nomicfoundation/hardhat-keystore
```

For a KMS key, add the provider package of your key: `@hardhat-kms/aws`, `@hardhat-kms/gcp`, `@hardhat-kms/azure` or `@hardhat-kms/turnkey`:

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/aws @hardhat-kms/safe viem @nomicfoundation/hardhat-keystore
```

`@hardhat-kms/safe` needs `hardhat-kms` at the same version, and `viem` 2.55.13 or later; it loads hardhat-kms itself, and works without a `kms` section in the config. `@nomicfoundation/hardhat-keystore` holds the API key and a local key in steps 2 and 3. Hardhat's toolboxes include it, so a project that loads one can leave it out. [Install hardhat-kms](install-before-release.md) gives the pnpm and Yarn commands.

## 2. Store the Safe API key

Safe's hosted Transaction Service needs an API key. Create one at [developer.safe.global](https://developer.safe.global), then store it in Hardhat's keystore. The keystore needs `@nomicfoundation/hardhat-keystore` in `plugins`, as the configs in step 3 show:

```sh
npx hardhat keystore set SAFE_TRANSACTION_SERVICE_API_KEY
```

You can also set `SAFE_TRANSACTION_SERVICE_API_KEY` in the environment, for example from a CI secret. The config names the variable, never the key itself: config validation refuses a string. The plugin sends the key only as `Authorization: Bearer` to the service, and never prints it.

## 3. Configure

Add `@hardhat-kms/safe` and `@nomicfoundation/hardhat-keystore` to `plugins` and set `kmsSafe.apiKey`. The network names the proposer: the sections below show a local key, a Ledger and a KMS key.

### Propose from a local key or a burner wallet

Store the owner's private key in Hardhat's keystore, and name it in the network's `accounts` as a configuration variable:

```sh
npx hardhat keystore set SAFE_PROPOSER_KEY
```

```ts
import hardhatKmsSafe from "@hardhat-kms/safe";
import hardhatKeystore from "@nomicfoundation/hardhat-keystore";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKeystore, hardhatKmsSafe],
  kmsSafe: {
    apiKey: configVariable("SAFE_TRANSACTION_SERVICE_API_KEY"),
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      accounts: [configVariable("SAFE_PROPOSER_KEY")],
    },
  },
});
```

Pass the account's address with `--from` ([4. Propose a call](#4-propose-a-call)). It is the address the wallet that made the key shows. Foundry's `cast wallet address --interactive` also prints it, from the key you paste at its prompt. A burner wallet that only proposes needs no ether: proposing sends no transaction.

The key is on disk, encrypted with the keystore's password, and Hardhat holds it in memory while the task runs. Give the burner wallet nothing to lose: no funds, no role in a contract, and a Safe threshold of 2 or more, so its signature alone executes nothing.

### Propose from a Ledger

With `@nomicfoundation/hardhat-ledger` in `plugins`, list the Ledger address in the network's `ledgerAccounts`, and pass it with `--from`:

<!-- docs-check: skip -->

```ts
plugins: [hardhatLedger, hardhatKeystore, hardhatKmsSafe],
networks: {
  sepolia: {
    type: "http",
    url: configVariable("SEPOLIA_RPC_URL"),
    chainId: 11155111,
    ledgerAccounts: ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
  },
},
```

hardhat-ledger first asks the device to show the Safe transaction as EIP-712 typed data. Check the Safe, the call and the nonce on the device's screen against the summary the task prints before you approve.

When that fails, hardhat-ledger asks the device to sign the transaction's two hashes instead, which needs blind signing turned on in the Ethereum app. The device then shows a domain hash and a message hash, not the SafeTx hash. Compare them with the task's lines of the same names, which the Safe app also shows for the transaction:

| On the device | In the task's summary |
| ------------- | --------------------- |
| Domain hash   | `Domain hash:`        |
| Message hash  | `Message hash:`       |

hardhat-ledger 3.1.0 falls back to that hash screen after any failure of the typed-data screen, your rejection included. If you reject the typed data on the device, it then shows the hash screen: reject that too, or the transaction is signed after all.

This path is checked against hardhat-ledger 3.1.0: the repository's tests show that the signing request goes to hardhat-ledger in Hardhat's process and reaches its "Connecting to Ledger..." step, and a stand-in for the device that answers as hardhat-ledger does produces a proposal the Safe accepts. It has not been run on a device yet.

### Propose from a KMS key

Add the provider package to `plugins` and the key to the network's `kmsAccounts`:

```ts
import hardhatKmsAws from "@hardhat-kms/aws";
import hardhatKmsSafe from "@hardhat-kms/safe";
import hardhatKeystore from "@nomicfoundation/hardhat-keystore";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKeystore, hardhatKmsAws, hardhatKmsSafe],
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

Without `--from`, the task signs with the network's KMS account. With several KMS accounts, pass `--key` with the one that owns the Safe, or `--from` with its address. A network can have `accounts`, `ledgerAccounts` and `kmsAccounts` together; the KMS account stays the default, and `--from` picks another.

### Which proposers are refused

`--from` takes an address the network signs for in Hardhat's process: a key in its `accounts` (a list of keys or a mnemonic), an account of an `edr-simulated` network, a Ledger in its `ledgerAccounts`, or a KMS account. The task refuses, before anything signs:

- an address the connection does not list in `eth_accounts`;
- on an `http` network whose `accounts` is `"remote"`, which is the default, an address that is not a KMS or Ledger account. Such a network lists the node's own accounts, and Hardhat would send the signing request to the node, which signs with a key it holds. The task never asks a node to sign. A network config the task does not recognise is treated the same way;
- `--from` together with `--key` when the key's address is another one.

On such a network, put the owner's key in `accounts` instead.

### The service

The plugin picks the service from the chain: `https://api.safe.global/tx-service/sep` for Sepolia, and the chains Safe's own client, `@safe-global/api-kit` 5.0.4, lists. For a chain Safe does not serve, or for a self-hosted service, set its root per chain id. The plugin sends the API key only to Safe's hosted service, never to a self-hosted one, so a self-hosted service that requires a key is not supported. For a chain listed in `services`, the task does not read `kmsSafe.apiKey`, so its variable need not be set:

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

From a local key or a Ledger, add the owner's address:

```sh
npx hardhat --network sepolia kms safe propose <safe> <target> --from <owner> \
  --function "transferOwnership(address)" --args '["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"]'
```

Or pass the encoded call with `--data`, and wei with `--value`. This example signs with the network's KMS account. From a local key or a Ledger, add `--from <owner>`:

```sh
npx hardhat --network sepolia kms safe propose <safe> <recipient> --value 1000000000000000
```

Before the proposer signs, the task prints on standard error what it is about to sign: the Safe and its version, the threshold and owners, the signer, the target, value, data and operation, the function and each argument when `--function` encoded the call, the nonce, the SafeTx hash, and the domain hash and message hash it is built from. Pass an integer above 2^53 - 1 in `--args` as a string, such as `"123456789012345678901"`: JSON rounds larger numbers, so the task refuses them. After the service stores the proposal, it prints the result on standard output:

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

Each of these fails before anything is signed:

- `--from` is not an address the network signs for in Hardhat's process, or it differs from `--key`'s address ([Which proposers are refused](#which-proposers-are-refused)).
- The node's chain differs from the network's `chainId`.
- No service is known for the chain, or Safe's hosted service has no API key in the config.
- There is no contract at the Safe's address on this chain.
- The Safe's `VERSION()` is not 1.3.0, 1.4.1 or 1.5.0. Older Safes sign without the chain id, so their signatures would also be valid on other chains.
- The proposer's address is not among the Safe's current owners.
- `--nonce` is below the Safe's nonce, so the transaction could never run.
- The call is a delegatecall and `--delegatecall` is not passed. A delegatecall runs the target's code with the Safe's storage and funds, so it can change the owners.
- The Safe's own `getTransactionHash` gives another hash than the plugin computed.

The task always sets the gas refund fields to zero, so executing the transaction pays nobody from the Safe.

After the proposer signs, the task checks that the signature recovers to the proposer's address and that the Safe's own `checkNSignatures` accepts it. Only then does it post. The [errors reference](../reference/errors.md) lists every `safe.` error with its cause and fix.

## Threshold 1

When the Safe's threshold is 1, the proposer's signature alone executes the transaction, and anyone who reads it from the service can submit it. The task shows what it is about to sign and asks first:

```text
Sign? [y/N]
```

Only `y` or `yes` signs. Without a terminal, as in CI, the task refuses unless you pass `--yes`. A Safe with a threshold of 2 or more is not asked about.

## Use it from CI

The task needs no person when the Safe's threshold is 2 or more, so a CI job can propose and leave the confirmation to the owners. Propose from a KMS key there: give the job its cloud access through OpenID Connect, as [Sign from GitHub Actions without stored credentials](github-actions-oidc.md) shows, and the API key as a secret in `SAFE_TRANSACTION_SERVICE_API_KEY`. Run `npx hardhat kms accounts --check-sign` first to check the key. A private key in a CI secret works too, but every job, step and action that can read the secret can sign with it.

A job that proposes to a 1-of-N Safe must pass `--yes`, which shows in the workflow file that it does.

## From code

`proposeSafeTransaction` runs the same checks from a script, with any EIP-1193 connection. `sender` is the proposer, any account the connection signs for. `assertProposerSignsInProcess` applies the task's rule for `--from` first, so a node never signs:

```ts
import {
  assertProposerSignsInProcess,
  proposeSafeTransaction,
  TransactionServiceClient,
} from "@hardhat-kms/safe";
import hre from "hardhat";

const sender = "0x4a62316623ad457F02cDC5D997deD67a383EC569"; // an owner the connection signs for
const connection = await hre.network.create("sepolia");
try {
  await assertProposerSignsInProcess(hre, connection, sender);
  const proposal = await proposeSafeTransaction({
    provider: connection.provider,
    sender,
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

The function does not ask anyone before it signs, and it does not check where the connection signs: it sends the request for `sender` as it is. On an `http` network whose `accounts` is `"remote"`, Hardhat forwards a request for an address it does not hold to the node. Call `assertProposerSignsInProcess` before it, as above, to refuse that. Pass `approve` to decide, for a Safe whose threshold is 1. The [API reference](../reference/api/@hardhat-kms/safe.md) lists its options.

## What it does not do

- It does not execute the transaction. The owners do that in the Safe app, or with any tool once the threshold is met.
- It does not confirm a transaction another owner proposed. It proposes; confirm others' proposals in the Safe app.
- `kms safe propose` does not sign with an account the node holds, on a network whose `accounts` is `"remote"`. `proposeSafeTransaction` checks this only when you call `assertProposerSignsInProcess` first.
- Hardhat Ignition cannot deploy through a Safe: Ignition has no `safe` strategy, and a plugin cannot add one. Deploy with Ignition from your account, then hand ownership to the Safe and propose later calls with this task, as [Deploy with Hardhat Ignition](deploy-with-ignition.md#hand-ownership-to-a-safe) shows.
- It supports Safe 1.3.0, 1.4.1 and 1.5.0 only.
- Where Safe's service does not run and you run none, there is nothing to propose to. Collect the owners' signatures another way and execute the transaction from the Safe directly.

## Next steps

- [Security model](../explanation/security-model.md#safe-proposals): what a proposal protects against and what it does not.
- [A KMS key or a Ledger](../explanation/kms-or-ledger.md#both-as-safe-owners): a KMS key as the CI owner, with Ledger co-owners.
- [A KMS key or a private key in .env](../explanation/kms-or-env-key.md): what a key on disk exposes.
