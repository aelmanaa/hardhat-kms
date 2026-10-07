---
title: First deploy on Sepolia with Azure Key Vault
description: "Sign Hardhat transactions with Azure Key Vault: create a P-256K key, deploy a contract to Sepolia from it, verify the source and purge the key."
---

# First deploy on Sepolia with Azure Key Vault

Audience: developers who have an Azure subscription and the Azure CLI signed in, and have not used Azure Key Vault with Hardhat.

This tutorial was followed from an empty directory on 2026-10-02, at commit [`0afbad3`](https://github.com/aelmanaa/hardhat-kms/commit/0afbad3), with Hardhat 3.18.1 and `@nomicfoundation/hardhat-verify` 3.1.2. The commands took about 4 minutes, without the wait for Sepolia ETH. The run used an existing Standard vault with RBAC, so it did not run the commands that create or delete the resource group, the vault or a role assignment. The plugin is not on npm yet; step 4 says how to install it until then.

In this tutorial you create a Hardhat project, create a signing key in Azure Key Vault, deploy a contract to Sepolia from that key and verify its source on block explorers. The private key never leaves Key Vault: Hardhat asks Key Vault for a signature each time it sends a transaction.

It takes about 15 minutes, plus the time it takes to get Sepolia ETH.

You need:

- Node.js 22.13.0 or later (see [supported Node.js versions](../reference/support.md)), and npm.
- The Azure CLI, signed in with `az login`, with a subscription where you can create a resource group and a key vault and assign roles, such as one where you have the Owner role. The plugin finds the same sign-in as the CLI. It tries environment variables first, but only a complete set: `AZURE_TENANT_ID` and `AZURE_CLIENT_ID` with `AZURE_CLIENT_SECRET`, `AZURE_CLIENT_CERTIFICATE_PATH` or `AZURE_FEDERATED_TOKEN_FILE`. `AZURE_CLIENT_ID` alone only chooses a user-assigned managed identity, which the plugin tries after the CLI. See [Sign in](../guides/azure-key-vault-setup.md#3-sign-in).
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

## 2. Create a vault and a key

A Standard vault has no monthly fee, and an `EC` key in it has none either. Each `get` or `sign` operation on the key costs $0.15 per 10,000, the price of "advanced key operations" in East US on 2026-10-02; prices vary by region. A deleted key cannot be used, so it costs nothing. See [Azure Key Vault pricing](https://azure.microsoft.com/pricing/details/key-vault/). Step 8 removes the key and the vault.

This tutorial uses an `EC` key in a Standard vault, the cheapest kind that can sign for Ethereum. Key Vault keeps its private key in software. For production, consider an `EC-HSM` key in a Premium vault, which keeps the private key in a hardware security module and costs $5 a month per key version, less above 250 keys ([About keys](https://learn.microsoft.com/azure/key-vault/keys/about-keys)).

Choose a region and a vault name. The name must be unique across Azure, 3 to 24 letters, digits and hyphens, starting with a letter. `az account list-locations --query '[].name' --output tsv` lists the regions:

```sh
LOCATION=<region>
VAULT="kms-tutorial-$(openssl rand -hex 4)"
echo "$VAULT"
```

In a subscription that has never used Key Vault, register its resource provider first. Registering again does no harm:

```sh
az provider register --namespace Microsoft.KeyVault --wait
```

Create a resource group and a Standard vault in it:

```sh
az group create --name hardhat-kms-tutorial --location "$LOCATION"
az keyvault create --name "$VAULT" --resource-group hardhat-kms-tutorial --location "$LOCATION" \
  --sku standard --enable-rbac-authorization true --retention-days 7
```

`--enable-rbac-authorization true` makes the vault use Azure role-based access control (RBAC). Recent Azure CLIs do so by default. Older ones create a vault with access policies, where the role assignments below have no effect; Microsoft calls access policies "a legacy authorization system" ([Azure RBAC vs. access policies](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-access-policy)). To check, `az keyvault show --name "$VAULT" --query properties.enableRbacAuthorization` prints `true`. `--retention-days 7` keeps a deleted key or vault recoverable for 7 days instead of the default 90, the shortest period Key Vault allows; it is enough for a throwaway vault.

Some regions refuse new vaults for some subscriptions. If `az keyvault create` fails for the region, run it again with another `--location`; the resource group can stay where it is.

If `az keyvault create` fails because an Azure Policy requires purge protection, add `--enable-purge-protection true`. Keep `--retention-days 7`: with purge protection, step 8's purges are refused, and the key and the vault stay recoverable until the retention period ends. Purge protection can never be turned off.

Creating an RBAC vault gives you no access to its keys, even as the subscription's Owner. Give yourself the **Key Vault Crypto Officer** role on the vault, which can create and delete keys:

```sh
VAULT_ID=$(az keyvault show --name "$VAULT" --query id --output tsv)

az role assignment create --role "Key Vault Crypto Officer" \
  --assignee-object-id "$(az ad signed-in-user show --query id --output tsv)" \
  --assignee-principal-type User \
  --scope "$VAULT_ID"
```

`az ad signed-in-user` works when you signed in as a user. Passing the object id and the principal type saves a directory lookup, which a guest user may not be allowed to make. A role assignment can take a few minutes to take effect; if the next command fails with `Forbidden`, wait and run it again.

Create a secp256k1 signing key, which Key Vault calls an `EC` key on the `P-256K` curve, and print its id:

```sh
az keyvault key create --vault-name "$VAULT" --name hardhat-kms-tutorial \
  --kty EC --curve P-256K --ops sign verify

KEY_ID=$(az keyvault key show --vault-name "$VAULT" --name hardhat-kms-tutorial --query key.kid --output tsv)
echo "$KEY_ID"
```

`KEY_ID` is the versioned id of the key, `https://<vault name>.vault.azure.net/keys/hardhat-kms-tutorial/` and 32 hex digits. Keep this shell open: the next steps use `VAULT`, `VAULT_ID` and `KEY_ID`.

## 3. Allow the key to sign, and nothing else

Hardhat signs with the identity you signed in with. For this tutorial, that identity is you, and the Key Vault Crypto Officer role from step 2 covers it. A real deployer should not be able to create or delete keys. This step gives it the built-in **Key Vault Crypto User** role on this one key, not on the vault, so it can use no other key. For a deployer that holds real funds, use the custom role described below the command instead.

Print what the role allows:

```sh
az role definition list --name "Key Vault Crypto User" --query '[0].permissions[0].dataActions' --output tsv
```

It prints nine data actions on keys: `read`, which the plugin needs to get the public key, `sign`, which it needs to sign, and `update`, `backup`, `encrypt`, `decrypt`, `wrap`, `unwrap` and `verify`, which it does not use. It allows no delete or purge.

To give a deployer identity the role on the key, assign it with the key's scope, or give each deployer its own vault and assign the role on that vault. The assignee is the object id of a user, group, service principal or managed identity; its principal type is `User`, `Group` or `ServicePrincipal`, which covers managed identities:

```sh
KEY_SCOPE="$VAULT_ID/keys/hardhat-kms-tutorial"

az role assignment create --role "Key Vault Crypto User" \
  --assignee-object-id <deployer object id> \
  --assignee-principal-type <principal type> \
  --scope "$KEY_SCOPE"
```

Two caveats for this role. Signing with only Key Vault Crypto User is not checked live yet. And it can do more than sign: `update` can disable the key or change its permitted operations, and `backup` writes a copy of the key. Whoever can restore that copy into a vault can sign as the key's address ([Back up a key](../guides/key-loss.md#back-up-a-key)). To grant only `read` and `sign`, create the [custom role](../guides/azure-key-vault-setup.md#vaults-that-use-azure-rbac) and pass its name to `--role` instead.

To check the assignments without changing anything, list them. The list includes the roles inherited from the vault, the resource group and the subscription:

```sh
az role assignment list --scope "$KEY_SCOPE" --include-inherited \
  --query '[].[roleDefinitionName,principalName]' --output tsv
```

## 4. Add the plugin and the key to the project

Install the core plugin and the Azure provider:

```sh
npm install --save-dev hardhat-kms @hardhat-kms/azure
```

Until the packages are published on npm, this command fails with `E404`: follow [Install before the first npm release](../guides/install-before-release.md) to build the two packages from the repository and install them with npm or pnpm, then continue at the `hardhat.config.ts` step below.

In a pnpm project, install with `pnpm add -D hardhat-kms @hardhat-kms/azure`. pnpm 12 runs no install scripts of dependencies until the project decides on each. If it stops with `ERR_PNPM_IGNORED_BUILDS` for `esbuild`, which Hardhat depends on, the script is not needed: it only checks esbuild's platform binary. Add this to `pnpm-workspace.yaml`, next to `package.json`, and install again:

```yaml
allowBuilds:
  esbuild: false
```

Replace `hardhat.config.ts` with the file below. Compared with the template, it adds `hardhatKmsAzure` to `plugins`, adds a `kms` section with the key, gives the `sepolia` network `kmsAccounts` instead of `accounts`, so no private key is in the project, and turns Etherscan verification off. The key id comes from the variable `AZURE_KEY_ID`, so the vault name stays out of the file:

```ts
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAzure from "@hardhat-kms/azure";

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
        keyId: configVariable("AZURE_KEY_ID"),
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

Every command that uses the key needs `AZURE_KEY_ID`. Set it from step 2's `KEY_ID`:

```sh
export AZURE_KEY_ID="$KEY_ID"
```

In a new shell, set `VAULT`, `KEY_ID` and `AZURE_KEY_ID` again first, with the vault name that step 2 printed:

```sh
VAULT=<vault name>
KEY_ID=$(az keyvault key show --vault-name "$VAULT" --name hardhat-kms-tutorial --query key.kid --output tsv)
export AZURE_KEY_ID="$KEY_ID"
```

`az keyvault key show` returns the latest version of the key, which is the one you created unless someone rotated the key; once the address is pinned below, the plugin refuses any other version.

Set the RPC URL, then ask Key Vault for the key's address:

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
        provider: "azure",
        keyId: configVariable("AZURE_KEY_ID"),
        address: "<deployer address>",
      },
    },
  },
```

The versioned id keeps the project on this version of the key if someone rotates it, and with the pin the plugin refuses to sign if the id ever names another key. [Rotate a key and pin its address](../guides/key-rotation.md#what-a-pin-does) explains why.

Before you send funds to the address, check that your credentials may sign with the key:

```sh
npx hardhat kms accounts --check-sign
```

It prints a table with one row for the key, with your address in place of `<deployer address>`:

```text
NAME      PROVIDER  SOURCE    ADDRESS                                     PIN      SIGN  KEY ID
deployer  azure     kms.keys  <deployer address>                          matches  ok    azure:<AZURE_KEY_ID>
```

`matches` under `PIN` and `ok` under `SIGN` prove that your credentials may sign with the key and that its signatures recover to the pinned address. The check signs a random message, not a transaction, so it needs no funds. On `FAILED`, read the `error:` line under the row and fix the cause before step 5.

## 5. Fund the address

Send about 0.01 Sepolia ETH to the deployer address, from a Sepolia faucet or from another account. Deploying the `Counter` contract and calling it costs much less than that on Sepolia.

The address belongs to the Key Vault key alone. If the key is purged, any funds and contract roles at the address are lost for good, so step 8 sends the funds back before it removes the key.

To see the balance, open the address on [Sepolia Etherscan](https://sepolia.etherscan.io) or [Sepolia Blockscout](https://eth-sepolia.blockscout.com).

To try the deployment on a local fork of Sepolia before you fund the address, see [Rehearse on a simulated network](../guides/deploy-with-ignition.md#3-rehearse-on-a-simulated-network). The rehearsal signs with the real key, so it also checks the key and its permissions.

## 6. Deploy and verify

Deploy the module from the deployer address, and verify the contract, in one command:

```sh
npx hardhat ignition deploy ignition/modules/Counter.ts --network sepolia --verify --default-sender "$DEPLOYER_ADDRESS"
```

Ignition asks you to confirm the network; answer `y`. Each transaction usually costs one Key Vault `sign` operation; retries can add more. Naming the sender by its address keeps the deployer the same when you add accounts or keys to the network later; [Choose the sender by address](../guides/multiple-keys.md#choose-the-sender-by-address) explains why.

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

Both explorers may answer "already verified": the template's `Counter` is a common contract, and they have seen its code before. Open the `Explorer:` link that Blockscout printed. If the page shows the contract as verified, you are done. If it shows a "verified twin" or a "similar match" instead, your contract is not verified yet: [Verify the source on block explorers](../guides/deploy-with-ignition.md#6-verify-the-source-on-block-explorers) has the command to run.

## 7. Open the contract on the explorer

Open the `Explorer:` links from the output, with your contract's address:

- Blockscout: `https://eth-sepolia.blockscout.com/address/<contract address>#code` shows the source, marked as verified, and the two transactions from your deployer address: the deployment and the `incBy` call.
- Sourcify: `https://sourcify.dev/server/repo-ui/11155111/<contract address>` shows the files and an exact match.
- Etherscan: `https://sepolia.etherscan.io/address/<contract address>#code`. This tutorial does not verify on Etherscan, so the contract has no verified source of its own there. Etherscan may show the source of another contract with the same bytecode, marked "Similar Match".

The `From` field of each transaction is your deployer address. The signature came from Azure Key Vault; Hardhat never held a private key.

## 8. Clean up

When you are done, send the remaining Sepolia ETH back, then disable the key, delete it, and delete the vault. In a new shell, set `SEPOLIA_RPC_URL` and `AZURE_KEY_ID` again first, as in step 4: the script loads the config, which reads them.

Send the balance back with the script in [Return the funds from a KMS address](../guides/return-funds.md): save it as `scripts/return-funds.ts`, then run it with `RETURN_TO` set to an address with no code, such as your own wallet's:

```sh
RETURN_TO=<return address> npx hardhat run scripts/return-funds.ts
```

It ends with `sent in <transaction hash>`. If it stops with a one-line message instead, [What the script refuses](../guides/return-funds.md#what-the-script-refuses) explains each one, and nothing was sent unless the line names a transaction.

Before you remove the key, open the deployer address on [Sepolia Etherscan](https://sepolia.etherscan.io) or [Sepolia Blockscout](https://eth-sepolia.blockscout.com) and check that its balance is close to zero. Once the key is gone, nothing can move what is left.

Then remove the key. If you closed the shell since step 4, set `VAULT`, `VAULT_ID`, `KEY_ID` and `AZURE_KEY_ID` again first, with the vault name that step 2 printed:

```sh
VAULT=<vault name>
VAULT_ID=$(az keyvault show --name "$VAULT" --query id --output tsv)
KEY_ID=$(az keyvault key show --vault-name "$VAULT" --name hardhat-kms-tutorial --query key.kid --output tsv)
export AZURE_KEY_ID="$KEY_ID"
```

Disable the key version your config uses, the one in `AZURE_KEY_ID`. A disabled version cannot sign, and `--enabled true` brings it back:

```sh
az keyvault key set-attributes --id "$AZURE_KEY_ID" --enabled false
```

To keep the key instead, run only the disable step, and stop here. A disabled key costs nothing, because nothing can use it.

If you gave a deployer the Key Vault Crypto User role in step 3, remove that assignment. If you assigned the custom role instead, pass its name to `--role`:

```sh
az role assignment delete --role "Key Vault Crypto User" --assignee-object-id <deployer object id> \
  --scope "$VAULT_ID/keys/hardhat-kms-tutorial"
```

Delete the key:

```sh
az keyvault key delete --vault-name "$VAULT" --name hardhat-kms-tutorial
```

The vault has soft delete, which is on for every new vault. The deleted key cannot sign, and costs nothing, since nothing can use it. It stays recoverable for the vault's retention period, 7 days with the command in step 2, 90 by default. Until then, `az keyvault key recover --vault-name "$VAULT" --name hardhat-kms-tutorial` brings it back as it was, with the same address; [Prevent and recover from losing a key](../guides/key-loss.md#azure-key-vault) covers it.

To remove the key for good now, purge it. The deleted key can take 10 seconds or more to appear in `az keyvault key list-deleted`. If the purge fails with `KeyNotFound`, or with a conflict that says the key is being deleted, wait and run it again:

```sh
az keyvault key purge --vault-name "$VAULT" --name hardhat-kms-tutorial
```

After the purge, the key is gone for good, and nothing can sign for the address again. A vault with purge protection refuses the purge; Key Vault then purges the key when the retention period ends. Purge protection can never be turned off once it is on, so leave it off for a test vault like this one unless a policy requires it.

Last, delete the resource group, which deletes the vault and its role assignments, then purge the vault so its name is free again:

```sh
az group delete --name hardhat-kms-tutorial --yes
az keyvault purge --name "$VAULT"
```

A deleted vault, like a deleted key, stays recoverable until you purge it or its retention period ends. Recovering it does not bring back its role assignments. With purge protection, `az keyvault purge` is refused too, and the vault's name stays taken until the retention period ends.

## Next steps

- [Deploy with Hardhat Ignition](../guides/deploy-with-ignition.md): choose the deployer, rehearse on a simulated network and verify the source on block explorers.
- [Set up an Azure Key Vault key](../guides/azure-key-vault-setup.md): access policies, Managed HSM, the credential order, and the errors you can meet.
- [Errors](../reference/errors.md#hardhat-kmsazure): every error message, with its cause and fix.
- [Prevent and recover from losing a key](../guides/key-loss.md) before the key holds anything of value.
