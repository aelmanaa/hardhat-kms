# First deploy on Sepolia with AWS KMS

Audience: developers who have an AWS account and the AWS CLI signed in, and have not used AWS KMS with Hardhat.

Status: followed from an empty directory on 2026-10-01, at commit [`7c4262e`](https://github.com/aelmanaa/hardhat-kms/commit/7c4262e), with Hardhat 3.18.1 and `@nomicfoundation/hardhat-verify` 3.1.2. The commands took about 8 minutes, without the wait for Sepolia ETH ([#65](https://github.com/aelmanaa/hardhat-kms/issues/65)). The plugin is not on npm yet.

In this tutorial you create a Hardhat project, create a signing key in AWS KMS, deploy a contract to Sepolia from that key and verify its source on block explorers. The private key never leaves AWS KMS: Hardhat asks KMS for a signature each time it sends a transaction.

It takes about 15 minutes, plus the time it takes to get Sepolia ETH.

You need:

- Node.js 22.13 or later, and npm.
- The AWS CLI, signed in with an identity that can create KMS keys and aliases, and a region set (`aws configure get region` prints it, or set `AWS_REGION`). The plugin finds the same credentials and region as the CLI.
- A Sepolia RPC URL. The examples use the public `https://ethereum-sepolia-rpc.publicnode.com`; a provider URL with an API key works too.
- About 0.01 Sepolia ETH, from a faucet or another account.

## 1. Create a Hardhat project

Create a project from Hardhat's viem template in an empty directory:

```sh
mkdir kms-tutorial
cd kms-tutorial
npx hardhat@latest --init --template node-test-runner-viem
```

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

The identity that runs Hardhat needs two permissions on this key: `kms:GetPublicKey`, to derive the address, and `kms:Sign`, limited to what the plugin sends. Write the policy with your key's ARN:

```sh
KEY_ARN=$(aws kms describe-key --key-id "$KEY_ID" --query KeyMetadata.Arn --output text)

cat > kms-sign-policy.json <<EOF
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

Attach it to the IAM role or user that will run Hardhat, for example a role named `hardhat-deployer`:

```sh
aws iam put-role-policy --role-name hardhat-deployer --policy-name hardhat-kms-tutorial \
  --policy-document file://kms-sign-policy.json
```

For an IAM user, use `aws iam put-user-policy --user-name <user>` instead. If you sign in through IAM Identity Center, ask your administrator to add the policy to your permission set. If the identity you signed in with in step 2 already has wider KMS rights, such as an administrator, you can skip the attachment for this tutorial; give a real deployer only this policy.

To check the policy without changing anything, AWS IAM Access Analyzer and the policy simulator accept the file:

```sh
aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY --policy-document file://kms-sign-policy.json

aws iam simulate-custom-policy --policy-input-list "$(cat kms-sign-policy.json)" \
  --action-names kms:Sign --resource-arns "$KEY_ARN" \
  --context-entries ContextKeyName=kms:SigningAlgorithm,ContextKeyValues=ECDSA_SHA_256,ContextKeyType=string \
                    ContextKeyName=kms:MessageType,ContextKeyValues=DIGEST,ContextKeyType=string \
  --query 'EvaluationResults[].EvalDecision' --output text
```

The first prints `"findings": []` and the second `allowed`. The same simulation with another algorithm, such as `ECDSA_SHA_384`, or another action, such as `kms:Decrypt` or `kms:ScheduleKeyDeletion`, prints `implicitDeny`. [Set up an AWS KMS key](../guides/aws-kms-setup.md#2-allow-signing-and-nothing-else) explains the conditions and the key policy.

## 4. Add the plugin and the key to the project

Install the core plugin and the AWS provider:

```sh
npm install --save-dev hardhat-kms hardhat-kms-aws
```

Replace `hardhat.config.ts` with the file below. Compared with the template, it adds `hardhatKmsAws` to `plugins`, adds a `kms` section with the key, and gives the `sepolia` network `kmsAccounts` instead of `accounts`, so no private key is in the project:

```ts
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "hardhat-kms-aws";

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

Set the RPC URL, then ask KMS for the key's address:

```sh
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
npx hardhat kms address deployer
```

It prints the address, for example `0x2eB9C90f4866FafaA33845e70647b9350CcAc372`. Pin it: add an `address` line to the key, with the address you got:

```ts
import { defineConfig } from "hardhat/config";
import hardhatKmsAws from "hardhat-kms-aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    keys: {
      deployer: {
        provider: "aws",
        keyId: "alias/hardhat-kms-tutorial",
        address: "0x2eB9C90f4866FafaA33845e70647b9350CcAc372",
      },
    },
  },
});
```

With the pin, the plugin refuses to sign if the alias ever points at another key. [Rotate a key and pin its address](../guides/key-rotation.md#what-a-pin-does) explains why.

## 5. Fund the address

Send about 0.01 Sepolia ETH to the address, from a Sepolia faucet or from another account. Deploying the `Counter` contract and calling it costs much less than that on Sepolia.

The address belongs to the KMS key alone. If the key is deleted, any funds and contract roles at the address are lost for good, so step 8 sends the funds back before it removes the key.

To see the balance, open the address on [Sepolia Etherscan](https://sepolia.etherscan.io) or [Sepolia Blockscout](https://eth-sepolia.blockscout.com).

## 6. Deploy and verify

Deploy the module and verify the contract in one command:

```sh
npx hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --verify
```

Ignition asks you to confirm the network; answer `y`. The KMS account is the only account of the `sepolia` network, so Ignition deploys from it. Each transaction costs one KMS `Sign` call.

Ignition deploys `Counter`, calls `incBy(5)`, then verifies the contract with each explorer that `hardhat-verify` enables by default: Etherscan, Blockscout and Sourcify. The end of the output looks like this:

```text
[ CounterModule ] successfully deployed 🚀

Deployed Addresses

CounterModule#Counter - 0xc93b1fa3aB9Db68E28897528246b7ec4C5492865

Verifying deployed contracts

Verifying contract "contracts/Counter.sol:Counter" for network sepolia...

=== Etherscan ===
HHE80029: The Etherscan API key is empty.

=== Blockscout ===

The contract at 0xc93b1fa3aB9Db68E28897528246b7ec4C5492865 has already been verified on Blockscout.

If you need to verify a partially verified contract, please use the --force flag.

Explorer: https://eth-sepolia.blockscout.com/address/0xc93b1fa3aB9Db68E28897528246b7ec4C5492865#code

=== Sourcify ===

The contract at 0xc93b1fa3aB9Db68E28897528246b7ec4C5492865 has already been verified on Sourcify.

If you need to verify a partially verified contract, please use the --force flag.

Explorer: https://sourcify.dev/server/repo-ui/11155111/0xc93b1fa3aB9Db68E28897528246b7ec4C5492865
```

The deployment succeeded, but the command exits with code 1 because of Etherscan. Each explorer answers differently:

- **Etherscan** needs an API key, and the project has none, so the Etherscan step fails with `HHE80029` and the other two still run. To verify on Etherscan, get a key from [Etherscan](https://etherscan.io/apis), add `verify: { etherscan: { apiKey: configVariable("ETHERSCAN_API_KEY") } }` to the config and set the variable. To skip Etherscan instead, add `verify: { etherscan: { enabled: false } }`.
- **Sourcify** had matched the contract on its own a minute after the deployment, before the verify step ran. The template's `Counter` is a common contract, and Sourcify already held its source.
- **Blockscout** reports "already verified" because it shows the source of a "verified twin", another contract with the same code. Your contract is not verified there yet. Verify it with `--force`:

```sh
npx hardhat ignition verify chain-11155111 --network sepolia --force
```

```text
=== Blockscout ===

📤 Submitted source code for verification on Blockscout:

  contracts/Counter.sol:Counter
  Address: 0xc93b1fa3aB9Db68E28897528246b7ec4C5492865

⏳ Waiting for verification result...


✅ Contract verified successfully on Blockscout!
```

`chain-11155111` is the deployment Ignition recorded in `ignition/deployments/`. Etherscan fails again with `HHE80029`, and Sourcify answers `HHE80022` because the contract is already verified there.

## 7. Open the contract on the explorer

Open the `Explorer:` links from the output, with your contract's address:

- Blockscout: `https://eth-sepolia.blockscout.com/address/<contract address>#code` shows the source, marked as verified, and the two transactions from your KMS address: the deployment and the `incBy` call.
- Sourcify: `https://sourcify.dev/server/repo-ui/11155111/<contract address>` shows the files and an exact match.
- Etherscan: `https://sepolia.etherscan.io/address/<contract address>#code`. Without an API key, Etherscan shows the source only as a "Similar Match" of another contract with the same code.

The `From` field of each transaction is the address you pinned in step 4. The signature came from AWS KMS; Hardhat never held a private key.

## 8. Clean up

When you are done, send the remaining Sepolia ETH back, then disable the key and schedule its deletion.

Save this script as `scripts/return-funds.ts`. It sends the whole balance, less the fee, to the address in `RETURN_TO`, signed by the KMS key:

```ts
// Loads the types of `connection.viem`. hardhat.config.ts already does this in the project.
import "@nomicfoundation/hardhat-viem";
import { network } from "hardhat";
import { isAddress } from "viem";

const to = process.env.RETURN_TO;
if (to === undefined || !isAddress(to)) {
  throw new Error("set RETURN_TO to the address that gets the funds");
}

const { viem } = await network.create("sepolia");
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
if (wallet === undefined) {
  throw new Error("the sepolia network has no KMS account");
}

const balance = await publicClient.getBalance({ address: wallet.account.address });
const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
const value = balance - 21_000n * maxFeePerGas;
if (value <= 0n) {
  throw new Error("the balance does not cover the fee");
}

const hash = await wallet.sendTransaction({
  to,
  value,
  gas: 21_000n,
  maxFeePerGas,
  maxPriorityFeePerGas,
});
await publicClient.waitForTransactionReceipt({ hash });
console.log(`sent ${value} wei in ${hash}`);
```

Run it with the address that should get the funds:

```sh
RETURN_TO=0x… npx hardhat run scripts/return-funds.ts
```

A tiny amount stays behind, 0.0000056 ETH in the recorded run, because the script reserves the fee at the highest price the transaction may pay.

Then remove the key. If you closed the shell since step 2, set `KEY_ID` again first; the alias still finds it:

```sh
KEY_ID=$(aws kms describe-key --key-id alias/hardhat-kms-tutorial --query KeyMetadata.KeyId --output text)
```

Disable the key, schedule its deletion with the shortest waiting period AWS allows, and delete the alias:

```sh
aws kms disable-key --key-id "$KEY_ID"
aws kms schedule-key-deletion --key-id "$KEY_ID" --pending-window-in-days 7
aws kms delete-alias --alias-name alias/hardhat-kms-tutorial
```

For 7 days, `aws kms cancel-key-deletion` can still undo the deletion, as [Prevent and recover from losing a key](../guides/key-loss.md#aws-kms) shows. After that the key, and the address with it, are gone. If you attached the policy in step 3, remove it too, for example with `aws iam delete-role-policy --role-name hardhat-deployer --policy-name hardhat-kms-tutorial`.

To keep the key instead, leave it disabled: a disabled key cannot sign, `aws kms enable-key` brings it back, and it still costs $1 a month.

## Next steps

- [Deploy with Hardhat Ignition](../guides/deploy-with-ignition.md): choose the deployer and rehearse on a simulated network.
- [Set up an AWS KMS key](../guides/aws-kms-setup.md): every option of an AWS key, and the errors you can meet.
- [Prevent and recover from losing a key](../guides/key-loss.md) before the key holds anything of value.
