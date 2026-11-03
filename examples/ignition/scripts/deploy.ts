import { network, tasks } from "hardhat";
import { isAddress, isAddressEqual } from "viem";

import CounterModule from "../ignition/modules/Counter.js";

// The address of the `deployer` key in hardhat.config.ts, read from the KMS. The `kms address`
// task also prints it, on a line of its own.
const address: unknown = await tasks.getTask(["kms", "address"]).run({ key: "deployer" });
if (typeof address !== "string" || !isAddress(address)) {
  throw new Error(`kms address returned ${String(address)}, not an address`);
}

// The network named by --network. The sender is chosen by the key's address, never by its
// position: a node that manages accounts of its own, such as anvil, `hardhat node` or a fork,
// lists them before the KMS account, and Ignition's default sender is the first account.
const { ignition, viem, networkName } = await network.create();
const accounts = await viem.getWalletClients();
if (!accounts.some((client) => isAddressEqual(client.account.address, address))) {
  throw new Error(
    `The deployer key's address ${address} is not an account of the ${networkName} network. Is the key listed in its kmsAccounts?`,
  );
}
console.log(`Deployer: ${address}`);

// Ignition sends every transaction of the module from defaultSender, so the KMS key signs them.
const { counter } = await ignition.deploy(CounterModule, { defaultSender: address });
console.log(`Counter: ${counter.address}`);

console.log(`Owner: ${await counter.read.owner()}`);
console.log(`Count: ${await counter.read.count()}`);
