---
title: Deploy a Hardhat contract to Sepolia with AWS KMS
description: "Deploy a Hardhat 3 contract to Sepolia with AWS KMS: create a secp256k1 key, sign the deployment with it, verify the source and clean up."
---

# Deploy a Hardhat contract to Sepolia with AWS KMS

In this tutorial you create a Hardhat project, create a signing key in AWS KMS, deploy a contract to Sepolia from that key and verify its source on block explorers. The private key never leaves AWS KMS: Hardhat asks KMS for a signature each time it sends a transaction.

You need:

- Node.js 22.13.0 or later (see [supported Node.js versions](../reference/support.md)), and npm, pnpm or Yarn.
- A POSIX shell, such as bash or zsh; on Windows, use WSL.
- AWS CLI v2, signed in with an identity that can create KMS keys and aliases, and a region set: `aws configure get region` prints it, or set `AWS_REGION`. The plugin finds the same credentials and region as the CLI. `AWS_DEFAULT_REGION` is read by the CLI only, so set `AWS_REGION` if that is where your region comes from. AWS CLI v1 reaches [end of support on 2027-07-15](https://aws.amazon.com/blogs/developer/cli-v1-maintenance-mode-announcement/); `aws --version` prints `aws-cli/2.` for v2.
- A Sepolia RPC URL. The examples use the public `https://ethereum-sepolia-rpc.publicnode.com`; a provider URL with an API key works too.
- About 0.01 Sepolia ETH, from a faucet or another account.

> [!NOTE]
> Audience: developers who have an AWS account and AWS CLI v2 signed in, and have not used AWS KMS with Hardhat. It takes about 15 minutes, plus the time it takes to get Sepolia ETH.
>
> This tutorial was followed from an empty directory on 2026-10-01, at commit [`7c4262e`](https://github.com/aelmanaa/hardhat-kms/commit/7c4262e), with Hardhat 3.18.1 and `@nomicfoundation/hardhat-verify` 3.1.2. The commands took about 8 minutes, without the wait for Sepolia ETH. On 2026-10-07, at commit [`e10b7e5`](https://github.com/aelmanaa/hardhat-kms/commit/e10b7e5), with Hardhat 3.18.1, steps 1 to 4 were followed again from an empty directory, up to `kms accounts --check-sign`. That run installed packages packed from the repository and used LocalStack's KMS in place of AWS KMS.

## 1. Create a Hardhat project with the plugin

Create a project from Hardhat's viem template in an empty directory:

::: code-group

```sh [npm]
mkdir kms-tutorial
cd kms-tutorial
npx --yes hardhat@latest --init --template node-test-runner-viem
```

```sh [pnpm]
mkdir kms-tutorial
cd kms-tutorial
pnpm dlx hardhat@latest --init --template node-test-runner-viem
```

```sh [Yarn]
mkdir kms-tutorial
cd kms-tutorial
yarn init -2
printf 'nodeLinker: node-modules\napprovedGitRepositories:\n  - "https://github.com/foundry-rs/forge-std.git"\n' >> .yarnrc.yml
yarn dlx hardhat@latest --init --template node-test-runner-viem
```

:::

`--yes` lets npx download Hardhat without asking first; `pnpm dlx` and `yarn dlx` do not ask.

With Yarn, `yarn init -2` pins Yarn 4 in `package.json`, so the template's install runs with Yarn 4 rather than Yarn 1. Hardhat does not run under Yarn 4's default Plug'n'Play linker, and the template installs `forge-std` from GitHub, which Yarn 4 refuses unless the repository is approved.

The template has a `Counter` contract, the Ignition module `ignition/modules/Counter.ts` that deploys it, and a `sepolia` network. It also installs `@nomicfoundation/hardhat-verify`, which verifies contracts on block explorers.

Install the core plugin, `hardhat-kms`, and the AWS provider, `@hardhat-kms/aws`, with the package manager you created the project with:

::: code-group

```sh [npm]
npm install --save-dev hardhat-kms @hardhat-kms/aws
```

```sh [pnpm]
pnpm add --save-dev hardhat-kms @hardhat-kms/aws
```

```sh [Yarn]
yarn add --dev hardhat-kms @hardhat-kms/aws
```

:::

If the install stops with `ERR_PNPM_IGNORED_BUILDS` from pnpm or `YN0016` from Yarn, [If the install stops](../guides/install-before-release.md#if-the-install-stops) gives the fix for each package manager.

Register the provider: in `hardhat.config.ts`, import it and add it to `plugins`. It loads `hardhat-kms` itself. The rest of the file stays as the template made it:

<!-- docs-check: skip -->

```ts
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, hardhatKmsAws],
  // The rest of the template's config, unchanged.
});
```

Check that Hardhat finds the plugin:

::: code-group

```sh [npm]
npx hardhat kms --help
```

```sh [pnpm]
pnpm hardhat kms --help
```

```sh [Yarn]
yarn hardhat kms --help
```

:::

It lists the `kms` tasks, such as `kms accounts` and `kms address`. If it prints `Error HHE404: Task "kms" not found` instead, `hardhatKmsAws` is missing from `plugins`. You have created nothing in AWS yet, so an install problem costs nothing to fix.

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

The project refers to the key by its alias. Keep this shell open: step 8 uses `KEY_ID`, and so does the optional deployer policy.

## 3. Choose the identity that signs

Hardhat signs with the identity you signed in with. For this tutorial, that identity can be the one that created the key, so this step runs no command. Step 4 checks that it may sign.

A production deployer should have only `kms:GetPublicKey`, to derive the address, and `kms:Sign`, limited to what the plugin sends. The tutorial does not need that policy: [Optional: give a deployer only the sign policy](#optional-give-a-deployer-only-the-sign-policy), just before step 8, writes it, gives it to a new role and signs as that role.

## 4. Add the key to the project

Replace `hardhat.config.ts` with the file below. Compared with the template, it keeps `hardhatKmsAws` in `plugins` from step 1, adds a `kms` section with the key, gives the `sepolia` network `kmsAccounts` instead of `accounts`, so no private key is in the project, sets the network's `chainId` and turns Etherscan verification off:

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
      chainId: 11155111,
      url: configVariable("SEPOLIA_RPC_URL"),
      kmsAccounts: ["deployer"],
    },
  },
});
```

Etherscan needs an API key, and without one its verification fails. To verify on Etherscan too, get a key from [Etherscan](https://etherscan.io/apis), store it with `npx hardhat keystore set ETHERSCAN_API_KEY` or `export ETHERSCAN_API_KEY=…`, and replace `enabled: false` with `apiKey: configVariable("ETHERSCAN_API_KEY")`.

`chainId: 11155111` is Sepolia's chain id. Before the plugin signs a transaction, it asks the node for its chain; if `SEPOLIA_RPC_URL` points at another chain, it stops with [`core.chain.mismatch`](../reference/errors.md#chains) and signs nothing.

Set the RPC URL, then ask KMS for the key's address:

::: code-group

```sh [npm]
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
DEPLOYER_ADDRESS=$(npx hardhat kms address deployer)
echo "$DEPLOYER_ADDRESS"
```

```sh [pnpm]
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
DEPLOYER_ADDRESS=$(pnpm hardhat kms address deployer)
echo "$DEPLOYER_ADDRESS"
```

```sh [Yarn]
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
DEPLOYER_ADDRESS=$(yarn hardhat kms address deployer)
echo "$DEPLOYER_ADDRESS"
```

:::

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

::: code-group

```sh [npm]
npx hardhat kms accounts --check-sign
```

```sh [pnpm]
pnpm hardhat kms accounts --check-sign
```

```sh [Yarn]
yarn hardhat kms accounts --check-sign
```

:::

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

Fix the cause before step 5. An `AccessDeniedException` here means your credentials are not allowed `kms:Sign` on the key; check the permissions of the identity you signed in with.

## 5. Fund the address

Send about 0.01 Sepolia ETH to the deployer address, from a Sepolia faucet or from another account. Deploying the `Counter` contract and calling it costs much less than that on Sepolia.

The address belongs to the KMS key alone. If the key is deleted, any funds and contract roles at the address are lost for good, so step 8 sends the funds back before it removes the key.

To see the balance, open the address on [Sepolia Etherscan](https://sepolia.etherscan.io) or [Sepolia Blockscout](https://eth-sepolia.blockscout.com).

To try the deployment on a local fork of Sepolia before you fund the address, add the `sepoliaFork` network and `kms.simulatedBalance` from [Rehearse on a simulated network](../guides/deploy-with-ignition.md#3-rehearse-on-a-simulated-network), then run step 6's command with `--network sepoliaFork` and without `--verify`. The rehearsal signs with the real key, so it also checks the key and its permissions. Ignition does not ask you to confirm, and it starts with "You are running Hardhat Ignition against an in-process instance of Hardhat Network": that is the fork, and the results are lost when the command ends. It ends with a `Deployed Addresses` list, as in step 6.

## 6. Deploy and verify

Deploy the module from the deployer address, and verify the contract, in one command:

::: code-group

```sh [npm]
npx hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --verify --default-sender "$DEPLOYER_ADDRESS"
```

```sh [pnpm]
pnpm hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --verify --default-sender "$DEPLOYER_ADDRESS"
```

```sh [Yarn]
yarn hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --verify --default-sender "$DEPLOYER_ADDRESS"
```

:::

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

Both explorers may answer "already verified": the template's `Counter` is a common contract, and they have seen its code before. Blockscout may instead submit the source and end with `✅ Contract verified successfully on Blockscout!`; the contract is then verified too. Open the `Explorer:` link that Blockscout printed. If the page shows the contract as verified, you are done. If it shows a "verified twin" or a "similar match" instead, your contract is not verified yet: [Verify the source on block explorers](../guides/deploy-with-ignition.md#6-verify-the-source-on-block-explorers) has the command to run.

## 7. Open the contract on the explorer

Open the `Explorer:` links from the output, with your contract's address:

- Blockscout: `https://eth-sepolia.blockscout.com/address/<contract address>#code` shows the source, marked as verified, and the two transactions from your deployer address: the deployment and the `incBy` call.
- Sourcify: `https://sourcify.dev/server/repo-ui/11155111/<contract address>` shows the files and "Exact Match" or "Match". "Match", formerly "partial match", means the bytecode matches except the metadata hash at its end, so the source can differ in comments, variable names or file paths; the contract is verified either way ([Exact Match vs Match](https://docs.sourcify.dev/docs/exact-match-vs-match/)).
- Etherscan: `https://sepolia.etherscan.io/address/<contract address>#code`. This tutorial does not verify on Etherscan, so the contract has no verified source of its own there. Etherscan may show the source of another contract with the same bytecode, marked "Similar Match".

The `From` field of each transaction is your deployer address. The signature came from AWS KMS; Hardhat never held a private key.

## Optional: give a deployer only the sign policy

[Skip to step 8](#8-clean-up) if you do not need this section.

This section sets up a production deployer, which the tutorial does not need: an identity that may read the key's public key and sign with it, and do nothing else. It creates that identity as an IAM role and signs with the key as the role. Run it before step 8, while the key exists, in the shell from step 2, which has `KEY_ID`. In a new shell, set `KEY_ID` again first with the `describe-key` command at the start of step 8's key removal. Step 8 removes what this section adds, the role included.

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

If you have no deployer role, create one named `hardhat-deployer`. Its trust policy lets only the identity that runs these commands assume the role. It names your account and adds a condition on `aws:userid`, your identity's unique ID: an IAM user's ID, or for a role session, including an IAM Identity Center sign-in, the role's ID and your session name. That is the form AWS asks for with IAM Identity Center ([IAM Identity Center principals](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_principal.html#principal-identity-users), [Principal key values](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_variables.html#principaltable)). Because it names the account, your own permissions must also allow `sts:AssumeRole` on the role, as an administrator's do. Like the sign policy, the trust policy holds your account ID, so step 8 deletes its file too:

```sh
read -r ACCOUNT_ID CALLER_USERID <<< "$(aws sts get-caller-identity --query '[Account,UserId]' --output text)"
TRUST=kms-deployer-trust.json

cat > "$TRUST" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::$ACCOUNT_ID:root" },
      "Action": "sts:AssumeRole",
      "Condition": { "StringEquals": { "aws:userid": "$CALLER_USERID" } }
    }
  ]
}
EOF

aws iam create-role --role-name hardhat-deployer \
  --assume-role-policy-document "file://$TRUST" \
  --max-session-duration 3600 --output none
```

If you sign in as the account's root user, use an IAM identity instead: only an IAM user or role can call `AssumeRole` ([Compare AWS STS credentials](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_sts-comparison.html)).

A new role has no permissions. Attach the policy to give it the two the plugin needs. For the role named `hardhat-deployer`, whether you created it above or had it already:

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

The simulator only evaluates the policy. To sign as the role, assume it. `sts assume-role` returns credentials that expire after one hour; the commands keep them in shell variables and print nothing. A role you just created can take a few seconds before it can be assumed: if the command fails with `AccessDenied`, wait 10 seconds and run it again:

```sh
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

read -r ROLE_KEY_ID ROLE_SECRET ROLE_TOKEN <<< "$(aws sts assume-role \
  --role-arn "arn:aws:iam::$ACCOUNT_ID:role/hardhat-deployer" \
  --role-session-name hardhat-kms-tutorial \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
```

The function below runs one command with the role's credentials, so your own commands keep running as you. It removes `AWS_PROFILE` for that command: with `AWS_PROFILE` set, the AWS SDK that the plugin uses ignores access keys in the environment and signs as the profile ([Credentials](../reference/credentials.md#aws)). Since the profile is gone, the function also passes your region in `AWS_REGION`. The function runs in a subshell and exports the credentials to that one command; they stay in unexported variables of this shell until step 8 unsets them. It stops with `is empty` if a role variable is missing:

```sh
as_deployer() (
  region="${AWS_REGION:-$(aws configure get region)}"
  unset AWS_PROFILE
  export AWS_ACCESS_KEY_ID="${ROLE_KEY_ID:?is empty: run the aws sts assume-role command above}"
  export AWS_SECRET_ACCESS_KEY="${ROLE_SECRET:?is empty: run the aws sts assume-role command above}"
  export AWS_SESSION_TOKEN="${ROLE_TOKEN:?is empty: run the aws sts assume-role command above}"
  export AWS_REGION="$region"
  "$@"
)

as_deployer aws sts get-caller-identity --query Arn --output text
```

It prints `arn:aws:sts::<account ID>:assumed-role/hardhat-deployer/hardhat-kms-tutorial`: the role, not you. If it prints another identity, or stops with `is empty`, `assume-role` failed: run it again before you go on. Now check that the role may sign with the key:

::: code-group

```sh [npm]
as_deployer npx hardhat kms accounts --check-sign
```

```sh [pnpm]
as_deployer pnpm hardhat kms accounts --check-sign
```

```sh [Yarn]
as_deployer yarn hardhat kms accounts --check-sign
```

:::

It prints the same row as in step 4, with `matches` under `PIN` and `ok` under `SIGN`, this time signed by a role that holds only the sign policy. To deploy as the role, put `as_deployer` before step 6's command. When the credentials expire, run the `assume-role` command again.

## 8. Clean up

When you are done, send the remaining Sepolia ETH back, then disable the key and schedule its deletion. In a new shell, set `SEPOLIA_RPC_URL` again first, as in step 4.

Send the balance back with the script in [Return the funds from a KMS address](../guides/return-funds.md): save it as `scripts/return-funds.ts`, then run it with `RETURN_TO` set to an address with no code, such as your own wallet's:

::: code-group

```sh [npm]
RETURN_TO=<return address> npx hardhat run scripts/return-funds.ts
```

```sh [pnpm]
RETURN_TO=<return address> pnpm hardhat run scripts/return-funds.ts
```

```sh [Yarn]
RETURN_TO=<return address> yarn hardhat run scripts/return-funds.ts
```

:::

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

While the alias exists, a second run of this tutorial stops at step 2's `create-alias`, because the name is taken. To run the tutorial again within the 7 days, give the alias another name, such as `alias/hardhat-kms-tutorial-2`, in step 2's `create-alias` and in step 4's `keyId`. Deleting the old alias with `aws kms delete-alias --alias-name alias/hardhat-kms-tutorial` frees the name without touching the key, but then only the key ID finds that key, so note it first if you may cancel the deletion.

If you followed [Optional: give a deployer only the sign policy](#optional-give-a-deployer-only-the-sign-policy), delete its policy file, from the project directory:

```sh
rm kms-sign-policy.json
```

If you attached the policy to a role there, remove it from the role:

```sh
aws iam delete-role-policy --role-name hardhat-deployer --policy-name hardhat-kms-tutorial
```

For an IAM user, use `aws iam delete-user-policy --user-name <user name> --policy-name hardhat-kms-tutorial` instead. If your administrator added the policy to a permission set, ask them to remove it.

If you created the `hardhat-deployer` role there, delete it now that its policy is gone; IAM refuses to delete a role that still has a policy. Then delete the trust policy file and the role's credentials:

```sh
aws iam delete-role --role-name hardhat-deployer
rm kms-deployer-trust.json
unset ROLE_KEY_ID ROLE_SECRET ROLE_TOKEN
```

Credentials the role handed out stay valid until they expire, within the hour, but with the policy removed they can no longer use the key.

To keep the key instead, run only the `disable-key` command: a disabled key cannot sign, `aws kms enable-key` brings it back, and it still costs $1 a month.

## Next steps

- [Deploy with Hardhat Ignition](../guides/deploy-with-ignition.md): choose the deployer, rehearse on a simulated network and verify the source on block explorers.
- [Set up an AWS KMS key](../guides/aws-kms-setup.md): every option of an AWS key, and the errors you can meet.
- [Errors](../reference/errors.md#hardhat-kmsaws): every error message, with its cause and fix.
- [Prevent and recover from losing a key](../guides/key-loss.md) before the key holds anything of value.
