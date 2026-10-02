# First deploy on Sepolia with Azure Key Vault

Audience: developers who have an Azure subscription and the Azure CLI signed in, and have not used Azure Key Vault with Hardhat.

Status: followed from an empty directory on 2026-10-02, at commit [`0afbad3`](https://github.com/aelmanaa/hardhat-kms/commit/0afbad3), with Hardhat 3.18.1 and `@nomicfoundation/hardhat-verify` 3.1.2. The commands took about 4 minutes, without the wait for Sepolia ETH ([#67](https://github.com/aelmanaa/hardhat-kms/issues/67)). The run used an existing Standard vault with RBAC, so it did not run the commands that create the resource group and the vault, assign roles or delete the vault; it ran every command on the key. The plugin is not on npm yet; step 4 says how to install it until then.

In this tutorial you create a Hardhat project, create a signing key in Azure Key Vault, deploy a contract to Sepolia from that key and verify its source on block explorers. The private key never leaves Key Vault: Hardhat asks Key Vault for a signature each time it sends a transaction.

It takes about 15 minutes, plus the time it takes to get Sepolia ETH.

You need:

- Node.js 22.13 or later, and npm.
- The Azure CLI, signed in with `az login`, with a subscription where you can create a resource group and a key vault and assign roles, such as one where you have the Owner role. The plugin finds the same sign-in as the CLI. If `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` or `AZURE_CLIENT_SECRET` are set in your shell, the plugin tries them first; see [Sign in](../guides/azure-key-vault-setup.md#3-sign-in).
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

## 2. Create a vault and a key

A Standard vault has no monthly fee, and an `EC` key in it has none either. Each `get` or `sign` operation on the key costs $0.15 per 10,000, the price of "advanced key operations" in East US on 2026-10-02; prices vary by region. A deleted key cannot be used, so it costs nothing. See [Azure Key Vault pricing](https://azure.microsoft.com/pricing/details/key-vault/). Step 8 removes the key and the vault.

This tutorial uses an `EC` key in a Standard vault, the cheapest kind that can sign for Ethereum. Key Vault keeps its private key in software. For production, consider an `EC-HSM` key in a Premium vault, which keeps the private key in a hardware security module and costs $5 a month per key ([About keys](https://learn.microsoft.com/azure/key-vault/keys/about-keys)).

Choose a region and a vault name. The name must be unique across Azure, 3 to 24 letters, digits and hyphens, starting with a letter. `az account list-locations --query '[].name' --output tsv` lists the regions:

```sh
LOCATION=<region>
VAULT="kms-tutorial-$(openssl rand -hex 4)"
echo "$VAULT"
```

Create a resource group and a Standard vault in it:

```sh
az group create --name hardhat-kms-tutorial --location "$LOCATION"
az keyvault create --name "$VAULT" --resource-group hardhat-kms-tutorial --location "$LOCATION" --sku standard
```

Some regions refuse new vaults for some subscriptions. If `az keyvault create` fails for the region, delete the resource group with `az group delete --name hardhat-kms-tutorial`, choose another region and run both commands again.

A new vault uses Azure role-based access control (RBAC), and creating it gives you no access to its keys, even as the subscription's Owner. Give yourself the **Key Vault Crypto Officer** role on the vault, which can create and delete keys:

```sh
VAULT_ID=$(az keyvault show --name "$VAULT" --query id --output tsv)

az role assignment create --role "Key Vault Crypto Officer" \
  --assignee "$(az ad signed-in-user show --query id --output tsv)" \
  --scope "$VAULT_ID"
```

`az ad signed-in-user` works when you signed in as a user. A role assignment can take a few minutes to take effect; if the next command fails with `Forbidden`, wait and run it again.

Create a secp256k1 signing key, which Key Vault calls an `EC` key on the `P-256K` curve, and print its id:

```sh
az keyvault key create --vault-name "$VAULT" --name hardhat-kms-tutorial \
  --kty EC --curve P-256K --ops sign verify

KEY_ID=$(az keyvault key show --vault-name "$VAULT" --name hardhat-kms-tutorial --query key.kid --output tsv)
echo "$KEY_ID"
```

`KEY_ID` is the versioned id of the key, `https://<vault name>.vault.azure.net/keys/hardhat-kms-tutorial/` and 32 hex digits. Keep this shell open: step 3 and step 8 use `VAULT` and `KEY_ID`.

## 3. Allow the key to sign, and nothing else

Hardhat signs with the identity you signed in with. For this tutorial, that identity is you, and the Key Vault Crypto Officer role from step 2 covers it. A real deployer should not be able to create or delete keys. Give it the **Key Vault Crypto User** role on this one key instead, not on the vault, so it can use no other key.

Print what the role allows:

```sh
az role definition list --name "Key Vault Crypto User" --query '[0].permissions[0].dataActions' --output tsv
```

It prints nine data actions on keys: `read`, which the plugin needs to get the public key, `sign`, which it needs to sign, and `update`, `backup`, `encrypt`, `decrypt`, `wrap`, `unwrap` and `verify`, which it does not use. It allows no delete or purge. For a role with only `read` and `sign`, create the custom role in [Allow get and sign, and nothing else](../guides/azure-key-vault-setup.md#vaults-that-use-azure-rbac) and assign it the same way.

To give a deployer identity the role on the key, assign it with the key's scope. The assignee is the object id of a user, group, service principal or managed identity:

```sh
KEY_SCOPE="$VAULT_ID/keys/hardhat-kms-tutorial"

az role assignment create --role "Key Vault Crypto User" \
  --assignee <deployer object id> \
  --scope "$KEY_SCOPE"
```

To check the assignments without changing anything, list them. The list includes the roles inherited from the vault, the resource group and the subscription:

```sh
az role assignment list --scope "$KEY_SCOPE" --include-inherited \
  --query '[].[roleDefinitionName,principalName]' --output tsv
```

## 4. Add the plugin and the key to the project

Install the core plugin and the Azure provider:

```sh
npm install --save-dev hardhat-kms hardhat-kms-azure
```

Until the packages are published on npm, this command fails with `E404`. Build them from a clone of the [repository](https://github.com/aelmanaa/hardhat-kms) instead: run `pnpm install`, then `pnpm run build`, then `pnpm pack` in `packages/hardhat-kms` and in `packages/hardhat-kms-azure`. Install the two `.tgz` files it writes with `npm install --save-dev <path to hardhat-kms tgz> <path to hardhat-kms-azure tgz>`.

Replace `hardhat.config.ts` with the file below, with the id that `echo "$KEY_ID"` printed in place of the `keyId` value. Compared with the template, it adds `hardhatKmsAzure` to `plugins`, adds a `kms` section with the key, gives the `sepolia` network `kmsAccounts` instead of `accounts`, so no private key is in the project, and turns Etherscan verification off:

```ts
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAzure from "hardhat-kms-azure";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, hardhatKmsAzure],
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
        provider: "azure",
        keyId: "https://<vault name>.vault.azure.net/keys/hardhat-kms-tutorial/<version>",
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

Set the RPC URL, then ask Key Vault for the key's address:

```sh
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
npx hardhat kms address deployer
```

It prints the key's address, `0x` and 40 hex digits. Pin it: add an `address` line to the `deployer` key, with the address you got in place of `<deployer address>`:

```ts
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAzure from "hardhat-kms-azure";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, hardhatKmsAzure],
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
        provider: "azure",
        keyId: "https://<vault name>.vault.azure.net/keys/hardhat-kms-tutorial/<version>",
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

The versioned id keeps the project on this version of the key if someone rotates it, and with the pin the plugin refuses to sign if the id ever names another key. [Rotate a key and pin its address](../guides/key-rotation.md#what-a-pin-does) explains why.

## 5. Fund the address

Send about 0.01 Sepolia ETH to the deployer address, from a Sepolia faucet or from another account. Deploying the `Counter` contract and calling it costs much less than that on Sepolia.

The address belongs to the Key Vault key alone. If the key is purged, any funds and contract roles at the address are lost for good, so step 8 sends the funds back before it removes the key.

To see the balance, open the address on [Sepolia Etherscan](https://sepolia.etherscan.io) or [Sepolia Blockscout](https://eth-sepolia.blockscout.com).

## 6. Deploy and verify

Deploy the module from the deployer address, and verify the contract, in one command:

```sh
npx hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --verify --default-sender <deployer address>
```

Ignition asks you to confirm the network; answer `y`. Each transaction costs one Key Vault `sign` operation. Naming the sender by its address keeps the deployer the same when you add accounts or keys to the network later; [Choose the sender by address](../guides/multiple-keys.md#choose-the-sender-by-address) explains why.

Ignition deploys `Counter`, calls `incBy(5)`, then verifies the contract on Blockscout and Sourcify. The end of the output looks like this:

```text
[ CounterModule ] successfully deployed 🚀

Deployed Addresses

CounterModule#Counter - 0xd25929560B4189a13092Fc8A685C63a68EFEf6fF

Verifying deployed contracts

Verifying contract "contracts/Counter.sol:Counter" for network sepolia...

=== Blockscout ===

The contract at 0xd25929560B4189a13092Fc8A685C63a68EFEf6fF has already been verified on Blockscout.

If you need to verify a partially verified contract, please use the --force flag.

Explorer: https://eth-sepolia.blockscout.com/address/0xd25929560B4189a13092Fc8A685C63a68EFEf6fF#code

=== Sourcify ===

The contract at 0xd25929560B4189a13092Fc8A685C63a68EFEf6fF has already been verified on Sourcify.

If you need to verify a partially verified contract, please use the --force flag.

Explorer: https://sourcify.dev/server/repo-ui/11155111/0xd25929560B4189a13092Fc8A685C63a68EFEf6fF
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

The `From` field of each transaction is your deployer address. The signature came from Azure Key Vault; Hardhat never held a private key.

## 8. Clean up

When you are done, send the remaining Sepolia ETH back, then disable the key, delete it, and delete the vault.

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

A tiny amount stays behind, 0.0000015 ETH in the recorded run, because the script reserves the fee at the highest price the transaction may pay. Run again, the script stops with `the balance of <deployer address>, … ETH, does not cover the fee` and sends nothing.

Then remove the key. If you closed the shell since step 2, set `VAULT`, `VAULT_ID` and `KEY_ID` again first, with the vault name that step 2 printed:

```sh
VAULT=<vault name>
VAULT_ID=$(az keyvault show --name "$VAULT" --query id --output tsv)
KEY_ID=$(az keyvault key show --vault-name "$VAULT" --name hardhat-kms-tutorial --query key.kid --output tsv)
```

Disable the key version your config uses. A disabled version cannot sign, and `--enabled true` brings it back:

```sh
az keyvault key set-attributes --id "$KEY_ID" --enabled false
```

To keep the key instead, run only the disable step, and stop here. A disabled key costs nothing, because nothing can use it.

If you gave a deployer the Key Vault Crypto User role in step 3, remove that assignment:

```sh
az role assignment delete --role "Key Vault Crypto User" --assignee <deployer object id> \
  --scope "$VAULT_ID/keys/hardhat-kms-tutorial"
```

Delete the key:

```sh
az keyvault key delete --vault-name "$VAULT" --name hardhat-kms-tutorial
```

The vault has soft delete, which is on for every new vault. The deleted key cannot sign, and costs nothing, since nothing can use it. It stays recoverable for the vault's retention period, 90 days unless you chose another period, from 7 to 90 days, when you created the vault. Until then, `az keyvault key recover --vault-name "$VAULT" --name hardhat-kms-tutorial` brings it back as it was, with the same address; [Prevent and recover from losing a key](../guides/key-loss.md#azure-key-vault) covers it.

To remove the key for good now, purge it. The deleted key can take a few seconds to appear in `az keyvault key list-deleted`; if the purge says the key is not found, wait and run it again:

```sh
az keyvault key purge --vault-name "$VAULT" --name hardhat-kms-tutorial
```

After the purge, the key is gone for good, and nothing can sign for the address again. A vault with purge protection refuses the purge; Key Vault then purges the key when the retention period ends. Purge protection can never be turned off once it is on, so leave it off for a test vault like this one.

Last, delete the resource group, which deletes the vault and its role assignments, then purge the vault so its name is free again:

```sh
az group delete --name hardhat-kms-tutorial --yes
az keyvault purge --name "$VAULT"
```

A deleted vault, like a deleted key, stays recoverable until you purge it or its retention period ends. Recovering it does not bring back its role assignments.

## Next steps

- [Deploy with Hardhat Ignition](../guides/deploy-with-ignition.md): choose the deployer and rehearse on a simulated network.
- [Set up an Azure Key Vault key](../guides/azure-key-vault-setup.md): access policies, Managed HSM, the credential order, and the errors you can meet.
- [Prevent and recover from losing a key](../guides/key-loss.md) before the key holds anything of value.
