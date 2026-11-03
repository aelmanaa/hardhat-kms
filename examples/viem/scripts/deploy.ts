import { network, tasks } from "hardhat";
import { isAddress, isAddressEqual } from "viem";

// The address of the `deployer` key in hardhat.config.ts, read from the KMS. The `kms address`
// task also prints it, on a line of its own.
const address: unknown = await tasks.getTask(["kms", "address"]).run({ key: "deployer" });
if (typeof address !== "string" || !isAddress(address)) {
  throw new Error(`kms address returned ${String(address)}, not an address`);
}

// The network named by --network. The wallet client is chosen by the key's address, never by its
// position: a node that manages accounts of its own, such as anvil, `hardhat node` or a fork,
// lists them before the KMS account, and its first account would sign instead of the key.
const { viem, networkName } = await network.create();
const publicClient = await viem.getPublicClient();
const deployer = (await viem.getWalletClients()).find((client) =>
  isAddressEqual(client.account.address, address),
);
if (deployer === undefined) {
  throw new Error(
    `The deployer key's address ${address} is not an account of the ${networkName} network. Is the key listed in its kmsAccounts?`,
  );
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
