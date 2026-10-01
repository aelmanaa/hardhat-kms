import { network } from "hardhat";

import CounterModule from "../ignition/modules/Counter.js";

// The network named by --network. The KMS account is its first wallet client, because neither
// network in hardhat.config.ts has accounts of its own.
const { ignition, viem } = await network.create();
const [deployer] = await viem.getWalletClients();
if (deployer === undefined) {
  throw new Error("The network has no accounts. Is the key listed in its kmsAccounts?");
}
console.log(`Deployer: ${deployer.account.address}`);

// Ignition sends every transaction of the module from defaultSender, so the KMS key signs them.
const { counter } = await ignition.deploy(CounterModule, {
  defaultSender: deployer.account.address,
});
console.log(`Counter: ${counter.address}`);

console.log(`Owner: ${await counter.read.owner()}`);
console.log(`Count: ${await counter.read.count()}`);
