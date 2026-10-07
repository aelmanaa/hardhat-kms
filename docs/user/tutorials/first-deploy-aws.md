---
title: First deploy on Sepolia with AWS KMS
description: "Deploy a Hardhat 3 contract to Sepolia with AWS KMS: create a secp256k1 key, sign the deployment with it, verify the source and clean up."
---

# First deploy on Sepolia with AWS KMS

Audience: developers who have an AWS account and the AWS CLI signed in, and have not used AWS KMS with Hardhat.

This tutorial was followed from an empty directory on 2026-10-01, at commit [`7c4262e`](https://github.com/aelmanaa/hardhat-kms/commit/7c4262e), with Hardhat 3.18.1 and `@nomicfoundation/hardhat-verify` 3.1.2. The commands took about 8 minutes, without the wait for Sepolia ETH. The plugin is not on npm yet; step 4 says how to install it until then.

In this tutorial you create a Hardhat project, create a signing key in AWS KMS, deploy a contract to Sepolia from that key and verify its source on block explorers. The private key never leaves AWS KMS: Hardhat asks KMS for a signature each time it sends a transaction.

It takes about 15 minutes, plus the time it takes to get Sepolia ETH.

You need:

- Node.js 22.13.0 or later (see [supported Node.js versions](../reference/support.md)), and npm.
- The AWS CLI, signed in with an identity that can create KMS keys and aliases, and a region set: `aws configure get region` prints it, or set `AWS_REGION`. The plugin finds the same credentials and region as the CLI. `AWS_DEFAULT_REGION` is read by the CLI only, so set `AWS_REGION` if that is where your region comes from.
- A Sepolia RPC URL. The examples use the public `https://ethereum-sepolia-rpc.publicnode.com`; a provider URL with an API key works too.
- About 0.01 Sepolia ETH, from a faucet or another account.

## 1. Create a Hardhat project

Create a project from Hardhat's viem template in an empty directory:

```sh
mkdir kms-tutorial
cd kms-tutorial
npx --yes hardhat@latest --init --template node-test-runner-viem
```

`--yes` lets npx download Hardhat without asking first.

The template has a `Counter` contract, the Ignition module `ignition/modules/Counter.ts` that deploys it, and a `sepolia` network. It also installs `@nomicfoundation/hardhat-verify`, which verifies contracts on block explorers.

## 2. Create a key in AWS KMS

A customer managed key in AWS KMS costs $1 a month, charged by the hour while the key exists, and each `Sign` or `GetPublicKey` call costs $0.15 per 10,000; these calls are not in the free tier. A key scheduled for deletion costs nothing. See [AWS KMS pricing](https://aws.amazon.com/kms/pricing/). Step 8 removes the key.

Create a secp256k1 signing key, which AWS KMS calls `ECC_SECG_P256K1`, and give it an alias:

```sh
KEY_ID=$(aws kms create-key \
  --key-spec ECC_SECG_P256K1 \
  --key-usage SIGN_VERIFY \
  --description "hardhat-kms tutorial" \
  --query KeyMetadata.KeyId --output text)

aws kms create-alias --alias-name alias/hardhat-kms-tutorial --target-key-id "$KEY_ID"
```

The project refers to the key by its alias. Keep this shell open: step 3 and step 8 use `KEY_ID`.

## 3. Allow the key to sign, and nothing else

Hardhat signs with the identity you signed in with. For this tutorial, that identity can be the one that created the key. A real deployer should have only the policy below: `kms:GetPublicKey`, to derive the address, and `kms:Sign`, limited to what the plugin sends.

Write the policy with your key's ARN to a file in the project. The ARN holds your AWS account ID, so do not commit the file; step 8 deletes it:

```sh
KEY_ARN=$(aws kms describe-key --key-id "$KEY_ID" --query KeyMetadata.Arn --output text)
POLICY=kms-sign-policy.json

cat > "$POLICY" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "kms:GetPublicKey",
      "Resource": "$KEY_ARN"
    },
    {
      "Effect": "Allow",
      "Action": "kms:Sign",
      "Resource": "$KEY_ARN",
      "Condition": {
        "StringEquals": {
          "kms:SigningAlgorithm": "ECDSA_SHA_256",
          "kms:MessageType": "DIGEST"
        }
      }
    }
  ]
}
EOF
```

To give an existing deployer role this policy, attach it. For a role named `hardhat-deployer`:

```sh
aws iam put-role-policy --role-name hardhat-deployer --policy-name hardhat-kms-tutorial \
  --policy-document "file://$POLICY"
```

For an IAM user, use `aws iam put-user-policy --user-name <user name>` instead. If you sign in through IAM Identity Center, ask your administrator to add the policy to your permission set. Prefer a role, IAM Identity Center or `aws login` to an IAM user's access keys: AWS recommends "relying on temporary credentials instead of creating long-term credentials such as access keys" ([Security best practices in IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)).

To check the policy without changing anything, AWS IAM Access Analyzer and the policy simulator accept the file:

```sh
aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY \
  --policy-document "file://$POLICY" --output json

aws iam simulate-custom-policy --policy-input-list "$(cat "$POLICY")" \
  --action-names kms:Sign --resource-arns "$KEY_ARN" \
  --context-entries ContextKeyName=kms:SigningAlgorithm,ContextKeyValues=ECDSA_SHA_256,ContextKeyType=string \
                    ContextKeyName=kms:MessageType,ContextKeyValues=DIGEST,ContextKeyType=string \
  --query 'EvaluationResults[].EvalDecision' --output text
```

The first prints `"findings": []` and the second `allowed`. The same simulation with another algorithm, such as `ECDSA_SHA_384`, or another action, such as `kms:Decrypt` or `kms:ScheduleKeyDeletion`, prints `implicitDeny`. [Set up an AWS KMS key](../guides/aws-kms-setup.md#2-allow-signing-and-nothing-else) explains the conditions and the key policy.

## 4. Add the plugin and the key to the project

Install the core plugin and the AWS provider:

```sh
npm install --save-dev hardhat-kms @hardhat-kms/aws
```

Until the packages are published on npm, this command fails with `E404`: follow [Install before the first npm release](../guides/install-before-release.md) to build the two packages from the repository and install them with npm or pnpm, then continue at the `hardhat.config.ts` step below.

In a pnpm project, install with `pnpm add -D hardhat-kms @hardhat-kms/aws`. pnpm 12 runs no install scripts of dependencies until the project decides on each. If it stops with `ERR_PNPM_IGNORED_BUILDS` for `esbuild`, which Hardhat depends on, the script is not needed: it only checks esbuild's platform binary. Add this to `pnpm-workspace.yaml`, next to `package.json`, and install again:

```yaml
allowBuilds:
  esbuild: false
```

Replace `hardhat.config.ts` with the file below. Compared with the template, it adds `hardhatKmsAws` to `plugins`, adds a `kms` section with the key, gives the `sepolia` network `kmsAccounts` instead of `accounts`, so no private key is in the project, and turns Etherscan verification off:

```ts
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, hardhatKmsAws],
  solidity: {
    profiles: {
      default: {
        version: "0.8.34",
      },
      production: {
        version: "0.8.34",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  verify: {
    etherscan: {
      enabled: false,
    },
  },
  kms: {
    keys: {
      deployer: {
        provider: "aws",
        keyId: "alias/hardhat-kms-tutorial",
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      kmsAccounts: ["deployer"],
    },
  },
});
```

Etherscan needs an API key, and without one its verification fails. To verify on Etherscan too, get a key from [Etherscan](https://etherscan.io/apis), store it with `npx hardhat keystore set ETHERSCAN_API_KEY` or `export ETHERSCAN_API_KEY=…`, and replace `enabled: false` with `apiKey: configVariable("ETHERSCAN_API_KEY")`.

Set the RPC URL, then ask KMS for the key's address:

```sh
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
DEPLOYER_ADDRESS=$(npx hardhat kms address deployer)
echo "$DEPLOYER_ADDRESS"
```

It prints the key's address, `0x` and 40 hex digits. Steps 5 and 6 use `DEPLOYER_ADDRESS`; in a new shell, run the same command again first. Pin the address: in `hardhat.config.ts`, add an `address` line to the `deployer` key, with the address in place of `<deployer address>`. The rest of the file stays the same:

<!-- docs-check: skip -->

```ts
  kms: {
    keys: {
      deployer: {
        provider: "aws",
        keyId: "alias/hardhat-kms-tutorial",
        address: "<deployer address>",
      },
    },
  },
```

With the pin, the plugin refuses to sign if the alias ever points at another key. [Rotate a key and pin its address](../guides/key-rotation.md#what-a-pin-does) explains why.

Before you send funds to the address, check that your credentials may sign with the key:

```sh
npx hardhat kms accounts --check-sign
```

It prints a table with one row for the key, with your address in place of `<deployer address>`:

```text
NAME      PROVIDER  SOURCE    ADDRESS                                     PIN      SIGN  KEY ID
deployer  aws       kms.keys  <deployer address>                          matches  ok    aws:alias/hardhat-kms-tutorial
```

`matches` under `PIN` and `ok` under `SIGN` prove that your credentials may sign with the key and that its signatures recover to the pinned address. The check signs a random message, not a transaction, so it needs no funds. When the credentials may read the key but not sign with it, `SIGN` shows `FAILED` and an `error:` line under the row gives the reason:

```text
NAME      PROVIDER  SOURCE    ADDRESS                                     PIN      SIGN    KEY ID
deployer  aws       kms.keys  <deployer address>                          matches  FAILED  aws:alias/hardhat-kms-tutorial
  error: the sign check failed: aws, sign, key aws:alias/hardhat-kms-tutorial: the provider call failed (AccessDeniedException)
```

Fix the cause before step 5. An `AccessDeniedException` here means your credentials are not allowed `kms:Sign` on the key; check the permissions from step 3.

## 5. Fund the address

Send about 0.01 Sepolia ETH to the deployer address, from a Sepolia faucet or from another account. Deploying the `Counter` contract and calling it costs much less than that on Sepolia.

The address belongs to the KMS key alone. If the key is deleted, any funds and contract roles at the address are lost for good, so step 8 sends the funds back before it removes the key.

To see the balance, open the address on [Sepolia Etherscan](https://sepolia.etherscan.io) or [Sepolia Blockscout](https://eth-sepolia.blockscout.com).

To try the deployment on a local fork of Sepolia before you fund the address, see [Rehearse on a simulated network](../guides/deploy-with-ignition.md#3-rehearse-on-a-simulated-network). The rehearsal signs with the real key, so it also checks the key and its permissions.

## 6. Deploy and verify

Deploy the module from the deployer address, and verify the contract, in one command:

```sh
npx hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --verify --default-sender "$DEPLOYER_ADDRESS"
```

Ignition asks you to confirm the network; answer `y`. Each transaction usually costs one KMS `Sign` call; retries can add more. Naming the sender by its address keeps the deployer the same when you add accounts or keys to the network later; [Choose the sender by address](../guides/multiple-keys.md#choose-the-sender-by-address) explains why.

Ignition deploys `Counter`, calls `incBy(5)`, then verifies the contract on Blockscout and Sourcify. The end of the output looks like this:

```text
[ CounterModule ] successfully deployed 🚀

Deployed Addresses

CounterModule#Counter - 0xc93b1fa3aB9Db68E28897528246b7ec4C5492865

Verifying deployed contracts

Verifying contract "contracts/Counter.sol:Counter" for network sepolia...

=== Blockscout ===

The contract at 0xc93b1fa3aB9Db68E28897528246b7ec4C5492865 has already been verified on Blockscout.

If you need to verify a partially verified contract, please use the --force flag.

Explorer: https://eth-sepolia.blockscout.com/address/0xc93b1fa3aB9Db68E28897528246b7ec4C5492865#code

=== Sourcify ===

The contract at 0xc93b1fa3aB9Db68E28897528246b7ec4C5492865 has already been verified on Sourcify.

If you need to verify a partially verified contract, please use the --force flag.

Explorer: https://sourcify.dev/server/repo-ui/11155111/0xc93b1fa3aB9Db68E28897528246b7ec4C5492865
```

Both explorers may answer "already verified": the template's `Counter` is a common contract, and they have seen its code before. Open the `Explorer:` link that Blockscout printed. If the page shows the contract as verified, you are done. If it shows a "verified twin" or a "similar match" instead, your contract is not verified yet: [Verify the source on block explorers](../guides/deploy-with-ignition.md#6-verify-the-source-on-block-explorers) has the command to run.

## 7. Open the contract on the explorer

Open the `Explorer:` links from the output, with your contract's address:

- Blockscout: `https://eth-sepolia.blockscout.com/address/<contract address>#code` shows the source, marked as verified, and the two transactions from your deployer address: the deployment and the `incBy` call.
- Sourcify: `https://sourcify.dev/server/repo-ui/11155111/<contract address>` shows the files and an exact match.
- Etherscan: `https://sepolia.etherscan.io/address/<contract address>#code`. This tutorial does not verify on Etherscan, so the contract has no verified source of its own there. Etherscan may show the source of another contract with the same bytecode, marked "Similar Match".

The `From` field of each transaction is your deployer address. The signature came from AWS KMS; Hardhat never held a private key.

## 8. Clean up

When you are done, send the remaining Sepolia ETH back, then disable the key and schedule its deletion. In a new shell, set `SEPOLIA_RPC_URL` again first, as in step 4.

Send the balance back with the script in [Return the funds from a KMS address](../guides/return-funds.md): save it as `scripts/return-funds.ts`, then run it with `RETURN_TO` set to an address with no code, such as your own wallet's:

```sh
RETURN_TO=<return address> npx hardhat run scripts/return-funds.ts
```

It ends with `sent in <transaction hash>`. If it stops with a one-line message instead, [What the script refuses](../guides/return-funds.md#what-the-script-refuses) explains each one, and nothing was sent unless the line names a transaction.

Before you remove the key, open the deployer address on [Sepolia Etherscan](https://sepolia.etherscan.io) or [Sepolia Blockscout](https://eth-sepolia.blockscout.com) and check that its balance is close to zero. Once the key is gone, nothing can move what is left.

Then remove the key. If you closed the shell since step 2, set `KEY_ID` again first; the alias still finds it:

```sh
KEY_ID=$(aws kms describe-key --key-id alias/hardhat-kms-tutorial --query KeyMetadata.KeyId --output text)
```

Disable the key and schedule its deletion with the shortest waiting period AWS allows:

```sh
aws kms disable-key --key-id "$KEY_ID"
aws kms schedule-key-deletion --key-id "$KEY_ID" --pending-window-in-days 7
```

Keep the alias. AWS deletes it with the key when the 7 days end, and until then it finds the key if you change your mind. To undo the deletion, cancel it, then enable the key; [Prevent and recover from losing a key](../guides/key-loss.md#aws-kms) covers it:

```sh
aws kms cancel-key-deletion --key-id "$KEY_ID"
aws kms enable-key --key-id "$KEY_ID"
```

After the 7 days, the key is gone for good, and nothing can sign for the address again.

Delete the policy file, from the project directory:

```sh
rm kms-sign-policy.json
```

If you attached the policy in step 3, remove it from the role:

```sh
aws iam delete-role-policy --role-name hardhat-deployer --policy-name hardhat-kms-tutorial
```

For an IAM user, use `aws iam delete-user-policy --user-name <user name> --policy-name hardhat-kms-tutorial` instead.

To keep the key instead, run only the `disable-key` command: a disabled key cannot sign, `aws kms enable-key` brings it back, and it still costs $1 a month.

## Next steps

- [Deploy with Hardhat Ignition](../guides/deploy-with-ignition.md): choose the deployer, rehearse on a simulated network and verify the source on block explorers.
- [Set up an AWS KMS key](../guides/aws-kms-setup.md): every option of an AWS key, and the errors you can meet.
- [Errors](../reference/errors.md#hardhat-kmsaws): every error message, with its cause and fix.
- [Prevent and recover from losing a key](../guides/key-loss.md) before the key holds anything of value.
