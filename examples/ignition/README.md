# Deploy with Hardhat Ignition from a KMS key

Audience: Hardhat 3 users who deploy with Hardhat Ignition and want an AWS KMS key to sign.

Status: runs in CI against LocalStack's KMS emulator. To copy it out of this repository, see [Use an example in your own project](../README.md#use-an-example-in-your-own-project).

This project's Ignition module deploys `contracts/Counter.sol` and calls `add(5)`. Ignition sends both transactions from the KMS account, and the key in AWS KMS signs them. The module is unchanged from one you would write for a local account. [Deploy with Hardhat Ignition](../../docs/user/guides/deploy-with-ignition.md) explains how to choose the deployer and how to resume a deployment.

| File                          | What it holds                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `hardhat.config.ts`           | The `@hardhat-kms/aws` and `hardhat-ignition-viem` plugins, the `deployer` key, and the `rehearsal`, `sepolia` and `rehearsalCli` networks |
| `contracts/Counter.sol`       | A counter that only its deployer can change                                                                                                |
| `ignition/modules/Counter.ts` | The Ignition module                                                                                                                        |
| `scripts/deploy.ts`           | Deploys the module with `ignition.deploy` from the KMS account, then reads the counter's state back                                        |

## Run it

Install the dependencies and set the key:

```sh
npm install
export AWS_KMS_KEY_ID=alias/deployer   # a key id, alias or ARN
export AWS_REGION=eu-west-1            # the key's region, unless AWS_KMS_KEY_ID is an ARN
```

Deploy the module with the `ignition deploy` task on the simulated `rehearsal` network. `kms.simulatedBalance` funds the KMS account there, and the key in AWS KMS still signs every transaction. Pass the key's address as the default sender. The script below prints it on its `Deployer:` line, and [Set up an AWS KMS key](../../docs/user/guides/aws-kms-setup.md#4-check-that-the-key-signs) shows another way to read it:

```sh
npx hardhat ignition deploy ignition/modules/Counter.ts --network rehearsal --default-sender 0x…
```

To deploy with a key passed by `--kms aws` instead of a config entry, use `rehearsalCli`, a simulated network that lists no KMS keys of its own, as [Rehearse on a simulated network](../../docs/user/guides/deploy-with-ignition.md#3-rehearse-on-a-simulated-network) explains. CI runs this command as the guide writes it:

```sh
npx hardhat ignition deploy ignition/modules/Counter.ts --network rehearsalCli --kms aws --default-sender 0x…
```

Or run the script, which deploys the same module from the network's first account, the KMS account, and reads the result back:

```sh
npx hardhat run scripts/deploy.ts --network rehearsal
```

```text
Deployer: 0x…
Counter: 0x…
Owner: 0x…
Count: 12
```

`Deployer` and `Owner` are both the key's address. The counter starts at 7, and only its owner can call `add`, so a count of 12 shows that the KMS account sent the call.

To deploy on Sepolia, fund the key's address with Sepolia ETH, set the RPC URL and run the same command with `--network sepolia`. Ignition records a Sepolia deployment in `ignition/deployments/`, so a run that stops can be resumed:

```sh
export SEPOLIA_RPC_URL=https://…
npx hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --default-sender 0x…
```

Credentials come from the AWS SDK's default chain. [Set up an AWS KMS key](../../docs/user/guides/aws-kms-setup.md) covers the key, its permissions and the address pin.
