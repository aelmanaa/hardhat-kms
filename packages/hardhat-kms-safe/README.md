# @hardhat-kms/safe

Safe multisig proposals from Hardhat 3: `kms safe propose` signs a Safe transaction with an account that owns the Safe, and proposes it to the Safe Transaction Service for the other owners to confirm. The proposer can be any account the network signs for in Hardhat:

- a private key in the network's `accounts`, such as a burner wallet stored with `hardhat-keystore`;
- a Ledger, with `@nomicfoundation/hardhat-ledger`;
- a key in AWS KMS, Google Cloud KMS, Azure Key Vault or Turnkey, through [hardhat-kms](https://github.com/aelmanaa/hardhat-kms), where the private key never leaves the KMS. A KMS key is the recommended proposer for CI and long-lived owners: there is no key on disk.

The package has no runtime dependencies and no Safe SDK.

Not affiliated with or endorsed by Safe.

Install the same version as `hardhat-kms`: the packages are released together.

## Install

In a Hardhat 3 project (`npx hardhat --init` creates one):

```sh
npm install --save-dev "hardhat@^3.18.0" hardhat-kms @hardhat-kms/safe viem
```

For a KMS key, add its provider package, such as `@hardhat-kms/aws`.

`@hardhat-kms/safe` needs `hardhat-kms` at the same version and `viem` ^2.55.13. The packages run on Node.js 22.13.0 or later ([Supported Node.js versions](https://aelmanaa.github.io/hardhat-kms/user/reference/support)).

## Configure

Add `@hardhat-kms/safe` to `plugins`, name the Safe Transaction Service API key from [developer.safe.global](https://developer.safe.global) as a configuration variable, and give the network the owner's account. With a key from `npx hardhat keystore set SAFE_PROPOSER_KEY`:

```ts
import hardhatKmsSafe from "@hardhat-kms/safe";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKmsSafe],
  kmsSafe: {
    apiKey: configVariable("SAFE_TRANSACTION_SERVICE_API_KEY"),
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      accounts: [configVariable("SAFE_PROPOSER_KEY")],
    },
  },
});
```

With a KMS key, add its provider package to `plugins`, the key under `kms.keys` and its name to the network's `kmsAccounts`; with a Ledger, `@nomicfoundation/hardhat-ledger` and the address in `ledgerAccounts`. The [guide](https://aelmanaa.github.io/hardhat-kms/user/guides/propose-safe-transactions) shows each.

Config validation refuses an API key written as a string. Set the variable in the environment, or with `npx hardhat keystore set SAFE_TRANSACTION_SERVICE_API_KEY`. `kmsSafe.services` sets a self-hosted service per chain id; the plugin sends it no key.

## Propose

```sh
npx hardhat --network sepolia kms safe propose <safe> <target> --from <owner> --function "transferOwnership(address)" --args '["0x…"]'
```

`--from` names the owner. Without it, the task signs with the network's only KMS account. It refuses an address the network does not sign for in Hardhat, such as a node's own account on a network with `accounts: "remote"`. The task prints the SafeTx hash, the threshold and owners, and the Safe app link. The other owners confirm the transaction in the Safe app.

## What it checks

Before the owner signs, the task refuses a Safe with no code on the network's chain, a Safe version other than 1.3.0, 1.4.1 or 1.5.0, a proposer that is not an owner, a nonce below the Safe's, a delegatecall without `--delegatecall`, and a hash that differs from the Safe's own `getTransactionHash`. The gas refund fields are always zero. After signing, the signature must recover to the proposer and pass the Safe's `checkNSignatures` before it is posted. When the Safe's threshold is 1, the task asks at the terminal first; `--yes` skips the question.

`proposeSafeTransaction` does the same from a script.

- [Propose Safe transactions from Hardhat](https://aelmanaa.github.io/hardhat-kms/user/guides/propose-safe-transactions): the full guide, CI and what the task does not do.
- [`kms safe propose`](https://aelmanaa.github.io/hardhat-kms/user/reference/tasks#kms-safe-propose) and [configuration reference](https://aelmanaa.github.io/hardhat-kms/user/reference/configuration#safe-proposals).
- [All docs](https://aelmanaa.github.io/hardhat-kms/).
