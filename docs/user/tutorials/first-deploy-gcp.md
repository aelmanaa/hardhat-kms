---
title: First deploy on Sepolia with Google Cloud KMS
description: "Deploy a Hardhat 3 contract to Sepolia with Google Cloud KMS: create an HSM secp256k1 key, deploy from it, verify the source and destroy it."
---

# First deploy on Sepolia with Google Cloud KMS

Audience: developers who have a Google Cloud project and the gcloud CLI signed in, and have not used Cloud KMS with Hardhat.

This tutorial was followed from an empty directory on 2026-10-02, at commit [`ab3ee2a`](https://github.com/aelmanaa/hardhat-kms/commit/ab3ee2a), with Hardhat 3.18.1 and `@nomicfoundation/hardhat-verify` 3.1.2. The commands took about 6 minutes, without the wait for Sepolia ETH. The run kept the 30-day default destroy schedule; the [key-loss check](../guides/key-loss.md#google-cloud-kms) covers the 24-hour schedule of step 2. The plugin is not on npm yet; step 1 says how to install it until then.

In this tutorial you create a Hardhat project, create a signing key in Google Cloud KMS, deploy a contract to Sepolia from that key and verify its source on block explorers. The private key never leaves Cloud KMS: Hardhat asks Cloud KMS for a signature each time it sends a transaction.

It takes about 15 minutes, plus the time it takes to get Sepolia ETH.

You need:

- Node.js 22.13.0 or later (see [supported Node.js versions](../reference/support.md)), and npm, pnpm or Yarn.
- A POSIX shell, such as bash or zsh; on Windows, use WSL. Step 3 also uses `curl` to show which account the plugin signs in as. Until the plugin's first npm release you need Git too: [Install before the first npm release](../guides/install-before-release.md) clones the repository.
- The gcloud CLI, signed in with an identity that can create Cloud KMS keys and grant roles on them, and a project set: `gcloud config get-value project` prints it. The project Owner role is enough, and so is Cloud KMS Admin; Cloud KMS Admin cannot read a public key or sign, so step 3 grants the two roles that can. The project needs billing and the Cloud KMS API turned on; `gcloud services enable cloudkms.googleapis.com` turns the API on.
- Application Default Credentials: run `gcloud auth application-default login` once. The plugin signs in with these, not with the gcloud CLI's own sign-in, and the two can be different accounts; step 3 shows how to see which one the plugin uses.
- A Sepolia RPC URL. The examples use the public `https://ethereum-sepolia-rpc.publicnode.com`; a provider URL with an API key works too.
- About 0.01 Sepolia ETH, from a faucet or another account.

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

Install the core plugin, `hardhat-kms`, and the Google Cloud provider, `@hardhat-kms/gcp`, in the project with [Install before the first npm release](../guides/install-before-release.md): the packages are not on npm yet, so that page builds them from the repository. Come back here after its step 3.

Register the provider: in `hardhat.config.ts`, import it and add it to `plugins`. It loads `hardhat-kms` itself. The rest of the file stays as the template made it:

<!-- docs-check: skip -->

```ts
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsGcp from "@hardhat-kms/gcp";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, hardhatKmsGcp],
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

It lists the `kms` tasks, such as `kms accounts` and `kms address`. If it prints `Error HHE404: Task "kms" not found` instead, `hardhatKmsGcp` is missing from `plugins`. You have created nothing in Google Cloud yet, so an install problem costs nothing to fix.

## 2. Create a key in Cloud KMS

Cloud KMS offers the secp256k1 curve only at protection level HSM, and an HSM key version costs about $2.50 a month ($0.003424658 an hour). Google bills it while the version is enabled, disabled or scheduled for destruction; only a destroyed version is free. Signing and reading the public key cost at most $0.15 per 10,000 calls. The free tier covers only keys made by Cloud KMS Autokey, so not this one. See [Cloud KMS pricing](https://cloud.google.com/kms/pricing). Step 8 schedules the version for destruction, and the 24 hours it waits are billed too, so the key costs about $0.10 in all.

Set the project and a location for the key. The examples use `us-east1`; any Cloud KMS region works. The project's config reads both variables in step 4:

```sh
export GCP_PROJECT_ID=$(gcloud config get-value project)
export GCP_LOCATION=us-east1
```

Create a key ring, then a secp256k1 signing key in it, which Cloud KMS calls `EC_SIGN_SECP256K1_SHA256`:

```sh
gcloud kms keyrings create hardhat-kms-tutorial --location "$GCP_LOCATION"

gcloud kms keys create deployer \
  --keyring hardhat-kms-tutorial \
  --location "$GCP_LOCATION" \
  --purpose asymmetric-signing \
  --default-algorithm ec-sign-secp256k1-sha256 \
  --protection-level hsm \
  --destroy-scheduled-duration 24h
```

The key gets version `1`, which the project signs with. At protection level `software`, the same command fails with `ALGORITHM_NOT_SUPPORTED_FOR_PROTECTION_LEVEL`.

A key ring and a key cannot be deleted, so their names stay in the project; they cost nothing. If you ran this tutorial before, the key ring exists already: skip its `create`, and give the key another name, here and in the rest of the page.

`--destroy-scheduled-duration 24h` sets the shortest wait Cloud KMS allows between scheduling a version's destruction and destroying it. The duration is fixed when the key is created. A short wait keeps the cost of this tutorial down, but it leaves you one day to undo the destruction in step 8. Give a key that will hold value a long duration, up to 120 days; [Prevent and recover from losing a key](../guides/key-loss.md#guard-a-google-cloud-kms-key) explains why. If an organization policy, `constraints/cloudkms.minimumDestroyScheduledDuration`, refuses `24h`, use the smallest value it allows.

## 3. Allow the key to sign, and nothing else

Hardhat signs as the identity of your Application Default Credentials (ADC), not as the account the gcloud CLI uses. `gcloud auth login` signs in the gcloud CLI, which runs the `gcloud` commands on this page. `gcloud auth application-default login` writes separate credentials, which Google's client libraries use, and so does the plugin ([How Application Default Credentials works](https://docs.cloud.google.com/docs/authentication/application-default-credentials)). Both can be the same account, but they do not have to be.

The ADC identity needs two permissions on this key: `cloudkms.cryptoKeyVersions.viewPublicKey`, to derive the address, and `cloudkms.cryptoKeyVersions.useToSign`, to sign. Creating the key does not give them. Cloud KMS Admin has neither: it "provides access to Cloud KMS resources, except for access to restricted resource types and cryptographic operations" ([Cloud KMS permissions and roles](https://docs.cloud.google.com/kms/docs/reference/permissions-and-roles)). The project Owner role has both, which is how the recorded run signed. The two-role grant below is not yet checked against real Cloud KMS ([Set up a Google Cloud KMS key](../guides/gcp-kms-setup.md#2-allow-signing-and-nothing-else)).

The predefined roles `roles/cloudkms.publicKeyViewer` and `roles/cloudkms.signer` hold one each. List what they hold:

```sh
gcloud iam roles describe roles/cloudkms.publicKeyViewer --format='value(includedPermissions)'
gcloud iam roles describe roles/cloudkms.signer --format='value(includedPermissions)'
```

The output:

```text
cloudkms.cryptoKeyVersions.viewPublicKey;cloudkms.locations.get;cloudkms.locations.list;resourcemanager.projects.get
cloudkms.cryptoKeyVersions.useToSign;cloudkms.locations.get;cloudkms.locations.list;resourcemanager.projects.get
```

Next to the one key permission, each role can only read the project and list the Cloud KMS locations. Neither can disable, destroy or restore a key version, nor change who has access.

Find the ADC identity. First check that the gcloud CLI does not impersonate a service account:

```sh
gcloud config get auth/impersonate_service_account
```

If it prints an account, note it, and run `gcloud config unset auth/impersonate_service_account`. That setting changes which token the next command gets, but the plugin does not read gcloud settings, so the check would name the wrong identity.

Then get an access token from your ADC and ask Google's token information endpoint whose it is. The token goes in the request body and is not printed:

```sh
curl -s -d "access_token=$(gcloud auth application-default print-access-token \
  --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email)" \
  https://www.googleapis.com/oauth2/v1/tokeninfo
```

The `email` field of the response is the identity. The command asks for the `userinfo.email` scope because the response has `email` only when the token has that scope ([Token types](https://docs.cloud.google.com/docs/authentication/token-types)). With credentials from `gcloud auth application-default login`, the email is the account you chose in the browser. If it ends in `.gserviceaccount.com`, ADC holds a service account: the one you named with `gcloud auth application-default login --impersonate-service-account`, or the one whose key file `GOOGLE_APPLICATION_CREDENTIALS` names.

If the response still has no `email`, ADC holds a service account, and the `azp` field is its unique ID. Print its email with `gcloud iam service-accounts describe <azp> --format='value(email)'`.

Set `DEPLOYER` to that identity, with `user:` before a person's email and `serviceAccount:` before a service account's:

```sh
DEPLOYER="user:<email>"
```

For a service account named `hardhat-deployer`, it is `DEPLOYER="serviceAccount:hardhat-deployer@$GCP_PROJECT_ID.iam.gserviceaccount.com"`.

If you unset `auth/impersonate_service_account` above and your gcloud commands rely on it, set it again with the account you noted: `gcloud config set auth/impersonate_service_account <account>`.

Grant both roles on the key, not on the project, so the identity can use no other key. The gcloud CLI account runs the grant, which needs `cloudkms.cryptoKeys.setIamPolicy`; Owner and Cloud KMS Admin hold it:

```sh
for role in roles/cloudkms.publicKeyViewer roles/cloudkms.signer; do
  gcloud kms keys add-iam-policy-binding deployer \
    --keyring hardhat-kms-tutorial \
    --location "$GCP_LOCATION" \
    --member "$DEPLOYER" \
    --role "$role"
done
```

A new grant typically takes 2 minutes to apply, and can take 7 minutes or longer ([Access change propagation](https://docs.cloud.google.com/iam/docs/access-change-propagation)). If step 4 fails with `permission denied (PERMISSION_DENIED)` soon after the grant, wait and run it again.

If the deployer then gets `PERMISSION_DENIED` about `serviceusage.services.use`, look at its quota project. If the ADC account has `serviceusage.services.use` on the gcloud CLI's project, `gcloud auth application-default login` writes that project into the credentials as the quota project; without the permission, it writes none and says so ([`gcloud auth application-default login`](https://cloud.google.com/sdk/gcloud/reference/auth/application-default/login)). The client then names the quota project in each request (the `x-goog-user-project` header), which needs `serviceusage.services.use` on it. Either set a project the deployer may use with `gcloud auth application-default set-quota-project <project>`, sign in again with `gcloud auth application-default login --disable-quota-project`, or grant the deployer `roles/serviceusage.serviceUsageConsumer` on the project ([Set the quota project](https://docs.cloud.google.com/docs/quotas/set-quota-project)).

To check who has access to the key, without changing anything:

```sh
gcloud kms keys get-iam-policy deployer --keyring hardhat-kms-tutorial --location "$GCP_LOCATION"
```

Before any grant it prints only an `etag` line, since the key has no bindings of its own; your access comes from the project. After the grant it lists the two roles, each with the deployer as member. [Set up a Google Cloud KMS key](../guides/gcp-kms-setup.md#2-allow-signing-and-nothing-else) covers the roles in more detail.

## 4. Add the key to the project

Replace `hardhat.config.ts` with the file below. Compared with the template, it keeps `hardhatKmsGcp` in `plugins` from step 1, adds a `kms` section with the key, gives the `sepolia` network `kmsAccounts` instead of `accounts`, so no private key is in the project, sets the network's `chainId` and turns Etherscan verification off. The key's project and location come from the variables you set in step 2, so the project ID stays out of the file:

```ts
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsGcp from "@hardhat-kms/gcp";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, hardhatKmsGcp],
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
        provider: "gcp",
        projectId: configVariable("GCP_PROJECT_ID"),
        location: configVariable("GCP_LOCATION"),
        keyRing: "hardhat-kms-tutorial",
        keyName: "deployer",
        keyVersion: "1",
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

Every command that uses the key needs `GCP_PROJECT_ID` and `GCP_LOCATION`. Run them in the same shell as step 2, or export the two variables again first.

Set the RPC URL, then ask Cloud KMS for the key's address:

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
        provider: "gcp",
        projectId: configVariable("GCP_PROJECT_ID"),
        location: configVariable("GCP_LOCATION"),
        keyRing: "hardhat-kms-tutorial",
        keyName: "deployer",
        keyVersion: "1",
        address: "<deployer address>",
      },
    },
  },
```

With the pin, the plugin refuses to sign if the variables ever name another project, location or key with the same names. [Rotate a key and pin its address](../guides/key-rotation.md#what-a-pin-does) explains why.

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
deployer  gcp       kms.keys  <deployer address>                          matches  ok    gcp:projects/<GCP_PROJECT_ID>/locations/<GCP_LOCATION>/keyRings/hardhat-kms-tutorial/cryptoKeys/deployer/cryptoKeyVersions/1
```

`matches` under `PIN` and `ok` under `SIGN` prove that your credentials may sign with the key and that its signatures recover to the pinned address. The check signs a random message, not a transaction, so it needs no funds. On `FAILED`, read the `error:` line under the row and fix the cause before step 5.

## 5. Fund the address

Send about 0.01 Sepolia ETH to the deployer address, from a Sepolia faucet or from another account. Deploying the `Counter` contract and calling it costs much less than that on Sepolia.

The address belongs to the key version alone. If the version is destroyed, any funds and contract roles at the address are lost for good, so step 8 sends the funds back before it destroys the version.

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

Ignition asks you to confirm the network; answer `y`. Each transaction usually costs one Cloud KMS `AsymmetricSign` call; retries can add more. Naming the sender by its address keeps the deployer the same when you add accounts or keys to the network later; [Choose the sender by address](../guides/multiple-keys.md#choose-the-sender-by-address) explains why.

Ignition deploys `Counter`, calls `incBy(5)`, then verifies the contract on Blockscout and Sourcify. The end of the output looks like this:

```text
[ CounterModule ] successfully deployed 🚀

Deployed Addresses

CounterModule#Counter - 0xEFa2D146dC54546358157D816443Cd68C31DF95A

Verifying deployed contracts

Verifying contract "contracts/Counter.sol:Counter" for network sepolia...

=== Blockscout ===

The contract at 0xEFa2D146dC54546358157D816443Cd68C31DF95A has already been verified on Blockscout.

If you need to verify a partially verified contract, please use the --force flag.

Explorer: https://eth-sepolia.blockscout.com/address/0xEFa2D146dC54546358157D816443Cd68C31DF95A#code

=== Sourcify ===

The contract at 0xEFa2D146dC54546358157D816443Cd68C31DF95A has already been verified on Sourcify.

If you need to verify a partially verified contract, please use the --force flag.

Explorer: https://sourcify.dev/server/repo-ui/11155111/0xEFa2D146dC54546358157D816443Cd68C31DF95A
```

Both explorers may answer "already verified": the template's `Counter` is a common contract, and they have seen its code before. Blockscout may instead submit the source and end with `✅ Contract verified successfully on Blockscout!`; the contract is then verified too. Open the `Explorer:` link that Blockscout printed. If the page shows the contract as verified, you are done. If it shows a "verified twin" or a "similar match" instead, your contract is not verified yet: [Verify the source on block explorers](../guides/deploy-with-ignition.md#6-verify-the-source-on-block-explorers) has the command to run.

## 7. Open the contract on the explorer

Open the `Explorer:` links from the output, with your contract's address:

- Blockscout: `https://eth-sepolia.blockscout.com/address/<contract address>#code` shows the source, marked as verified, and the two transactions from your deployer address: the deployment and the `incBy` call.
- Sourcify: `https://sourcify.dev/server/repo-ui/11155111/<contract address>` shows the files and an exact match.
- Etherscan: `https://sepolia.etherscan.io/address/<contract address>#code`. This tutorial does not verify on Etherscan, so the contract has no verified source of its own there. Etherscan may show the source of another contract with the same bytecode, marked "Similar Match".

The `From` field of each transaction is your deployer address. The signature came from Cloud KMS; Hardhat never held a private key.

## 8. Clean up

When you are done, send the remaining Sepolia ETH back, then disable the key version and schedule its destruction. In a new shell, set `SEPOLIA_RPC_URL`, `GCP_PROJECT_ID` and `GCP_LOCATION` again first, as in steps 2 and 4: the script loads the config, which reads them.

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

Then disable the key version and schedule its destruction. If you closed the shell since step 3, set `GCP_PROJECT_ID`, `GCP_LOCATION` and `DEPLOYER` again first, as in steps 2 and 3:

```sh
gcloud kms keys versions disable 1 --key deployer --keyring hardhat-kms-tutorial --location "$GCP_LOCATION"
gcloud kms keys versions destroy 1 --key deployer --keyring hardhat-kms-tutorial --location "$GCP_LOCATION"
```

Disabling first is not required, but an organization policy can require it (`constraints/cloudkms.disableBeforeDestroy`). See when the version will be destroyed:

```sh
gcloud kms keys versions describe 1 --key deployer --keyring hardhat-kms-tutorial --location "$GCP_LOCATION" \
  --format='value(state,destroyTime)'
```

It prints `DESTROY_SCHEDULED` and a time 24 hours from now. Until the destroy time, you can undo it: restore the version, then enable it. [Prevent and recover from losing a key](../guides/key-loss.md#google-cloud-kms) covers it:

```sh
gcloud kms keys versions restore 1 --key deployer --keyring hardhat-kms-tutorial --location "$GCP_LOCATION"
gcloud kms keys versions enable 1 --key deployer --keyring hardhat-kms-tutorial --location "$GCP_LOCATION"
```

The change takes a moment to reach every Cloud KMS server. A disabled version usually keeps working for up to a minute, and in exceptional cases for several hours ([Cloud KMS resource consistency](https://docs.cloud.google.com/kms/docs/consistency)). In the recorded run, the version still signed 30 seconds after the `destroy`, and refused with `the key version cannot be used (FAILED_PRECONDITION)` a minute later.

After the 24 hours, the version is destroyed for good, and nothing can sign for the address again. The key ring and the key stay, with no cost.

Remove the two roles you granted in step 3:

```sh
for role in roles/cloudkms.publicKeyViewer roles/cloudkms.signer; do
  gcloud kms keys remove-iam-policy-binding deployer \
    --keyring hardhat-kms-tutorial \
    --location "$GCP_LOCATION" \
    --member "$DEPLOYER" \
    --role "$role"
done
```

To keep the key instead, run only the `disable` command: a disabled version cannot sign, `gcloud kms keys versions enable` brings it back, and it still costs about $2.50 a month.

## Next steps

- [Deploy with Hardhat Ignition](../guides/deploy-with-ignition.md): choose the deployer, rehearse on a simulated network and verify the source on block explorers.
- [Set up a Google Cloud KMS key](../guides/gcp-kms-setup.md): every option of a Cloud KMS key, and the errors you can meet.
- [Errors](../reference/errors.md#hardhat-kmsgcp): every error message, with its cause and fix.
- [Prevent and recover from losing a key](../guides/key-loss.md) before the key holds anything of value.
