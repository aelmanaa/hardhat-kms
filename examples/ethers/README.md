# Deploy with ethers from a KMS key

Audience: Hardhat 3 users who deploy with `@nomicfoundation/hardhat-ethers` and want an AWS KMS key to sign.

Status: runs in CI against LocalStack's KMS emulator. To copy it out of this repository, see [Use an example in your own project](../README.md#use-an-example-in-your-own-project).

This project deploys `contracts/Counter.sol` from a KMS account, calls `add(5)`, and reads the contract's owner and count back. Every transaction is signed by the key in AWS KMS.

CI uses this example for non-regression testing: ethers must deploy a contract, send a transaction, and read back the expected state through hardhat-kms. It omits TypeChain to keep the test dependencies small. The script uses ethers' ABI-based `getFunction(...).send()` and `.staticCall()` methods, without generating contract types. Ethers checks contract arguments at runtime; TypeScript does not check them against the ABI.

This is a choice for our test fixture, not a requirement for projects using hardhat-kms. You can use TypeChain and normal typed calls such as `counter.add(5n)` in your own project. Hardhat's [Ethers+Mocha toolbox](https://hardhat.org/plugins/nomicfoundation-hardhat-toolbox-mocha-ethers) already includes TypeChain. Installing ethers alone does not.

| File                    | What it holds                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `hardhat.config.ts`     | The `@hardhat-kms/aws` and `hardhat-ethers` plugins, the `deployer` key, and the `rehearsal` and `sepolia` networks |
| `contracts/Counter.sol` | A counter that only its deployer can change                                                                         |
| `scripts/deploy.ts`     | Deploys the counter with `ethers.deployContract`, calls `add`, prints the result                                    |

## Run it

Install the dependencies, then set the key and run the script on the simulated `rehearsal` network. `kms.simulatedBalance` funds the KMS account there, and the key in AWS KMS still signs every transaction:

```sh
npm install
export AWS_KMS_KEY_ID=alias/deployer   # a key id, alias or ARN
export AWS_REGION=eu-west-1            # the key's region, unless AWS_KMS_KEY_ID is an ARN
npx hardhat run scripts/deploy.ts --network rehearsal
```

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

## Optional: generate contract types with TypeChain

In your own ethers project, TypeChain can generate contract types from the compiled ABI. Those types let TypeScript check method names, arguments, and return values, while you keep calls such as `counter.add(5n)` and `counter.count()`. TypeChain is optional tooling for your project; hardhat-kms does not require or install it.

To add it to a copy of this example:

1. Install the Hardhat 3 plugin:

   ```sh
   npm install --save-dev @nomicfoundation/hardhat-typechain
   ```

2. In `hardhat.config.ts`, add `import hardhatTypechain from "@nomicfoundation/hardhat-typechain";` and include `hardhatTypechain` in the `plugins` array alongside `hardhatKmsAws` and `hardhatEthers`.
3. Run `npx hardhat build` to generate the types. You can then use typed calls such as `counter.add(5n)`, `counter.owner()`, and `counter.count()` in place of this fixture's ABI lookups.

This changes contract typing in your project, not how the KMS key signs. The [TypeChain plugin documentation](https://github.com/NomicFoundation/hardhat/tree/main/packages/hardhat-typechain) covers its configuration.
