# Use several keys across networks

Audience: users who sign with more than one KMS key, on more than one network, or next to local or Ledger accounts. Assumes a key set up as in one of the setup guides ([AWS](aws-kms-setup.md), [Google Cloud](gcp-kms-setup.md), [Azure](azure-key-vault-setup.md)).

Status: everything this guide describes is implemented. The `kms accounts` output below has the shape of a run on 2026-10-02 with a Google Cloud KMS key and an Azure Key Vault key, with the addresses replaced by test addresses.

This guide covers:

- [Name each key once](#name-each-key-once) and use it on several networks.
- [Mix providers](#mix-providers) in one project.
- [Choose the sender by address](#choose-the-sender-by-address) on every live network.
- [Add local or Ledger accounts](#add-local-or-ledger-accounts) to a network with KMS keys.
- [Add keys from the command line](#add-keys-from-the-command-line) with `--kms`.
- [List each key once per network](#list-each-key-once-per-network).
- [Check the setup](#check-the-setup) with `kms accounts`.

## Name each key once

Declare each key once under `kms.keys`, and list it by name in the `kmsAccounts` of every network that uses it:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAzure from "@hardhat-kms/azure";
import hardhatKmsGcp from "@hardhat-kms/gcp";

export default defineConfig({
  plugins: [hardhatKmsGcp, hardhatKmsAzure],
  kms: {
    keys: {
      treasury: { provider: "gcp", keyVersionName: configVariable("TREASURY_KEY_VERSION") },
      ops: { provider: "azure", keyId: configVariable("OPS_KEY_ID") },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      kmsAccounts: ["treasury", "ops"],
    },
    baseSepolia: {
      type: "http",
      url: configVariable("BASE_SEPOLIA_RPC_URL"),
      kmsAccounts: ["treasury"],
    },
  },
});
```

`treasury` signs on both networks. The address comes from the key's public key alone, so one key has the same address on every EVM chain. Funds and contract roles on one chain do not carry over to another, but the address does.

Pin each key's `address` once you know it, in `kms.keys`, and every network that names the key gets the pin. [Check the setup](#check-the-setup) prints the lines to paste, and [What a pin does](key-rotation.md#what-a-pin-does) explains what the pin protects against. The [configuration reference](../reference/configuration.md) lists every field and key form.

## Mix providers

Each provider's keys need its provider package in `plugins`: `@hardhat-kms/aws`, `@hardhat-kms/gcp` or `@hardhat-kms/azure`. The config above lists two, and each loads `hardhat-kms` itself. A key whose provider package is missing fails when it is first used, and the error names the package to install ([Provider packages](../reference/configuration.md#provider-packages)).

Each provider takes its credentials from its own SDK's default chain, so a project that mixes providers needs a sign-in for each one, such as `gcloud auth application-default login` and `az login` ([Credentials](../reference/configuration.md#credentials)).

## Choose the sender by address

`eth_accounts` lists the network's own accounts first, then the KMS addresses in `kmsAccounts` order, then the `--kms` keys. On `sepolia` above, whose node manages no accounts, the list is `treasury`, then `ops`. On an `edr-simulated` network, EDR's 20 default accounts come first, unless the network sets `accounts`.

hardhat-viem, hardhat-ethers and Ignition send from the first address of that list unless you name another: viem's default wallet client and `deployContract`, ethers' `deployContract` and `getContractFactory`, and Ignition without `--default-sender` all take it. The network's `from` does not change their choice. It applies only to a raw `eth_sendTransaction` or `eth_signTransaction` request without `from` ([RPC methods](../reference/rpc-methods.md#rpc-behaviour)).

On a live network, name the sender by its address every time, and pin each key's address. A default chosen by position moves when the network changes:

- Adding a key to `kmsAccounts`, or `accounts` to the network, changes which address comes first.
- The same key has a different position on different networks. `treasury` is index 0 on `sepolia`, and index 20 on an `edr-simulated` rehearsal network with EDR's default accounts.
- With hardhat-ledger listed first in `plugins`, the first address on a node without accounts is the first Ledger address, not a KMS key.

With hardhat-viem, get the wallet client for the address:

```ts
// Loads the types of `connection.viem`. hardhat.config.ts already does this in a project.
import "@nomicfoundation/hardhat-viem";
import { network } from "hardhat";

const { viem } = await network.create("sepolia");
// The ops key's address, from `npx hardhat kms address ops`.
const ops = await viem.getWalletClient("0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB");
await ops.sendTransaction({ to: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826", value: 1n });
```

Pass the same wallet client to `viem.deployContract` as `{ client: { wallet: ops } }`. With hardhat-ethers, `await ethers.getSigner("0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB")` returns the signer for the address; pass it to `deployContract` or `getContractFactory`. With Ignition, pass the address as `--default-sender`, or as `defaultSender` from a script ([Deploy with Hardhat Ignition](deploy-with-ignition.md)).

## Add local or Ledger accounts

A network can have `accounts` and `kmsAccounts` together. Its local accounts then come first in `eth_accounts`, so the libraries' default sender is the first local account. Choose the KMS key by address, as above:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsGcp from "@hardhat-kms/gcp";

export default defineConfig({
  plugins: [hardhatKmsGcp],
  kms: {
    keys: {
      treasury: {
        provider: "gcp",
        keyVersionName: configVariable("TREASURY_KEY_VERSION"),
        address: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826",
      },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      // The local account is first in eth_accounts: scripts must name the treasury address.
      accounts: [configVariable("TEST_PRIVATE_KEY")],
      kmsAccounts: ["treasury"],
    },
  },
});
```

The plugin signs only for KMS addresses. Requests from a local account go on to Hardhat, which signs them as usual.

hardhat-kms also works next to `@nomicfoundation/hardhat-ledger`. List hardhat-ledger first in `plugins`, before the provider packages. In that order, `eth_accounts` lists the network's own accounts, then the Ledger addresses, then the KMS addresses. In the other order, hardhat-ledger rejects every raw transaction request without `from` on a network with `ledgerAccounts` ([Other signing plugins](../reference/configuration.md#other-signing-plugins)).

## Add keys from the command line

`--kms` reads keys from Foundry's environment variables, without a config entry ([Migrate from Foundry](migrate-from-foundry.md#from-the-command-line-as-in-foundry)). For Azure, these are the names proposed in [foundry-rs/foundry#17120](https://github.com/foundry-rs/foundry/pull/17120), since Foundry has not released an Azure signer. These keys join the selected network only: the `--network` value, or `default` when there is none. They come last in `eth_accounts`, after the network's own accounts and its `kmsAccounts`, so on a network with other accounts the libraries do not pick a `--kms` key by default. Name it by address. Other networks do not get these keys.

```sh
AZURE_KEY_VAULT_KEY_ID=https://<vault>.vault.azure.net/keys/<name>/<version> \
  npx hardhat run scripts/deploy.ts --network baseSepolia --kms azure
```

Always pass `--network` with `--kms`. Without it, the keys join the `default` network, and the plugin prints a warning when something connects to it.

## List each key once per network

A network signs with each KMS key through one entry only. The plugin refuses a second entry for the same key, and its errors name the entries, never the key ids:

| What the network lists                                | What happens                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The same name twice, as in `["ops", "ops"]`           | The config fails to load: `Key "ops" is listed twice`.                                                                                                                                                                                         |
| A named key and an inline copy of it                  | The network's first request that needs the KMS accounts fails: `<entry> and <entry> are the same account (<address>); list each key once`, with the later entry named first.                                                                   |
| A config key and a `--kms` key that holds the same id | The network's first request that needs the KMS accounts fails: `AZURE_KEY_VAULT_KEY_ID is already networks.<network>.kmsAccounts[<index>] ("ops"); use one of them`. When `ops` has an `address` pin, the error is the same-account one above. |

Two entries for one key are the same account, so keep the one you want and remove the other. Listing a key on several networks is fine; that is what named keys are for.

## Check the setup

`kms accounts` asks each KMS for each key's address, checks it against the key's pin, and prints the pins to add ([`kms accounts`](../reference/tasks.md#kms-accounts)). It signs nothing and sends nothing. With `--network`, it lists that network's keys in the order the network uses them:

```sh
npx hardhat --network baseSepolia kms accounts
```

```text
NAME      PROVIDER  SOURCE    ADDRESS                                     PIN   KEY ID
treasury  gcp       kms.keys  0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826  none  gcp:<TREASURY_KEY_VERSION>

Address pins to add to each key's config:
  kms.keys.treasury: address: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826",
```

Two rows with the same address in a `--network` listing mean that connections to that network will be refused, as in [List each key once per network](#list-each-key-once-per-network). The task adds a note on standard error only when a `--kms` key repeats one of the network's entries:

```text
[hardhat-kms] AZURE_KEY_VAULT_KEY_ID names the same KMS key as ops; connections to sepolia refuse two entries for one key, so use one of them.
```

Without `--network`, the task lists every key in the project. Entries for the same KMS key with the same pin share one row, with the other names on an `also:` line. Here `ops` in `kms.keys` and the same key from `--kms azure` share a row:

```sh
npx hardhat --kms azure kms accounts
```

```text
NAME      PROVIDER  SOURCE    ADDRESS                                     PIN   KEY ID
treasury  gcp       kms.keys  0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826  none  gcp:<TREASURY_KEY_VERSION>
ops       azure     kms.keys  0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB  none  azure:<OPS_KEY_ID>
  also: AZURE_KEY_VAULT_KEY_ID

Address pins to add to each key's config:
  kms.keys.treasury: address: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826",
  kms.keys.ops: address: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
```

Entries with different pins, or keys of a third-party provider, are never merged and get a row each ([`kms accounts`](../reference/tasks.md#kms-accounts)).

Run `kms accounts` for each network before you deploy, and again after you change a key. A key you cannot reach shows `FAILED`, and the command exits with code 1. To replace a key with a new one, follow [Move to a new key](key-rotation.md#move-to-a-new-key).
