# Deploy with Hardhat Ignition

Audience: users who deploy contracts with Hardhat Ignition and want a KMS key to sign the deployment. Assumes a working key setup, such as [Set up an AWS KMS key](aws-kms-setup.md), and an Ignition module.

Status: M5 signs and sends transactions from KMS accounts ([#24](https://github.com/aelmanaa/hardhat-kms/issues/24)), and the deploy tests cover Ignition, hardhat-viem and hardhat-ethers ([#26](https://github.com/aelmanaa/hardhat-kms/issues/26)). The tests ran with `@nomicfoundation/hardhat-ignition` 3.1.8 and `@nomicfoundation/hardhat-ignition-viem` 3.1.6 on Hardhat 3.18.0. The plugin is not on npm yet.

Ignition sees a KMS key as one more account of the network. It sends `eth_sendTransaction` from that account, and the plugin signs each transaction with the key. Your module needs no change; you only choose which account deploys.

## 1. Add Ignition and the KMS plugin to the config

Install Ignition with the viem or ethers helpers, as for any Hardhat 3 project:

```sh
npm install --save-dev @nomicfoundation/hardhat-ignition-viem
```

List the provider package and Ignition in `plugins`, and the key in the network's `kmsAccounts`:

```ts
import hardhatIgnitionViem from "@nomicfoundation/hardhat-ignition-viem";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "hardhat-kms-aws";

export default defineConfig({
  plugins: [hardhatKmsAws, hardhatIgnitionViem],
  solidity: "0.8.24",
  kms: {
    keys: { deployer: { provider: "aws", keyId: "alias/deployer", address: "0x…" } },
    // Funds the KMS accounts of edr-simulated networks, for rehearsals.
    simulatedBalance: 10n ** 18n,
  },
  networks: {
    sepolia: { type: "http", url: configVariable("SEPOLIA_RPC_URL"), kmsAccounts: ["deployer"] },
    rehearsal: { type: "edr-simulated", kmsAccounts: ["deployer"] },
  },
});
```

The module is an ordinary Ignition module. This one, `ignition/modules/Counter.ts`, deploys a contract and calls it:

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

When the network has its own accounts, pass the KMS address to `ignition deploy`:

```sh
npx hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --default-sender 0x…
```

To pick the account inside the module instead, use `m.getAccount(index)` with the account's position in `eth_accounts`. On an `edr-simulated` network with EDR's 20 default accounts, the first KMS account is index 20:

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

```sh
npx hardhat ignition deploy ignition/modules/Counter.ts --network rehearsal --default-sender 0x…
```

Ignition keeps nothing from a deployment to an `edr-simulated` network. To rehearse against live state, add `forking` to the network, as in the [configuration reference](../reference/configuration.md).

A key chosen with `--kms` instead of a config entry works the same way: it is added to the selected network, and `kms.simulatedBalance` funds it there.

```sh
AWS_KMS_KEY_ID=alias/deployer npx hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --kms aws --default-sender 0x…
```

## 4. Deploy

Run `ignition deploy` with the live network. Ignition asks you to confirm the network, then sends the transactions and records them in `ignition/deployments/chain-<chain id>`, as it does for any account.

What changes with a KMS account:

- Each transaction costs one KMS signing call, such as one `Sign` request to AWS KMS.
- Ignition sets the nonce, gas limit and fees of each transaction, and sends them one at a time. The plugin fills nothing that Ignition already set.
- The account pays for gas, so fund the KMS address on the live network before you deploy.
- If a KMS call fails or times out, the plugin sends nothing for that transaction, and the deployment stops with an error.
