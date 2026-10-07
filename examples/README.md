# Examples

Audience: Hardhat 3 users who want a working project to copy, with a contract deployed and called from an AWS KMS key.

Status: CI runs every example on each pull request.

Each folder is a small Hardhat 3 project with one contract, `Counter`, and a script that deploys it from a KMS account, calls it once and reads its state back:

| Example               | Deploys with                                                          |
| --------------------- | --------------------------------------------------------------------- |
| [viem](viem/)         | `@nomicfoundation/hardhat-viem`: `viem.deployContract`                |
| [ethers](ethers/)     | `@nomicfoundation/hardhat-ethers`: `ethers.deployContract`            |
| [ignition](ignition/) | Hardhat Ignition: a module, deployed by a script or `ignition deploy` |

All three use the AWS provider, `@hardhat-kms/aws`. Each project's README shows how to run it.

## Use an example in your own project

Copy the example's folder out of this repository and install its dependencies with your package manager:

```sh
npm install
```

The `package.json` lists `hardhat-kms` and `@hardhat-kms/aws` with a caret range on the packages' current version, the same as `npm install --save-dev hardhat-kms @hardhat-kms/aws` would write. Inside this repository, pnpm links those two packages to the workspace's own builds instead.

The scripts need an AWS KMS key with the `ECC_SECG_P256K1` key spec and AWS credentials that can use it. [Set up an AWS KMS key](../docs/user/guides/aws-kms-setup.md) covers both.

## Run an example from this repository

Run `pnpm install` and `pnpm run build` at the repository root, then run the commands in the example's README from its folder, with `pnpm exec hardhat` in place of `npx hardhat`.

## How CI runs the examples

The `Examples (LocalStack)` CI job runs `pnpm run test:examples`. It starts LocalStack's KMS emulator in Docker, creates a secp256k1 key there, and runs each example unchanged: the standard AWS variables `AWS_ENDPOINT_URL_KMS`, `AWS_REGION` and test credentials point the AWS SDK at LocalStack, and `AWS_KMS_KEY_ID` names the new key. For each example it runs `hardhat build`, `tsc`, a type-aware lint with the repository's rules, and the deploy script on the `rehearsal` network, then checks that the deployer and the contract's owner are the key's address and that the count read back is 12. The Ignition example also runs `hardhat ignition deploy` against a Hardhat node and reads the counter back from it. [Testing](../docs/contributor/testing.md) describes the test in more detail.
