---
title: Deploy with Hardhat Ignition
description: "Hardhat Ignition with a KMS signer: choose the deployer, rehearse on a simulated network, deploy, resume after a KMS failure, and verify the source."
---

# Deploy with Hardhat Ignition

Audience: users who deploy contracts with Hardhat Ignition and want a KMS key to sign the deployment. Assumes a working key setup, such as [Set up an AWS KMS key](aws-kms-setup.md), and an Ignition module.

Deploys from a KMS account were tested with Ignition, hardhat-viem and hardhat-ethers, using `@nomicfoundation/hardhat-ignition` 3.1.8 and `@nomicfoundation/hardhat-ignition-viem` 3.1.6 on Hardhat 3.18.0.

For a complete project to start from, see the [Ignition example](../../../examples/ignition/README.md). It deploys the `Counter` module below from a KMS account, with the `ignition deploy` task and from a script, and CI runs it on every pull request.

Ignition sees a KMS key as one more account of the network. It sends `eth_sendTransaction` from that account, and the plugin signs each transaction with the key. Your module needs no change; you only choose which account deploys.

## 1. Add Ignition and the KMS plugin to the config

Install Ignition and its viem helpers, as for any Hardhat 3 project. Modules import `buildModule` from `@nomicfoundation/hardhat-ignition`, so install both packages:

::: code-group

```sh [npm]
npm install --save-dev @nomicfoundation/hardhat-ignition @nomicfoundation/hardhat-ignition-viem
```

```sh [pnpm]
pnpm add --save-dev @nomicfoundation/hardhat-ignition @nomicfoundation/hardhat-ignition-viem
```

```sh [Yarn]
yarn add --dev @nomicfoundation/hardhat-ignition @nomicfoundation/hardhat-ignition-viem
```

:::

List the provider package and Ignition in `plugins`, and the key in the network's `kmsAccounts`:

```ts
import hardhatIgnitionViem from "@nomicfoundation/hardhat-ignition-viem";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws, hardhatIgnitionViem],
  solidity: "0.8.24",
  kms: {
    keys: { deployer: { provider: "aws", keyId: "alias/deployer" } },
    // Funds the KMS accounts of edr-simulated networks, for rehearsals.
    simulatedBalance: 10n ** 18n,
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["deployer"],
    },
    rehearsal: { type: "edr-simulated", kmsAccounts: ["deployer"] },
    // A rehearsal against Sepolia's current state, read through SEPOLIA_RPC_URL.
    sepoliaFork: {
      type: "edr-simulated",
      forking: { url: configVariable("SEPOLIA_RPC_URL") },
      kmsAccounts: ["deployer"],
    },
    // For keys passed with --kms: lists no KMS keys of its own.
    rehearsalCli: { type: "edr-simulated" },
  },
});
```

The contract, `contracts/Counter.sol`, keeps the address that deployed it, and only that address can call `add`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// A counter that only its deployer can change, so a successful `add` came from the deployer.
contract Counter {
    address public immutable owner;
    string public label;
    uint256 public count;

    constructor(string memory label_, uint256 start) {
        owner = msg.sender;
        label = label_;
        count = start;
    }

    function add(uint256 amount) external {
        require(msg.sender == owner, "not the owner");
        count += amount;
    }
}
```

The module is an ordinary Ignition module. This one, `ignition/modules/Counter.ts`, deploys the contract and calls it:

```ts
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("Counter", (m) => {
  const counter = m.contract("Counter", ["deployed with KMS", 7n]);
  m.call(counter, "add", [5n]);
  return { counter };
});
```

## 2. Choose the deployer

Ignition sends from its default sender, the first address of `eth_accounts`. The plugin lists the network's own accounts first and the KMS accounts after them ([RPC methods](../reference/rpc-methods.md)), so a KMS account is the default sender only when the network has no accounts of its own. That is the case for an http network whose node lists no accounts, as public RPC endpoints do, and for a network with `accounts: []`.

The KMS account's position in `eth_accounts` therefore differs between networks. On `sepolia` above it is index 0; on `rehearsal` and `sepoliaFork`, which have EDR's 20 default accounts, it is index 20. Choose the deployer by address with `--default-sender`, which works on every network the key is listed on. `npx hardhat kms accounts` prints the key's address:

::: code-group

```sh [npm]
npx hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --default-sender 0x…
```

```sh [pnpm]
pnpm hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --default-sender 0x…
```

```sh [Yarn]
yarn hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --default-sender 0x…
```

:::

`m.getAccount(index)` picks an account by its position instead, so a module that uses it only works on networks with the same accounts in the same order. Use it for a module that only ever runs on one local network. Here, index 20 is the first KMS account on an `edr-simulated` network with EDR's default accounts; the same module fails on `sepolia`, where Ignition refuses index 20 because the network lists fewer accounts:

```ts
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("CounterFromKms", (m) => {
  const deployer = m.getAccount(20);
  const counter = m.contract("Counter", ["deployed with KMS", 7n], { from: deployer });
  m.call(counter, "add", [5n], { from: deployer });
  return { counter };
});
```

From a script, pass `defaultSender` to `ignition.deploy`:

```ts
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
// Loads the types of `connection.ignition`. hardhat.config.ts already does this in a project.
import "@nomicfoundation/hardhat-ignition-viem";
import { network } from "hardhat";

const CounterModule = buildModule("Counter", (m) => {
  const counter = m.contract("Counter", ["deployed with KMS", 7n]);
  m.call(counter, "add", [5n]);
  return { counter };
});

const { ignition } = await network.create("sepolia");
await ignition.deploy(CounterModule, { defaultSender: "0x…" });
```

Ignition refuses a `defaultSender` that is not in `eth_accounts`. If it reports an invalid default sender, check that the network lists the key in `kmsAccounts`, or that you passed `--kms`.

## 3. Rehearse on a simulated network

Run the deployment on the `rehearsal` network first. `kms.simulatedBalance` gives the KMS account its balance there, and the plugin signs with the real key, so the rehearsal also checks the key and its permissions:

::: code-group

```sh [npm]
npx hardhat ignition deploy ignition/modules/Counter.ts --network rehearsal --default-sender 0x…
```

```sh [pnpm]
pnpm hardhat ignition deploy ignition/modules/Counter.ts --network rehearsal --default-sender 0x…
```

```sh [Yarn]
yarn hardhat ignition deploy ignition/modules/Counter.ts --network rehearsal --default-sender 0x…
```

:::

Ignition keeps nothing from a deployment to an `edr-simulated` network. To rehearse against Sepolia's recent state, run the same command on `sepoliaFork`, which forks Sepolia through `SEPOLIA_RPC_URL`. The fork starts from a block a little behind the latest one, so a contract deployed in the last few minutes may be missing from it. The contracts are deployed only in the local fork, and `kms.simulatedBalance` funds the KMS account there too:

::: code-group

```sh [npm]
npx hardhat ignition deploy ignition/modules/Counter.ts --network sepoliaFork --default-sender 0x…
```

```sh [pnpm]
pnpm hardhat ignition deploy ignition/modules/Counter.ts --network sepoliaFork --default-sender 0x…
```

```sh [Yarn]
yarn hardhat ignition deploy ignition/modules/Counter.ts --network sepoliaFork --default-sender 0x…
```

:::

A config that has only the live network, such as the one the [first-deploy tutorials](../tutorials/first-deploy-aws.md) build, needs two additions for the fork: `simulatedBalance` in the `kms` section and the `sepoliaFork` network. The rest of the file stays the same:

<!-- docs-check: skip -->

```ts
  kms: {
    // The deployer's balance on simulated networks such as sepoliaFork. Sepolia ignores it.
    simulatedBalance: 10n ** 18n,
    keys: {
      // The deployer key, unchanged.
    },
  },
  networks: {
    // The other networks, unchanged.
    sepoliaFork: {
      type: "edr-simulated",
      forking: { url: configVariable("SEPOLIA_RPC_URL") },
      kmsAccounts: ["deployer"],
    },
  },
```

Leave out `--verify` on `sepoliaFork`: the fork ends with the command, so no explorer can see the contract. Each transaction usually costs one KMS signing request, and retries can add more ([How many sign requests one call can send](../explanation/security-model.md#how-many-sign-requests-one-call-can-send)). Each run also reads the public key once. A rehearsal of the tutorials' `Counter` module took about a minute, most of it spent fetching Sepolia's state, and ended with a `Deployed Addresses` list whose contract address exists only in the fork.

A key chosen with `--kms` instead of a config entry is added to the network selected with `--network`. Pass `--kms` with a network that does not list the same key: `rehearsal` already lists `deployer`, so `--kms aws` with `AWS_KMS_KEY_ID=alias/deployer` fails there with an error that names both. `rehearsalCli` lists no KMS keys and is `edr-simulated`, so `kms.simulatedBalance` funds the key there:

::: code-group

```sh [npm]
AWS_KMS_KEY_ID=alias/deployer npx hardhat ignition deploy ignition/modules/Counter.ts --network rehearsalCli --kms aws --default-sender 0x…
```

```sh [pnpm]
AWS_KMS_KEY_ID=alias/deployer pnpm hardhat ignition deploy ignition/modules/Counter.ts --network rehearsalCli --kms aws --default-sender 0x…
```

```sh [Yarn]
AWS_KMS_KEY_ID=alias/deployer yarn hardhat ignition deploy ignition/modules/Counter.ts --network rehearsalCli --kms aws --default-sender 0x…
```

:::

On a live network, `kms.simulatedBalance` does nothing: fund the key's address there yourself.

## 4. Deploy

Run `ignition deploy` with the live network. Ignition asks you to confirm the network, then sends the transactions and records them in `ignition/deployments/chain-<chain id>`, as it does for any account.

What changes with a KMS account:

- Each transaction usually costs one KMS signing request, such as one `Sign` request to AWS KMS, plus one per fee bump. Retries can add more ([How many sign requests one call can send](../explanation/security-model.md#how-many-sign-requests-one-call-can-send)). With its default settings, Ignition resends a transaction that is still unconfirmed after 3 minutes, with the same nonce and higher fees, up to 4 times. Each resend is a new `eth_sendTransaction`, so the key signs again.
- Ignition sets the nonce, gas limit and fees of each transaction, and sends them one at a time. The plugin fills nothing that Ignition already set.
- The account pays for gas, so fund the KMS address on the live network before you deploy.

## 5. Resume after a KMS failure

If a KMS call fails or times out, the plugin sends nothing for that transaction, and the deployment stops with an error. Ignition has already written the transaction's nonce to its journal in `ignition/deployments/chain-<chain id>` before asking for the signature. Fix the cause, such as an expired session or a missing permission, then run the same `ignition deploy` command again. Ignition reads the journal and resumes the deployment where it stopped.

## 6. Verify the source on block explorers

Add `--verify` to the live `ignition deploy` command, and Ignition verifies each deployed contract with `@nomicfoundation/hardhat-verify` once the deployment ends, on Etherscan, Blockscout and Sourcify. Etherscan needs an API key, and without one its verification fails; the first-deploy tutorials turn it off with `verify: { etherscan: { enabled: false } }`. A KMS account changes nothing here, since verification sends no transaction.

An explorer can answer that the contract "has already been verified" for a contract you just deployed. A common contract, such as the `Counter` of Hardhat's templates, has been seen before:

- Sourcify matches a new contract on its own when it already holds the source. In a recorded run of the tutorials, it matched the contract a minute after the deployment, before the verify step ran.
- Blockscout matches a new contract against a database of code it has verified before, and marks it verified with no request from you.

Check the result on Blockscout: open the `Explorer:` link under `=== Blockscout ===` in the `--verify` output. If the page shows the contract as verified, which it may say it did through its bytecode database, you are done.

If the page instead shows a "verified twin" or a "similar match", Blockscout is showing the source of another contract with similar code, and yours is not verified yet. Only then, verify it with `--force`:

::: code-group

```sh [npm]
npx hardhat build --build-profile production
npx hardhat verify blockscout --network sepolia --force <contract address>
```

```sh [pnpm]
pnpm hardhat build --build-profile production
pnpm hardhat verify blockscout --network sepolia --force <contract address>
```

```sh [Yarn]
yarn hardhat build --build-profile production
yarn hardhat verify blockscout --network sepolia --force <contract address>
```

:::

The build comes first because `verify` compares the deployed bytecode with the local build, and `ignition deploy` deployed the `production` build. Other commands, such as `npx hardhat run` or `npx hardhat test`, rebuild with the default profile, and `verify` then fails with `HHE80009`.

When this verifies the contract, Blockscout's part of the output ends like this:

```text
📤 Submitted source code for verification on Blockscout:

  contracts/Counter.sol:Counter
  Address: <contract address>

⏳ Waiting for verification result...


✅ Contract verified successfully on Blockscout!
```

If it fails with `HHE80022` and says the contract `is already verified`, the contract is verified, and there is nothing left to do. Blockscout limits how often it answers requests without an API key. If the command fails with `Response status code 429: Too Many Requests`, wait a few minutes and run it again.
