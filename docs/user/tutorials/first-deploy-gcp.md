# First deploy on Sepolia with Google Cloud KMS

Audience: developers who have a Google Cloud project and the gcloud CLI signed in, and have not used Cloud KMS with Hardhat.

Status: followed from an empty directory on 2026-10-02, at commit [`ab3ee2a`](https://github.com/aelmanaa/hardhat-kms/commit/ab3ee2a), with Hardhat 3.18.1 and `@nomicfoundation/hardhat-verify` 3.1.2. The commands took about 6 minutes, without the wait for Sepolia ETH ([#66](https://github.com/aelmanaa/hardhat-kms/issues/66)). The run kept the 30-day default destroy schedule; the 24-hour schedule in step 2 ran on an HSM secp256k1 key in the [key-loss check](../guides/key-loss.md#google-cloud-kms) of 2026-10-01. The plugin is not on npm yet; step 4 says how to install it until then.

In this tutorial you create a Hardhat project, create a signing key in Google Cloud KMS, deploy a contract to Sepolia from that key and verify its source on block explorers. The private key never leaves Cloud KMS: Hardhat asks Cloud KMS for a signature each time it sends a transaction.

It takes about 15 minutes, plus the time it takes to get Sepolia ETH.

You need:

- Node.js 22.13 or later, and npm.
- The gcloud CLI, signed in with an identity that can create Cloud KMS key rings and keys, such as one with the Cloud KMS Admin role, and a project set: `gcloud config get-value project` prints it. The project needs billing and the Cloud KMS API turned on; `gcloud services enable cloudkms.googleapis.com` turns the API on.
- Application Default Credentials: run `gcloud auth application-default login` once. The plugin signs in with these, not with the gcloud CLI's own sign-in.
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

`--destroy-scheduled-duration 24h` sets the shortest wait Cloud KMS allows between scheduling a version's destruction and destroying it. The duration is fixed when the key is created. A short wait keeps the cost of this tutorial down, but it leaves you one day to undo the destruction in step 8. Give a key that will hold value a long duration, up to 120 days; [Prevent and recover from losing a key](../guides/key-loss.md#google-cloud-kms) explains why. If an organization policy, `constraints/cloudkms.minimumDestroyScheduledDuration`, refuses `24h`, use the smallest value it allows.

## 3. Allow the key to sign, and nothing else

Hardhat signs with your Application Default Credentials. For this tutorial, that identity can be the one that created the key; the recorded run signed as the project's owner, and the two-role grant below is not yet checked against real Cloud KMS ([Set up a Google Cloud KMS key](../guides/gcp-kms-setup.md#2-allow-signing-and-nothing-else)). A real deployer should have only two permissions, on this key alone: `cloudkms.cryptoKeyVersions.viewPublicKey`, to derive the address, and `cloudkms.cryptoKeyVersions.useToSign`, to sign.

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

To give a deployer both roles, grant them on the key, not on the project, so the deployer can use no other key. For example, for a service account named `hardhat-deployer`:

```sh
DEPLOYER="serviceAccount:hardhat-deployer@$GCP_PROJECT_ID.iam.gserviceaccount.com"

for role in roles/cloudkms.publicKeyViewer roles/cloudkms.signer; do
  gcloud kms keys add-iam-policy-binding deployer \
    --keyring hardhat-kms-tutorial \
    --location "$GCP_LOCATION" \
    --member "$DEPLOYER" \
    --role "$role"
done
```

For a person, use `DEPLOYER="user:<email>"` instead.

If the deployer then gets `PERMISSION_DENIED` about `serviceusage.services.use`, look at its quota project. `gcloud auth application-default login` writes the gcloud CLI's project into the credentials as the quota project, and the client then names that project in each request (the `x-goog-user-project` header), which needs `serviceusage.services.use` on it. Either set a project the deployer may use with `gcloud auth application-default set-quota-project <project>`, sign in again with `gcloud auth application-default login --disable-quota-project`, or grant the deployer `roles/serviceusage.serviceUsageConsumer` on the project ([Set the quota project](https://docs.cloud.google.com/docs/quotas/set-quota-project)).

To check who has access to the key, without changing anything:

```sh
gcloud kms keys get-iam-policy deployer --keyring hardhat-kms-tutorial --location "$GCP_LOCATION"
```

Before any grant it prints only an `etag` line, since the key has no bindings of its own; your access comes from the project. After the grant it lists the two roles, each with the deployer as member. [Set up a Google Cloud KMS key](../guides/gcp-kms-setup.md#2-allow-signing-and-nothing-else) covers the roles in more detail.

## 4. Add the plugin and the key to the project

Install the core plugin and the Google Cloud provider:

```sh
npm install --save-dev hardhat-kms @hardhat-kms/gcp
```

Until the packages are published on npm, this command fails with `E404`. Build them from a clone of the [repository](https://github.com/aelmanaa/hardhat-kms) instead: run `pnpm install`, then `pnpm run build`, then `pnpm pack` in `packages/hardhat-kms` and in `packages/hardhat-kms-gcp`. Install the two `.tgz` files it writes with `npm install --save-dev <path to hardhat-kms tgz> <path to provider tgz>`. The provider's file is named `hardhat-kms-gcp-<version>.tgz`, although the package inside is `@hardhat-kms/gcp`.

In a pnpm project, install with `pnpm add -D hardhat-kms @hardhat-kms/gcp`. pnpm 12 runs no install scripts of dependencies until the project decides on each, and stops with `ERR_PNPM_IGNORED_BUILDS` for `esbuild`, which Hardhat depends on, and `protobufjs`, which the Google Cloud SDK depends on. Neither script is needed: esbuild's checks its platform binary and protobufjs's prints a warning. Add this to `pnpm-workspace.yaml`, next to `package.json`, and install again:

```yaml
allowBuilds:
  esbuild: false
  protobufjs: false
```

Replace `hardhat.config.ts` with the file below. Compared with the template, it adds `hardhatKmsGcp` to `plugins`, adds a `kms` section with the key, gives the `sepolia` network `kmsAccounts` instead of `accounts`, so no private key is in the project, and turns Etherscan verification off. The key's project and location come from the variables you set in step 2, so the project ID stays out of the file:

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
      url: configVariable("SEPOLIA_RPC_URL"),
      kmsAccounts: ["deployer"],
    },
  },
});
```

Etherscan needs an API key, and without one its verification fails. To verify on Etherscan too, get a key from [Etherscan](https://etherscan.io/apis), store it with `npx hardhat keystore set ETHERSCAN_API_KEY` or `export ETHERSCAN_API_KEY=…`, and replace `enabled: false` with `apiKey: configVariable("ETHERSCAN_API_KEY")`.

Every command that uses the key needs `GCP_PROJECT_ID` and `GCP_LOCATION`. Run them in the same shell as step 2, or export the two variables again first.

Set the RPC URL, then ask Cloud KMS for the key's address:

```sh
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
npx hardhat kms address deployer
```

It prints the key's address, `0x` and 40 hex digits. Pin it: add an `address` line to the `deployer` key, with the address you got in place of `<deployer address>`:

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

With the pin, the plugin refuses to sign if the variables ever name another project, location or key with the same names. [Rotate a key and pin its address](../guides/key-rotation.md#what-a-pin-does) explains why.

## 5. Fund the address

Send about 0.01 Sepolia ETH to the deployer address, from a Sepolia faucet or from another account. Deploying the `Counter` contract and calling it costs much less than that on Sepolia.

The address belongs to the key version alone. If the version is destroyed, any funds and contract roles at the address are lost for good, so step 8 sends the funds back before it destroys the version.

To see the balance, open the address on [Sepolia Etherscan](https://sepolia.etherscan.io) or [Sepolia Blockscout](https://eth-sepolia.blockscout.com).

## 6. Deploy and verify

Deploy the module from the deployer address, and verify the contract, in one command:

```sh
npx hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --verify --default-sender <deployer address>
```

Ignition asks you to confirm the network; answer `y`. Each transaction costs one Cloud KMS `AsymmetricSign` call. Naming the sender by its address keeps the deployer the same when you add accounts or keys to the network later; [Choose the sender by address](../guides/multiple-keys.md#choose-the-sender-by-address) explains why.

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
  Address: <contract address>

⏳ Waiting for verification result...


✅ Contract verified successfully on Blockscout!
```

If it fails with `HHE80022` and says the contract `is already verified`, the contract is verified, and there is nothing left to do. Blockscout limits how often it answers requests without an API key. If the command fails with `Response status code 429: Too Many Requests`, wait a few minutes and run it again.

## 7. Open the contract on the explorer

Open the `Explorer:` links from the output, with your contract's address:

- Blockscout: `https://eth-sepolia.blockscout.com/address/<contract address>#code` shows the source, marked as verified, and the two transactions from your deployer address: the deployment and the `incBy` call.
- Sourcify: `https://sourcify.dev/server/repo-ui/11155111/<contract address>` shows the files and an exact match.
- Etherscan: `https://sepolia.etherscan.io/address/<contract address>#code`. This tutorial does not verify on Etherscan, so the contract has no verified source of its own there. Etherscan may show the source of another contract with the same bytecode, marked "Similar Match".

The `From` field of each transaction is your deployer address. The signature came from Cloud KMS; Hardhat never held a private key.

## 8. Clean up

When you are done, send the remaining Sepolia ETH back, then disable the key version and schedule its destruction.

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

A tiny amount stays behind, 0.0000045 ETH in the recorded run, because the script reserves the fee at the highest price the transaction may pay. Run again, the script stops with `the balance of <deployer address>, … ETH, does not cover the fee` and sends nothing.

Then disable the key version and schedule its destruction:

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

If you granted the roles in step 3, remove them:

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

- [Deploy with Hardhat Ignition](../guides/deploy-with-ignition.md): choose the deployer and rehearse on a simulated network.
- [Set up a Google Cloud KMS key](../guides/gcp-kms-setup.md): every option of a Cloud KMS key, and the errors you can meet.
- [Errors](../reference/errors.md#hardhat-kmsgcp): every error message, with its cause and fix.
- [Prevent and recover from losing a key](../guides/key-loss.md) before the key holds anything of value.
