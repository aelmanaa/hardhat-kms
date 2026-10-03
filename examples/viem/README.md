# Deploy with viem from a KMS key

Audience: Hardhat 3 users who deploy with `@nomicfoundation/hardhat-viem` and want an AWS KMS key to sign.

Status: runs in CI against LocalStack's KMS emulator. The packages are not on npm yet; see [Use an example in your own project](../README.md#use-an-example-in-your-own-project).

This project deploys `contracts/Counter.sol` from a KMS account, calls `add(5)`, and reads the contract's owner and count back. Every transaction is signed by the key in AWS KMS.

| File                    | What it holds                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `hardhat.config.ts`     | The `@hardhat-kms/aws` and `hardhat-viem` plugins, the `deployer` key, and the `rehearsal` and `sepolia` networks |
| `contracts/Counter.sol` | A counter that only its deployer can change                                                                       |
| `scripts/deploy.ts`     | Deploys the counter with `viem.deployContract`, calls `add`, prints the result                                    |

## Run it

Install the dependencies, then set the key and run the script on the simulated `rehearsal` network. `kms.simulatedBalance` funds the KMS account there, and the key in AWS KMS still signs every transaction:

```sh
npm install
export AWS_KMS_KEY_ID=alias/deployer   # a key id, alias or ARN
export AWS_REGION=eu-west-1            # the key's region, unless AWS_KMS_KEY_ID is an ARN
npx hardhat run scripts/deploy.ts --network rehearsal
```

The config also reads two optional variables. `AWS_KMS_PROFILE` names an AWS profile to sign through, such as an SSO profile on a laptop, and `AWS_KMS_REGION` sets the key's region, unless `AWS_KMS_KEY_ID` is an ARN. Leave `AWS_KMS_PROFILE` unset in CI, so the job's environment keys sign. [One config for a laptop and CI](../../docs/user/guides/aws-kms-setup.md#one-config-for-a-laptop-and-ci) explains the pattern.

The script prints the KMS account, the contract address, and the state it reads back:

```text
Deployer: 0x…
Counter: 0x…
Owner: 0x…
Count: 12
```

`Deployer` and `Owner` are both the key's address. The counter starts at 7, and only its owner can call `add`, so a count of 12 shows that the KMS account sent the call.

To deploy on Sepolia, fund the key's address with Sepolia ETH and set the RPC URL:

```sh
export SEPOLIA_RPC_URL=https://…
npx hardhat run scripts/deploy.ts --network sepolia
```

Credentials come from the AWS SDK's default chain. [Set up an AWS KMS key](../../docs/user/guides/aws-kms-setup.md) covers the key, its permissions and the address pin, and the [configuration reference](../../docs/user/reference/configuration.md) lists every `kms` option.
