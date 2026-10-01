import { network } from "hardhat";

// The network named by --network. The KMS account is its first signer, because neither network
// in hardhat.config.ts has accounts of its own.
const { ethers } = await network.create();
const [deployer] = await ethers.getSigners();
if (deployer === undefined) {
  throw new Error("The network has no accounts. Is the key listed in its kmsAccounts?");
}
console.log(`Deployer: ${deployer.address}`);

// The KMS key signs the deployment and the call.
const counter = await ethers.deployContract("Counter", ["deployed with KMS", 7n], deployer);
await counter.waitForDeployment();
console.log(`Counter: ${await counter.getAddress()}`);
const tx = await counter.add(5n);
await tx.wait();

console.log(`Owner: ${await counter.owner()}`);
console.log(`Count: ${await counter.count()}`);
