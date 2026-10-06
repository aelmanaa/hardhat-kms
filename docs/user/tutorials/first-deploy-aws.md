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

## 5. Fund the address

Send about 0.01 Sepolia ETH to the deployer address, from a Sepolia faucet or from another account. Deploying the `Counter` contract and calling it costs much less than that on Sepolia.

The address belongs to the KMS key alone. If the key is deleted, any funds and contract roles at the address are lost for good, so step 8 sends the funds back before it removes the key.

To see the balance, open the address on [Sepolia Etherscan](https://sepolia.etherscan.io) or [Sepolia Blockscout](https://eth-sepolia.blockscout.com).

To try the deployment before you fund the address, rehearse it on a local fork of Sepolia. In `hardhat.config.ts`, add `simulatedBalance` to the `kms` section and a `sepoliaFork` network:

<!-- docs-check: skip -->

```ts
  kms: {
    // The deployer's balance on simulated networks such as sepoliaFork. Sepolia ignores it.
    simulatedBalance: 10n ** 18n,
    keys: {
      // The deployer key, unchanged.
    },
  },
  networks: {
    // The other networks, unchanged.
    sepoliaFork: {
      type: "edr-simulated",
      forking: { url: configVariable("SEPOLIA_RPC_URL") },
      kmsAccounts: ["deployer"],
    },
  },
```

Then run step 6's command with `--network sepoliaFork`, and without `--verify`:

```sh
npx hardhat ignition deploy ignition/modules/Counter.ts --network sepoliaFork --default-sender "$DEPLOYER_ADDRESS"
```

The plugin signs with the real key, so the rehearsal also checks the key and its permissions. Each transaction costs one KMS signing call, plus one public key read per run. The rehearsal took about a minute in a test run, most of it spent fetching Sepolia's state, and ends like this, with a `Counter` address that exists only in the fork:

```text
[ CounterModule ] successfully deployed 🚀

Deployed Addresses

CounterModule#Counter - <contract address>
```

The fork ends with the command, so no explorer can verify the contract. [Rehearse on a simulated network](../guides/deploy-with-ignition.md#3-rehearse-on-a-simulated-network) has more.

## 6. Deploy and verify

Deploy the module from the deployer address, and verify the contract, in one command:

```sh
npx hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --verify --default-sender "$DEPLOYER_ADDRESS"
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

When you are done, send the remaining Sepolia ETH back, then disable the key and schedule its deletion. In a new shell, set `SEPOLIA_RPC_URL` again first, as in step 4.

Save this script as `scripts/return-funds.ts`. It reads the deployer address from the pin, and sends the whole balance, less the fee, to the address in `RETURN_TO`. It refuses the zero address, the deployer address and any address with code. It also checks that the transfer succeeded:

```ts
// The project's hardhat.config.ts loads these plugins' types; the imports make the file stand alone.
import "@nomicfoundation/hardhat-viem";
import "hardhat-kms";
import hre from "hardhat";
import {
  WaitForTransactionReceiptTimeoutError,
  formatEther,
  isAddress,
  isAddressEqual,
  zeroAddress,
} from "viem";

/**
 * Sends the deployer's balance, less the fee, to RETURN_TO.
 *
 * @returns Why it stopped without returning the funds, or nothing once the funds are returned.
 */
async function returnFunds(): Promise<string | undefined> {
  const to = process.env.RETURN_TO;
  if (to === undefined || to === "") {
    return "set RETURN_TO to the address that gets the funds";
  }
  if (!isAddress(to)) {
    return `RETURN_TO is not a valid address, or its checksum is wrong: ${to}`;
  }
  if (isAddressEqual(to, zeroAddress)) {
    return "RETURN_TO is the zero address, and funds sent there are lost";
  }

  // The address pinned on the deployer key in step 4.
  const from = hre.config.kms.keys["deployer"]?.address;
  if (from === undefined || !isAddress(from)) {
    return "pin the deployer key's address in hardhat.config.ts first";
  }
  if (isAddressEqual(to, from)) {
    return `RETURN_TO is the deployer address ${from}; set it to the address that gets the funds`;
  }

  const { viem } = await hre.network.create("sepolia");
  const wallets = await viem.getWalletClients();
  if (!wallets.some((wallet) => isAddressEqual(wallet.account.address, from))) {
    return `${from} is not an account of the sepolia network; check its kmsAccounts`;
  }
  const wallet = await viem.getWalletClient(from);
  const publicClient = await viem.getPublicClient();

  // A plain transfer with 21,000 gas runs out of gas at an address with code, and the funds stay.
  if ((await publicClient.getCode({ address: to })) !== undefined) {
    return `${to} has code, so it is a contract or a smart account (EIP-7702); send to an address with no code`;
  }

  const balance = await publicClient.getBalance({ address: from });
  const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
  const value = balance - 21_000n * maxFeePerGas;
  if (value <= 0n) {
    return `the balance of ${from}, ${formatEther(balance)} ETH, does not cover the fee`;
  }

  console.log(`sending ${formatEther(value)} ETH from ${from} to ${to}`);
  const hash = await wallet.sendTransaction({
    to,
    value,
    gas: 21_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  // viem waits up to 3 minutes for the receipt, then throws this error.
  const receipt = await publicClient.waitForTransactionReceipt({ hash }).catch((error: unknown) => {
    if (error instanceof WaitForTransactionReceiptTimeoutError) {
      return undefined;
    }
    throw error;
  });
  if (receipt === undefined) {
    return `the transfer ${hash} is not confirmed yet and may still go through; look it up on a Sepolia explorer before you run the script again`;
  }
  if (receipt.status !== "success") {
    return `the transfer reverted in ${hash}; only the fee was spent, and the rest is still at ${from}`;
  }
  console.log(`sent in ${hash}`);
  return undefined;
}

const stopped = await returnFunds();
if (stopped !== undefined) {
  console.error(stopped);
  process.exitCode = 1;
}
```

Set `RETURN_TO` to an address with no code, such as your own wallet's. The script sends a plain transfer with 21,000 gas, which runs out of gas at an address with code, so the script refuses a contract. It also refuses a wallet address whose smart account setting is on, because that setting gives the address code ([EIP-7702](https://eips.ethereum.org/EIPS/eip-7702)). If the script refuses your wallet address for that reason, use another account of the wallet with the setting off, or create a new account in the wallet. Then run the script:

```sh
RETURN_TO=<return address> npx hardhat run scripts/return-funds.ts
```

A tiny amount stays behind, 0.0000056 ETH in the recorded run, because the script reserves the fee at the highest price the transaction may pay. Run it again and the script stops with `the balance of <deployer address>, … ETH, does not cover the fee` and sends nothing.

When the script stops early, it prints one line and exits with code 1. If the transfer reverts, the line is `the transfer reverted in <transaction hash>; only the fee was spent, and the rest is still at <deployer address>`. Run the script again with another address that has no code. If the transfer is not mined within 3 minutes, the line is `the transfer <transaction hash> is not confirmed yet and may still go through; look it up on a Sepolia explorer before you run the script again`. The transfer was sent, and once it is mined, the funds are returned.

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

- [Deploy with Hardhat Ignition](../guides/deploy-with-ignition.md): choose the deployer and rehearse on a simulated network.
- [Set up an AWS KMS key](../guides/aws-kms-setup.md): every option of an AWS key, and the errors you can meet.
- [Errors](../reference/errors.md#hardhat-kmsaws): every error message, with its cause and fix.
- [Prevent and recover from losing a key](../guides/key-loss.md) before the key holds anything of value.
