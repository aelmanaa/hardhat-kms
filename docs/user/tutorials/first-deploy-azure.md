---
title: Deploy a Hardhat contract to Sepolia with Azure Key Vault
description: "Sign Hardhat transactions with Azure Key Vault: create a P-256K key, deploy a contract to Sepolia from it, verify the source and purge the key."
---

# Deploy a Hardhat contract to Sepolia with Azure Key Vault

In this tutorial you create a Hardhat project, create a signing key in Azure Key Vault, deploy a contract to Sepolia from that key and verify its source on block explorers. The private key never leaves Key Vault: Hardhat asks Key Vault for a signature each time it sends a transaction.

You need:

- Node.js 22.13.0 or later (see [supported Node.js versions](../reference/support.md)), and npm, pnpm or Yarn.
- A POSIX shell, such as bash or zsh; on Windows, use WSL. Step 2 also uses `openssl` to make random names.
- The Azure CLI, signed in with `az login`, with a subscription where you can create a resource group and a key vault and assign roles, such as one where you have the Owner role. The plugin finds the same sign-in as the CLI. It tries environment variables first, but only a complete set: `AZURE_TENANT_ID` and `AZURE_CLIENT_ID` with `AZURE_CLIENT_SECRET`, `AZURE_CLIENT_CERTIFICATE_PATH` or `AZURE_FEDERATED_TOKEN_FILE`. `AZURE_CLIENT_ID` alone only chooses a user-assigned managed identity, which the plugin tries after the CLI. See [Sign in](../guides/azure-key-vault-setup.md#3-sign-in).
- A sign-in that completed multifactor authentication. Steps 2 and 8, and the optional deployer role, create and delete Azure resources, which Azure allows a user only after MFA; [Sign in](../guides/azure-key-vault-setup.md#3-sign-in) says which commands that covers.
- A Sepolia RPC URL. The examples use the public `https://ethereum-sepolia-rpc.publicnode.com`; a provider URL with an API key works too.
- About 0.01 Sepolia ETH, from a faucet or another account.

> [!NOTE]
> Audience: developers who have an Azure subscription and the Azure CLI signed in, and have not used Azure Key Vault with Hardhat. It takes about 15 minutes, plus the time it takes to get Sepolia ETH.
>
> This tutorial was followed from an empty directory on 2026-10-02, at commit [`0afbad3`](https://github.com/aelmanaa/hardhat-kms/commit/0afbad3), with Hardhat 3.18.1 and `@nomicfoundation/hardhat-verify` 3.1.2. The commands took about 4 minutes, without the wait for Sepolia ETH. That run used an existing Standard vault with RBAC. On 2026-10-07, at commit [`f822377`](https://github.com/aelmanaa/hardhat-kms/commit/f822377), with Azure CLI 2.90.0, the Azure commands of steps 2 and 8 were run in a new resource group. They created the group, the vault, a Key Vault Crypto Officer assignment and the key, and refused to reuse the group once it existed. Clean-up purged the key, deleted the group, which removed the vault and the assignment, and purged the vault; `az group exists` then printed `false`. That run skipped the Hardhat steps, the optional role assignment for a deployer and the "Keep the resource group" route.

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

Install the core plugin, `hardhat-kms`, and the Azure provider, `@hardhat-kms/azure`, with the package manager you created the project with:

::: code-group

```sh [npm]
npm install --save-dev hardhat-kms @hardhat-kms/azure
```

```sh [pnpm]
pnpm add --save-dev hardhat-kms @hardhat-kms/azure
```

```sh [Yarn]
yarn add --dev hardhat-kms @hardhat-kms/azure
```

:::

If the install stops with `ERR_PNPM_IGNORED_BUILDS` from pnpm or `YN0016` from Yarn, [If the install stops](../guides/install-before-release.md#if-the-install-stops) gives the fix for each package manager.

Register the provider: in `hardhat.config.ts`, import it and add it to `plugins`. It loads `hardhat-kms` itself. The rest of the file stays as the template made it:

<!-- docs-check: skip -->

```ts
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAzure from "@hardhat-kms/azure";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, hardhatKmsAzure],
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

It lists the `kms` tasks, such as `kms accounts` and `kms address`. If it prints `Error HHE404: Task "kms" not found` instead, `hardhatKmsAzure` is missing from `plugins`. You have created nothing in Azure yet, so an install problem costs nothing to fix.

## 2. Create a vault and a key

A Standard vault has no monthly fee, and an `EC` key in it has none either. Each `get` or `sign` operation on the key costs $0.15 per 10,000, the price of "advanced key operations" in East US on 2026-10-02; prices vary by region. A deleted key cannot be used, so it costs nothing. See [Azure Key Vault pricing](https://azure.microsoft.com/pricing/details/key-vault/). Step 8 removes the key and the vault.

This tutorial uses an `EC` key in a Standard vault, the cheapest kind that can sign for Ethereum. Key Vault keeps its private key in software. For production, consider an `EC-HSM` key in a Premium vault, which keeps the private key in a hardware security module and costs $5 a month per key version, less above 250 keys ([About keys](https://learn.microsoft.com/azure/key-vault/keys/about-keys)).

Choose a region, a resource group name and a vault name. Both names end in a random suffix, so they are unlikely to match a group or vault you already have, and the block below checks that the group is new before it creates it. The vault name must be unique across Azure, 3 to 24 letters, digits and hyphens, starting with a letter. `az account list-locations --query '[].name' --output tsv` lists the regions:

```sh
LOCATION=<region>
RG="hardhat-kms-tutorial-$(openssl rand -hex 4)"
VAULT="kms-tutorial-$(openssl rand -hex 4)"
echo "$RG"
echo "$VAULT"
```

Write down both names: a new shell needs them again, and step 8 deletes the group by its name.

In a subscription that has never used Key Vault, register its resource provider first. Registering again does no harm:

```sh
az provider register --namespace Microsoft.KeyVault --wait
```

Create the resource group, but only if no group has that name yet. `az group create` does not fail for a group that exists: it updates that group and returns it, as if it had just created it ([Resource Groups - Create Or Update](https://learn.microsoft.com/rest/api/resources/resource-groups/create-or-update)). So check first:

```sh
if [ "$(az group exists --name "$RG")" = "false" ]; then
  az group create --name "$RG" --location "$LOCATION" --tags created-by=hardhat-kms-tutorial
elif [ "$(az group exists --name "$RG")" = "true" ]; then
  echo "Resource group $RG already exists. Do not use it: set RG to a new name and run this again." >&2
else
  echo "Could not check whether $RG exists. Check that the Azure CLI is signed in, then run this again." >&2
fi
```

Continue only if the command printed the new group, with `"provisioningState": "Succeeded"` and the `created-by` tag. If it printed that the group already exists, the group belongs to someone or something else: set `RG` again, with a new suffix, and rerun the block.

Create a Standard vault in the group:

```sh
az keyvault create --name "$VAULT" --resource-group "$RG" --location "$LOCATION" \
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
  --scope "${VAULT_ID:?is empty: check that az keyvault create succeeded}"
```

`${VAULT_ID:?…}` stops the command when `VAULT_ID` is empty. Without it, an empty `--scope` would make Azure assign the role on the whole subscription instead of on the vault. Later commands that take a scope or a name guard their variables the same way.

`az ad signed-in-user` works when you signed in as a user. Passing the object id and the principal type saves a directory lookup, which a guest user may not be allowed to make. A role assignment can take a few minutes to take effect; if the next command fails with `Forbidden`, wait and run it again.

Create a secp256k1 signing key, which Key Vault calls an `EC` key on the `P-256K` curve, and print its id:

```sh
az keyvault key create --vault-name "$VAULT" --name hardhat-kms-tutorial \
  --kty EC --curve P-256K --ops sign verify

KEY_ID=$(az keyvault key show --vault-name "$VAULT" --name hardhat-kms-tutorial --query key.kid --output tsv)
echo "$KEY_ID"
```

`KEY_ID` is the versioned id of the key, `https://<vault name>.vault.azure.net/keys/hardhat-kms-tutorial/` and 32 hex digits. Keep this shell open: the next steps use `RG`, `VAULT`, `VAULT_ID` and `KEY_ID`.

## 3. Choose the identity that signs

Hardhat signs with the identity you signed in with. For this tutorial, that identity is you, and the Key Vault Crypto Officer role from step 2 covers it, so this step runs no command. Step 4 checks that you may sign.

A real deployer should not be able to create or delete keys. The tutorial does not need one: [Optional: give a deployer a sign role](#optional-give-a-deployer-a-sign-role), just before step 8, gives a deployer identity a role on this one key, creates such an identity if you have none, and signs as it.

## 4. Add the key to the project

Replace `hardhat.config.ts` with the file below. Compared with the template, it keeps `hardhatKmsAzure` in `plugins` from step 1, adds a `kms` section with the key, gives the `sepolia` network `kmsAccounts` instead of `accounts`, so no private key is in the project, sets the network's `chainId` and turns Etherscan verification off. The key id comes from the variable `AZURE_KEY_ID`, so the vault name stays out of the file:

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
      chainId: 11155111,
      url: configVariable("SEPOLIA_RPC_URL"),
      kmsAccounts: ["deployer"],
    },
  },
});
```

Etherscan needs an API key, and without one its verification fails. To verify on Etherscan too, get a key from [Etherscan](https://etherscan.io/apis), store it with `npx hardhat keystore set ETHERSCAN_API_KEY` or `export ETHERSCAN_API_KEY=…`, and replace `enabled: false` with `apiKey: configVariable("ETHERSCAN_API_KEY")`.

`chainId: 11155111` is Sepolia's chain id. Before the plugin signs a transaction, it asks the node for its chain; if `SEPOLIA_RPC_URL` points at another chain, it stops with [`core.chain.mismatch`](../reference/errors.md#chains) and signs nothing.

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
        provider: "azure",
        keyId: configVariable("AZURE_KEY_ID"),
        address: "<deployer address>",
      },
    },
  },
```

The versioned id keeps the project on this version of the key if someone rotates it, and with the pin the plugin refuses to sign if the id ever names another key. [Rotate a key and pin its address](../guides/key-rotation.md#what-a-pin-does) explains why.

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
deployer  azure     kms.keys  <deployer address>                          matches  ok    azure:<AZURE_KEY_ID>
```

`matches` under `PIN` and `ok` under `SIGN` prove that your credentials may sign with the key and that its signatures recover to the pinned address. The check signs a random message, not a transaction, so it needs no funds. On `FAILED`, read the `error:` line under the row and fix the cause before step 5.

## 5. Fund the address

Send about 0.01 Sepolia ETH to the deployer address, from a Sepolia faucet or from another account. Deploying the `Counter` contract and calling it costs much less than that on Sepolia.

The address belongs to the Key Vault key alone. If the key is purged, any funds and contract roles at the address are lost for good, so step 8 sends the funds back before it removes the key.

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

Both explorers may answer "already verified": the template's `Counter` is a common contract, and they have seen its code before. Blockscout may instead submit the source and end with `✅ Contract verified successfully on Blockscout!`; the contract is then verified too. Open the `Explorer:` link that Blockscout printed. If the page shows the contract as verified, you are done. If it shows a "verified twin" or a "similar match" instead, your contract is not verified yet: [Verify the source on block explorers](../guides/deploy-with-ignition.md#6-verify-the-source-on-block-explorers) has the command to run.

## 7. Open the contract on the explorer

Open the `Explorer:` links from the output, with your contract's address:

- Blockscout: `https://eth-sepolia.blockscout.com/address/<contract address>#code` shows the source, marked as verified, and the two transactions from your deployer address: the deployment and the `incBy` call.
- Sourcify: `https://sourcify.dev/server/repo-ui/11155111/<contract address>` shows the files and "Exact Match" or "Match". "Match", formerly "partial match", means the bytecode matches except the metadata hash at its end, so the source can differ in comments, variable names or file paths; the contract is verified either way ([Exact Match vs Match](https://docs.sourcify.dev/docs/exact-match-vs-match/)).
- Etherscan: `https://sepolia.etherscan.io/address/<contract address>#code`. This tutorial does not verify on Etherscan, so the contract has no verified source of its own there. Etherscan may show the source of another contract with the same bytecode, marked "Similar Match".

The `From` field of each transaction is your deployer address. The signature came from Azure Key Vault; Hardhat never held a private key.

## Optional: give a deployer a sign role

This section sets up a production deployer, which the tutorial does not need. Run it before step 8, while the key exists, in the shell from step 4, which has `VAULT_ID` and `AZURE_KEY_ID`. Step 8 removes the assignment, and the deployer identity if this section created it.

It gives the deployer the built-in **Key Vault Crypto User** role on this one key, not on the vault, so it can use no other key. For a deployer that holds real funds, use the custom role described below the command instead.

Print what the role allows:

```sh
az role definition list --name "Key Vault Crypto User" --query '[0].permissions[0].dataActions' --output tsv
```

It prints nine data actions on keys: `read`, which the plugin needs to get the public key, `sign`, which it needs to sign, and `update`, `backup`, `encrypt`, `decrypt`, `wrap`, `unwrap` and `verify`, which it does not use. It allows no delete or purge.

The deployer needs an identity of its own. A managed identity exists only on Azure resources, such as a virtual machine, so a laptop cannot sign in as one. To try the role from a laptop, create an app registration with a service principal and a client secret that expires in one day. Skip this block if you have a deployer identity already. Creating an app registration needs permission in Microsoft Entra ID, which users have unless an administrator turned it off:

```sh
TENANT_ID=$(az account show --query tenantId --output tsv)
APP_ID=$(az ad app create --display-name hardhat-kms-tutorial-deployer --query appId --output tsv)
SP_OBJECT_ID=$(az ad sp create --id "${APP_ID:?is empty: check that az ad app create succeeded}" --query id --output tsv)

END=$(date -u -v+1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)
SP_SECRET=$(az ad app credential reset --id "$APP_ID" --display-name hardhat-kms-tutorial \
  --end-date "$END" --query password --output tsv)
```

The secret stays in `SP_SECRET` and is not printed. The CLI warns that its output holds credentials; that is expected. The `END` line uses macOS's `date` first and GNU's second.

To give a deployer identity the role on the key, assign it with the key's scope, or give each deployer its own vault and assign the role on that vault. The assignee is the object id of a user, group, service principal or managed identity; its principal type is `User`, `Group` or `ServicePrincipal`, which covers managed identities:

```sh
KEY_SCOPE="${VAULT_ID:?is empty: set it with the az keyvault show command above}/keys/hardhat-kms-tutorial"

az role assignment create --role "Key Vault Crypto User" \
  --assignee-object-id <deployer object id> \
  --assignee-principal-type <principal type> \
  --scope "$KEY_SCOPE"
```

For the service principal created above, the object id is in `SP_OBJECT_ID` and the principal type is `ServicePrincipal`:

```sh
az role assignment create --role "Key Vault Crypto User" \
  --assignee-object-id "${SP_OBJECT_ID:?is empty: set it with the az ad sp create command above}" \
  --assignee-principal-type ServicePrincipal \
  --scope "$KEY_SCOPE"
```

Two caveats for this role. Signing with only Key Vault Crypto User is not checked live yet. And it can do more than sign: `update` can disable the key or change its permitted operations, and `backup` writes a copy of the key. Whoever can restore that copy into a vault can sign as the key's address ([Back up a key](../guides/key-loss.md#back-up-a-key)). To grant only `read` and `sign`, create the [custom role](../guides/azure-key-vault-setup.md#vaults-that-use-azure-rbac) and pass its name to `--role` instead.

To check the assignments without changing anything, list them. The list includes the roles inherited from the vault, the resource group and the subscription:

```sh
az role assignment list --scope "$KEY_SCOPE" --include-inherited \
  --query '[].[roleDefinitionName,principalName]' --output tsv
```

To sign as the service principal, give the plugin its credentials. The plugin tries a complete set of `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` before the Azure CLI's sign-in, as the list at the top of this page says. The function below sets them for one command only, so your own commands keep running as you:

```sh
as_deployer() {
  env AZURE_TENANT_ID="$TENANT_ID" AZURE_CLIENT_ID="$APP_ID" AZURE_CLIENT_SECRET="$SP_SECRET" "$@"
}
```

Check that the service principal may sign with the key:

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

It prints the same row as in step 4, with `matches` under `PIN` and `ok` under `SIGN`, this time signed by a service principal whose only role is Key Vault Crypto User on this key. A role assignment can take up to 10 minutes to take effect ([Troubleshoot Azure RBAC](https://learn.microsoft.com/azure/role-based-access-control/troubleshooting#symptom---role-assignment-changes-are-not-being-detected)): if `SIGN` shows `FAILED` with `Forbidden` on the `error:` line, wait and run it again. To deploy as the service principal, put `as_deployer` before step 6's command.

## 8. Clean up

When you are done, send the remaining Sepolia ETH back, then disable the key, delete it, and delete the vault. In a new shell, set `SEPOLIA_RPC_URL` and `AZURE_KEY_ID` again first, as in step 4: the script loads the config, which reads them.

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

Then remove the key. If you closed the shell since step 4, set `RG`, `VAULT`, `VAULT_ID`, `KEY_ID` and `AZURE_KEY_ID` again first, with the group and vault names that step 2 printed:

```sh
RG=<resource group name>
VAULT=<vault name>
VAULT_ID=$(az keyvault show --name "$VAULT" --query id --output tsv)
KEY_ID=$(az keyvault key show --vault-name "$VAULT" --name hardhat-kms-tutorial --query key.kid --output tsv)
export AZURE_KEY_ID="$KEY_ID"
```

If you lost the names, list the groups this tutorial created, then the vault in the one you choose:

```sh
az group list --tag created-by=hardhat-kms-tutorial --query '[].name' --output tsv
az keyvault list --resource-group "${RG:?set RG to a group name from the list above}" --query '[].name' --output tsv
```

More than one group means earlier runs left groups behind; pick the one whose vault name you recognise, or whose vault holds the `hardhat-kms-tutorial` key.

Disable the key version your config uses, the one in `AZURE_KEY_ID`. A disabled version cannot sign, and `--enabled true` brings it back:

```sh
az keyvault key set-attributes --id "$AZURE_KEY_ID" --enabled false
```

To keep the key instead, run only the disable step, and stop here. A disabled key costs nothing, because nothing can use it.

If you gave a deployer the Key Vault Crypto User role in [Optional: give a deployer a sign role](#optional-give-a-deployer-a-sign-role), remove that assignment. If you assigned the custom role instead, pass its name to `--role`:

```sh
az role assignment delete --role "Key Vault Crypto User" --assignee-object-id <deployer object id> \
  --scope "${VAULT_ID:?is empty: set it with the az keyvault show command earlier in step 8}/keys/hardhat-kms-tutorial"
```

If the optional section created the `hardhat-kms-tutorial-deployer` app registration, run the commands below instead of the one above. They remove its assignment first, then delete the app registration, which deletes its service principal and its secret. In this order no assignment is left behind: an assignment whose principal is deleted stays on the key, listed as "Identity not found" ([Troubleshoot Azure RBAC](https://learn.microsoft.com/azure/role-based-access-control/troubleshooting#symptom---role-assignments-with-identity-not-found)). In a new shell, set `APP_ID` and `SP_OBJECT_ID` again first:

```sh
APP_ID=$(az ad app list --display-name hardhat-kms-tutorial-deployer --query '[0].appId' --output tsv)
SP_OBJECT_ID=$(az ad sp show --id "${APP_ID:?is empty: no app registration is named hardhat-kms-tutorial-deployer}" --query id --output tsv)
```

```sh
az role assignment delete --role "Key Vault Crypto User" \
  --assignee-object-id "${SP_OBJECT_ID:?is empty: set it with the az ad sp show command earlier in step 8}" \
  --scope "${VAULT_ID:?is empty: set it with the az keyvault show command earlier in step 8}/keys/hardhat-kms-tutorial"

az ad app delete --id "${APP_ID:?is empty: set it with the az ad app list command earlier in step 8}"
unset SP_SECRET
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

Last, remove the vault. If step 2 created the resource group, delete the group, which deletes the vault and its role assignments, as in [Delete the resource group](#delete-the-resource-group). If you put the vault in a group you already had, or used a vault you already had, follow [Keep the resource group](#keep-the-resource-group) instead.

### Delete the resource group

Check that the group is the one step 2 created, and list what is in it:

```sh
az group show --name "${RG:?set RG to the name step 2 printed}" --query tags
az resource list --resource-group "${RG:?set RG to the name step 2 printed}" --output table
```

The tags include `"created-by": "hardhat-kms-tutorial"`, and the list has one row: the vault, of type `Microsoft.KeyVault/vaults`. If the tag is missing or the list has any other row, the group holds resources this tutorial did not create: do not delete it, and follow [Keep the resource group](#keep-the-resource-group) instead.

The next command deletes the group and every resource in it, which is everything the list above showed, and the role assignments on them. Resource group deletion cannot be undone ([Delete resource groups](https://learn.microsoft.com/azure/azure-resource-manager/management/delete-resource-group)).

It asks `Are you sure you want to perform this operation?` without naming the group. The `echo` prints the name first: answer `y` only if it is the name step 2 printed.

```sh
echo "$RG"
az group delete --name "${RG:?set RG to the name step 2 printed}"
```

Then purge the vault so its name is free again:

```sh
az keyvault purge --name "${VAULT:?set VAULT to the name step 2 printed}"
```

A deleted vault, like a deleted key, stays recoverable until you purge it or its retention period ends. Recovering it does not bring back its role assignments. With purge protection, `az keyvault purge` is refused too, and the vault's name stays taken until the retention period ends.

To check, `az group exists --name "$RG"` prints `false`, and `az keyvault list-deleted --query "[?name=='$VAULT']"` prints `[]` once the purge has finished.

### Keep the resource group

If the group was not new, or holds anything other than the vault, leave the group and remove only what the tutorial added to it.

Remove the Key Vault Crypto Officer role that step 2 gave you on the vault. Skip this if you had that role on the vault itself before the tutorial: `az role assignment create` in step 2 then returned your existing assignment instead of making a new one, and this command would remove the access you had before. A role you hold on the group or the subscription is a separate assignment, which this command leaves alone. Deleting by the assignment's id would not help, because step 2 returned the id of that existing assignment too.

```sh
az role assignment delete --role "Key Vault Crypto Officer" \
  --assignee-object-id "$(az ad signed-in-user show --query id --output tsv)" \
  --scope "${VAULT_ID:?is empty: set it with the az keyvault show command earlier in step 8; an empty scope would remove the role on the whole subscription}"
```

If step 2 created the vault, delete it and purge it. The two commands affect only the vault named in `VAULT`; skip them for a vault you had before the tutorial, whose key you already deleted and purged above:

```sh
az keyvault delete --name "${VAULT:?set VAULT to the name step 2 printed}"
az keyvault purge --name "${VAULT:?set VAULT to the name step 2 printed}"
```

If the vault has purge protection, `az keyvault purge` is refused, and the vault's name stays taken until the retention period ends.

## Next steps

- [Deploy with Hardhat Ignition](../guides/deploy-with-ignition.md): choose the deployer, rehearse on a simulated network and verify the source on block explorers.
- [Set up an Azure Key Vault key](../guides/azure-key-vault-setup.md): access policies, Managed HSM, the credential order, and the errors you can meet.
- [Errors](../reference/errors.md#hardhat-kmsazure): every error message, with its cause and fix.
- [Prevent and recover from losing a key](../guides/key-loss.md) before the key holds anything of value.
