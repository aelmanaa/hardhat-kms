import { network } from "hardhat";

// The network named by --network. The KMS account is its first wallet client, because neither
// network in hardhat.config.ts has accounts of its own.
const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
if (deployer === undefined) {
  throw new Error("The network has no accounts. Is the key listed in its kmsAccounts?");
}
console.log(`Deployer: ${deployer.account.address}`);

// The KMS key signs the deployment and the call.
const counter = await viem.deployContract("Counter", ["deployed with KMS", 7n], {
  client: { wallet: deployer },
});
console.log(`Counter: ${counter.address}`);
const hash = await counter.write.add([5n], { account: deployer.account });
await publicClient.waitForTransactionReceipt({ hash });

console.log(`Owner: ${await counter.read.owner()}`);
console.log(`Count: ${await counter.read.count()}`);
