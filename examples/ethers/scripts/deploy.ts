import { type ContractTransactionResponse, isAddress } from "ethers";
import { network, tasks } from "hardhat";

// The address of the `deployer` key in hardhat.config.ts, read from the KMS. The `kms address`
// task also prints it, on a line of its own.
const address: unknown = await tasks.getTask(["kms", "address"]).run({ key: "deployer" });
if (typeof address !== "string" || !isAddress(address)) {
  throw new Error(`kms address returned ${String(address)}, not an address`);
}

// The network named by --network. The signer is chosen by the key's address, never by its
// position: a node that manages accounts of its own, such as anvil, `hardhat node` or a fork,
// lists them before the KMS account, and its first account would sign instead of the key.
const { ethers, networkName } = await network.create();
const deployer = (await ethers.getSigners()).find(
  (signer) => signer.address.toLowerCase() === address.toLowerCase(),
);
if (deployer === undefined) {
  throw new Error(
    `The deployer key's address ${address} is not an account of the ${networkName} network. Is the key listed in its kmsAccounts?`,
  );
}
console.log(`Deployer: ${deployer.address}`);

// The KMS key signs the deployment and the call.
const counter = await ethers.deployContract("Counter", ["deployed with KMS", 7n], deployer);
await counter.waitForDeployment();
console.log(`Counter: ${await counter.getAddress()}`);
const tx: ContractTransactionResponse = await counter.getFunction("add").send(5n);
await tx.wait();

console.log(`Owner: ${await counter.getFunction("owner").staticCall()}`);
console.log(`Count: ${await counter.getFunction("count").staticCall()}`);
