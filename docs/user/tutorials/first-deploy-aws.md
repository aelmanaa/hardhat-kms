# First deploy on Sepolia with AWS KMS

<!--
This page is the template for the Google Cloud KMS (#66) and Azure Key Vault (#67) tutorials.
Shared, copy as is: step 1, step 5, steps 6 and 7, the return-funds half of step 8, Next steps.
In the shared parts, change only the provider's name and key terms (key or key version, Sign or
AsymmetricSign) in: the audience and intro lines, step 5's second paragraph, step 6's sentence on
the Sign call, step 7's last sentence and step 8's opening sentence.
Provider-specific, rewrite per provider: the region and credentials prerequisites, the cost
paragraph, steps 2 and 3, the install line and the kms.keys entry in step 4, the key removal in step 8.
-->

Audience: developers who have an AWS account and the AWS CLI signed in, and have not used AWS KMS with Hardhat.

Status: followed from an empty directory on 2026-10-01, at commit [`7c4262e`](https://github.com/aelmanaa/hardhat-kms/commit/7c4262e), with Hardhat 3.18.1 and `@nomicfoundation/hardhat-verify` 3.1.2. The commands took about 8 minutes, without the wait for Sepolia ETH ([#65](https://github.com/aelmanaa/hardhat-kms/issues/65)). The plugin is not on npm yet; step 4 says how to install it until then.

In this tutorial you create a Hardhat project, create a signing key in AWS KMS, deploy a contract to Sepolia from that key and verify its source on block explorers. The private key never leaves AWS KMS: Hardhat asks KMS for a signature each time it sends a transaction.

It takes about 15 minutes, plus the time it takes to get Sepolia ETH.

You need:

- Node.js 22.13 or later, and npm.
- The AWS CLI, signed in with an identity that can create KMS keys and aliases, and a region set: `aws configure get region` prints it, or set `AWS_REGION`. The plugin finds the same credentials and region as the CLI. `AWS_DEFAULT_REGION` is read by the CLI only, so set `AWS_REGION` if that is where your region comes from.
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

Hardhat signs with the identity you signed in with. For this tutorial, that identity can be the one that created the key. A real deployer should have only the policy below: `kms:GetPublicKey`, to derive the address, and `kms:Sign`, limited to what the plugin sends.

Write the policy with your key's ARN, in a temporary directory:

```sh
KEY_ARN=$(aws kms describe-key --key-id "$KEY_ID" --query KeyMetadata.Arn --output text)
POLICY="$(mktemp -d)/kms-sign-policy.json"

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

To give a deployer role this policy, attach it, for example to a role named `hardhat-deployer`:

```sh
aws iam put-role-policy --role-name hardhat-deployer --policy-name hardhat-kms-tutorial \
  --policy-document "file://$POLICY"
```

For an IAM user, use `aws iam put-user-policy --user-name <user name>` instead. If you sign in through IAM Identity Center, ask your administrator to add the policy to your permission set.

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
npm install --save-dev hardhat-kms hardhat-kms-aws
```

Until the packages are published on npm, this command fails with `E404`. Build them from a clone of the [repository](https://github.com/aelmanaa/hardhat-kms) instead: run `pnpm install`, then `pnpm run build`, then `pnpm pack` in `packages/hardhat-kms` and in `packages/hardhat-kms-aws`. Install the two `.tgz` files it writes with `npm install --save-dev <path to hardhat-kms tgz> <path to hardhat-kms-aws tgz>`.

Replace `hardhat.config.ts` with the file below. Compared with the template, it adds `hardhatKmsAws` to `plugins`, adds a `kms` section with the key, gives the `sepolia` network `kmsAccounts` instead of `accounts`, so no private key is in the project, and turns Etherscan verification off:

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
npx hardhat kms address deployer
```

It prints the key's address, `0x` and 40 hex digits. Pin it: add an `address` line to the `deployer` key, with the address you got in place of `<deployer address>`:

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
        address: "<deployer address>",
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

With the pin, the plugin refuses to sign if the alias ever points at another key. [Rotate a key and pin its address](../guides/key-rotation.md#what-a-pin-does) explains why.

## 5. Fund the address

Send about 0.01 Sepolia ETH to the deployer address, from a Sepolia faucet or from another account. Deploying the `Counter` contract and calling it costs much less than that on Sepolia.

The address belongs to the KMS key alone. If the key is deleted, any funds and contract roles at the address are lost for good, so step 8 sends the funds back before it removes the key.

To see the balance, open the address on [Sepolia Etherscan](https://sepolia.etherscan.io) or [Sepolia Blockscout](https://eth-sepolia.blockscout.com).

## 6. Deploy and verify

Deploy the module from the deployer address, and verify the contract, in one command:

```sh
npx hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --verify --default-sender <deployer address>
```

Ignition asks you to confirm the network; answer `y`. Each transaction costs one KMS `Sign` call. Naming the sender by its address keeps the deployer the same when you add accounts or keys to the network later; [Choose the sender by address](../guides/multiple-keys.md#choose-the-sender-by-address) explains why.

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

Both explorers may answer "already verified" for this contract. The template's `Counter` is a common contract, so the explorers have seen its code before:

- Sourcify matches a new contract on its own when it already holds the source. In the recorded run it matched this one a minute after the deployment, before the verify step ran.
- Blockscout matches a new contract against a database of code it has verified before, and marks it verified with no request from you.

Check the result on Blockscout: open the `Explorer:` link it printed. If the page shows the contract as verified, which it may say it did through its bytecode database, you are done.

If the page instead shows a "verified twin" or a "similar match", Blockscout is showing the source of another contract with similar code, and yours is not verified yet. Only then, verify it with `--force`:

```sh
npx hardhat build --build-profile production
npx hardhat verify blockscout --network sepolia --force <contract address>
```

The build comes first because `verify` compares the deployed bytecode with the local build, and Ignition deployed the `production` build. Other commands, such as `npx hardhat run` or `npx hardhat test`, rebuild with the default profile, and `verify` then fails with `HHE80009`.

When this verifies the contract, Blockscout's part of the output ends like this:

```text
📤 Submitted source code for verification on Blockscout:

  contracts/Counter.sol:Counter
  Address: 0xc93b1fa3aB9Db68E28897528246b7ec4C5492865

⏳ Waiting for verification result...


✅ Contract verified successfully on Blockscout!
```

If it fails with `HHE80022` and says the contract `is already verified`, the contract is verified, and there is nothing left to do. Blockscout limits how often it answers requests without an API key. If the command fails with `Response status code 429: Too Many Requests`, wait a few minutes and run it again.

## 7. Open the contract on the explorer

Open the `Explorer:` links from the output, with your contract's address:

- Blockscout: `https://eth-sepolia.blockscout.com/address/<contract address>#code` shows the source, marked as verified, and the two transactions from your deployer address: the deployment and the `incBy` call.
- Sourcify: `https://sourcify.dev/server/repo-ui/11155111/<contract address>` shows the files and an exact match.
- Etherscan: `https://sepolia.etherscan.io/address/<contract address>#code`. This tutorial does not verify on Etherscan, so the contract has no verified source of its own there. Etherscan may show the source of another contract with the same bytecode, marked "Similar Match".

The `From` field of each transaction is your deployer address. The signature came from AWS KMS; Hardhat never held a private key.

## 8. Clean up

When you are done, send the remaining Sepolia ETH back, then disable the key and schedule its deletion.

Save this script as `scripts/return-funds.ts`. It reads the deployer address from the pin, and sends the whole balance, less the fee, to the address in `RETURN_TO`:

```ts
// The project's hardhat.config.ts loads these plugins' types; the imports make the file stand alone.
import "@nomicfoundation/hardhat-viem";
import "hardhat-kms";
import hre from "hardhat";
import { formatEther, isAddress, isAddressEqual } from "viem";

const to = process.env.RETURN_TO;
if (to === undefined || !isAddress(to)) {
  throw new Error("set RETURN_TO to the address that gets the funds");
}

// The address pinned on the deployer key in step 4.
const from = hre.config.kms.keys["deployer"]?.address;
if (from === undefined || !isAddress(from)) {
  throw new Error("pin the deployer key's address in hardhat.config.ts first");
}

const { viem } = await hre.network.create("sepolia");
const wallets = await viem.getWalletClients();
if (!wallets.some((wallet) => isAddressEqual(wallet.account.address, from))) {
  throw new Error(`${from} is not an account of the sepolia network; check its kmsAccounts`);
}
const wallet = await viem.getWalletClient(from);
const publicClient = await viem.getPublicClient();

const balance = await publicClient.getBalance({ address: from });
const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
const value = balance - 21_000n * maxFeePerGas;
if (value <= 0n) {
  throw new Error(`the balance of ${from}, ${formatEther(balance)} ETH, does not cover the fee`);
}

console.log(`sending ${formatEther(value)} ETH from ${from} to ${to}`);
const hash = await wallet.sendTransaction({
  to,
  value,
  gas: 21_000n,
  maxFeePerGas,
  maxPriorityFeePerGas,
});
await publicClient.waitForTransactionReceipt({ hash });
console.log(`sent in ${hash}`);
```

Run it with an ordinary account (an EOA) that should get the funds, such as your own wallet. The script sends a plain transfer with 21,000 gas, which a contract address may refuse:

```sh
RETURN_TO=<return address> npx hardhat run scripts/return-funds.ts
```

A tiny amount stays behind, 0.0000056 ETH in the recorded run, because the script reserves the fee at the highest price the transaction may pay. Run again, the script stops with `the balance of <deployer address>, … ETH, does not cover the fee` and sends nothing.

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

Delete the policy file. If you attached the policy in step 3, remove it from the role too:

```sh
rm "$POLICY"
aws iam delete-role-policy --role-name hardhat-deployer --policy-name hardhat-kms-tutorial
```

To keep the key instead, run only the `disable-key` command: a disabled key cannot sign, `aws kms enable-key` brings it back, and it still costs $1 a month.

## Next steps

- [Deploy with Hardhat Ignition](../guides/deploy-with-ignition.md): choose the deployer and rehearse on a simulated network.
- [Set up an AWS KMS key](../guides/aws-kms-setup.md): every option of an AWS key, and the errors you can meet.
- [Prevent and recover from losing a key](../guides/key-loss.md) before the key holds anything of value.
