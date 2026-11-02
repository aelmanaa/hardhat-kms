# @hardhat-kms/safe

Safe multisig proposals for [hardhat-kms](https://github.com/aelmanaa/hardhat-kms): Hardhat 3 signs a Safe transaction with a KMS key that owns the Safe, and proposes it to the Safe Transaction Service for the other owners to confirm. The key can be in AWS KMS, Google Cloud KMS, Azure Key Vault or Turnkey, and the private key never leaves it. The package has no runtime dependencies and no Safe SDK.

Not affiliated with or endorsed by Safe.

Install the same version as `hardhat-kms`: the packages are released together.

## Install

In a Hardhat 3 project (`npx hardhat --init` creates one), with the provider package of your key:

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/aws @hardhat-kms/safe viem
```

`@hardhat-kms/safe` needs `hardhat-kms` at the same version and `viem` ^2.55.13. The packages run on Node.js 22.13.0 or later ([Supported Node.js versions](https://aelmanaa.github.io/hardhat-kms/user/reference/support)).

## Configure

Add `@hardhat-kms/safe` to `plugins`, next to the provider package, and name the Safe Transaction Service API key from [developer.safe.global](https://developer.safe.global) as a configuration variable:

```ts
import hardhatKmsAws from "@hardhat-kms/aws";
import hardhatKmsSafe from "@hardhat-kms/safe";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKmsAws, hardhatKmsSafe],
  kms: {
    keys: {
      owner: { provider: "aws", keyId: "alias/safe-owner" },
    },
  },
  kmsSafe: {
    apiKey: configVariable("SAFE_TRANSACTION_SERVICE_API_KEY"),
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["owner"],
    },
  },
});
```

Config validation refuses an API key written as a string. Set the variable in the environment, or with `npx hardhat keystore set SAFE_TRANSACTION_SERVICE_API_KEY`. `kmsSafe.services` sets a self-hosted service per chain id, which needs no key.

## Propose

```sh
npx hardhat --network sepolia kms safe propose <safe> <target> --function "transferOwnership(address)" --args '["0x…"]'
```

The task prints the SafeTx hash, the threshold and owners, and the Safe app link. The other owners confirm the transaction in the Safe app.

## What it checks

Before the key signs, the task refuses a Safe with no code on the network's chain, a Safe version other than 1.3.0, 1.4.1 or 1.5.0, a key that is not an owner, a nonce below the Safe's, a delegatecall without `--delegatecall`, and a hash that differs from the Safe's own `getTransactionHash`. The gas refund fields are always zero. After signing, the signature must recover to the key and pass the Safe's `checkNSignatures` before it is posted. When the Safe's threshold is 1, the task asks at the terminal first; `--yes` skips the question.

`proposeSafeTransaction` does the same from a script.

- [Propose Safe transactions from Hardhat](https://aelmanaa.github.io/hardhat-kms/user/guides/propose-safe-transactions): the full guide, CI and what the task does not do.
- [`kms safe propose`](https://aelmanaa.github.io/hardhat-kms/user/reference/tasks#kms-safe-propose) and [configuration reference](https://aelmanaa.github.io/hardhat-kms/user/reference/configuration#safe-proposals).
- [All docs](https://aelmanaa.github.io/hardhat-kms/).
