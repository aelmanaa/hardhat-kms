# Use several keys across networks

Audience: users who sign with more than one KMS key, on more than one network, or next to local or Ledger accounts. Assumes a key set up as in one of the setup guides ([AWS](aws-kms-setup.md), [Google Cloud](gcp-kms-setup.md), [Azure](azure-key-vault-setup.md)).

Status: everything this guide describes is implemented. The `kms accounts` output below comes from a run on 2026-10-02 with a Google Cloud KMS key and an Azure Key Vault key ([#69](https://github.com/aelmanaa/hardhat-kms/issues/69)).

This guide covers:

- [Name each key once](#name-each-key-once) and use it on several networks.
- [Mix providers](#mix-providers) in one project.
- [Pick the sender](#pick-the-sender) when a network has several accounts.
- [Add local or Ledger accounts](#add-local-or-ledger-accounts) to a network with KMS keys.
- [Add keys from the command line](#add-keys-from-the-command-line) with `--kms`.
- [List each key once per network](#list-each-key-once-per-network).
- [Check the setup](#check-the-setup) with `kms accounts`.

## Name each key once

Declare each key once under `kms.keys`, and list it by name in the `kmsAccounts` of every network that uses it:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAzure from "hardhat-kms-azure";
import hardhatKmsGcp from "hardhat-kms-gcp";

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

Pin each key's `address` once you know it, in `kms.keys`, and every network that names the key gets the pin. [Check the setup](#check-the-setup) prints the lines to paste. The [configuration reference](../reference/configuration.md) lists every field and key form.

## Mix providers

Each provider's keys need its provider package in `plugins`: `hardhat-kms-aws`, `hardhat-kms-gcp` or `hardhat-kms-azure`. The config above lists two, and each loads `hardhat-kms` itself. A key whose provider package is missing fails when it is first used, and the error names the package to install ([Provider packages](../reference/configuration.md#provider-packages)).

Each provider takes its credentials from its own SDK's default chain, so a project that mixes providers needs a sign-in for each one, such as `gcloud auth application-default login` and `az login` ([Credentials](../reference/configuration.md#credentials)).

## Pick the sender

On a network with several accounts, `eth_accounts` lists the network's own accounts first, then the KMS addresses in `kmsAccounts` order, then the `--kms` keys. On `sepolia` above, whose node manages no accounts, the list is `treasury`, then `ops`. On an `edr-simulated` network, EDR's 20 default accounts come first.

A transaction without `from` goes from the network's `from` when the config sets one, otherwise from the first address of `eth_accounts` ([RPC methods](../reference/rpc-methods.md#rpc-behaviour)). On `sepolia` above, that is `treasury`.

To send from another key, choose it by address rather than by position, so that adding a key or an account does not change the sender. With hardhat-viem:

```ts
// Loads the types of `connection.viem`. hardhat.config.ts already does this in a project.
import "@nomicfoundation/hardhat-viem";
import { network } from "hardhat";

const { viem } = await network.create("sepolia");
// The ops key's address, from `npx hardhat kms address ops`.
const ops = await viem.getWalletClient("0x9626Fb8498C69d88F8C080835C3Cd328453D3004");
await ops.sendTransaction({ to: "0x728743B36DE6236f6d03409563a7E2c39a00EE17", value: 1n });
```

With hardhat-ethers, `await ethers.getSigner("0x9626Fb8498C69d88F8C080835C3Cd328453D3004")` returns the signer for that address. `viem.getWalletClients()` and `ethers.getSigners()` return the accounts in `eth_accounts` order. For Ignition, pass the address as `--default-sender` ([Deploy with Hardhat Ignition](deploy-with-ignition.md)).

## Add local or Ledger accounts

A network can have `accounts` and `kmsAccounts` together. Its local accounts then come first in `eth_accounts`, so the first local account is the default sender. Set the network's `from` to a KMS address to make that key the default:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsGcp from "hardhat-kms-gcp";

export default defineConfig({
  plugins: [hardhatKmsGcp],
  kms: {
    keys: { treasury: { provider: "gcp", keyVersionName: configVariable("TREASURY_KEY_VERSION") } },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("TEST_PRIVATE_KEY")],
      kmsAccounts: ["treasury"],
      // The treasury key's address: transactions without `from` go from it.
      from: "0x728743B36DE6236f6d03409563a7E2c39a00EE17",
    },
  },
});
```

The plugin signs only for KMS addresses. Requests from a local account go on to Hardhat, which signs them as usual.

hardhat-kms also works next to `@nomicfoundation/hardhat-ledger`. List hardhat-ledger first in `plugins`, before the provider packages. In that order, `eth_accounts` lists the network's own accounts, then the Ledger addresses, then the KMS addresses, and a transaction without `from` gets its default sender. In the other order, hardhat-ledger rejects every transaction without `from` on a network with `ledgerAccounts` ([Other signing plugins](../reference/configuration.md#other-signing-plugins)).

## Add keys from the command line

`--kms` reads keys from Foundry's environment variables, without a config entry ([Migrate from Foundry](migrate-from-foundry.md#from-the-command-line-as-in-foundry)). These keys join the selected network only: the `--network` value, or `default` when there is none. They come after the network's own accounts and its `kmsAccounts`, so a `--kms` key is the default sender only on a network with no other accounts, or when the network's `from` is its address. Other networks do not get them.

```sh
AZURE_KEY_VAULT_KEY_ID=https://<vault>.vault.azure.net/keys/<name>/<version> \
  npx hardhat run scripts/deploy.ts --network baseSepolia --kms azure
```

Always pass `--network` with `--kms`. Without it, the keys join the `default` network, and the plugin prints a warning when something connects to it.

## List each key once per network

A network signs with each KMS key through one entry only. The plugin refuses a second entry for the same key, and its errors name the entries, never the key ids:

| What the network lists                                | What happens                                                                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The same name twice, as in `["ops", "ops"]`           | The config fails to load: `Key "ops" is listed twice`.                                                                                                                                             |
| A named key and an inline copy of it                  | Using the network fails at its first request for the accounts: `<network>.kmsAccounts[1] and ops are the same account (0x…); list each key once`.                                                  |
| A config key and a `--kms` key that holds the same id | Using the network fails: `AZURE_KEY_VAULT_KEY_ID is already networks.<network>.kmsAccounts[1] ("ops"); use one of them`. When `ops` has an `address` pin, the error is the same-account one above. |

Two entries for one key are the same account, so keep the one you want and remove the other. Listing a key on several networks is fine; that is what named keys are for.

## Check the setup

`kms accounts` asks each KMS for each key's address, checks it against the key's pin, and prints the pins to add ([`kms accounts`](../reference/tasks.md#kms-accounts)). It signs nothing and sends nothing. With `--network`, it lists that network's keys in the order the network uses them:

```sh
npx hardhat --network baseSepolia kms accounts
```

```text
NAME      PROVIDER  SOURCE    ADDRESS                                     PIN   KEY ID
treasury  gcp       kms.keys  0x728743B36DE6236f6d03409563a7E2c39a00EE17  none  gcp:<TREASURY_KEY_VERSION>

Address pins to add to each key's config:
  kms.keys.treasury: address: "0x728743B36DE6236f6d03409563a7E2c39a00EE17",
```

Without `--network`, it lists every key in the project, each KMS key once. A key that is named in several places, here `ops` in `kms.keys` and the same key from `--kms azure`, gets one row, with its other names on an `also:` line:

```sh
npx hardhat --kms azure kms accounts
```

```text
NAME      PROVIDER  SOURCE    ADDRESS                                     PIN   KEY ID
treasury  gcp       kms.keys  0x728743B36DE6236f6d03409563a7E2c39a00EE17  none  gcp:<TREASURY_KEY_VERSION>
ops       azure     kms.keys  0x9626Fb8498C69d88F8C080835C3Cd328453D3004  none  azure:<OPS_KEY_ID>
  also: AZURE_KEY_VAULT_KEY_ID

Address pins to add to each key's config:
  kms.keys.treasury: address: "0x728743B36DE6236f6d03409563a7E2c39a00EE17",
  kms.keys.ops: address: "0x9626Fb8498C69d88F8C080835C3Cd328453D3004",
```

With `--network sepolia --kms azure`, the same two entries are both listed, and a note on standard error says that a connection to `sepolia` refuses them:

```text
[hardhat-kms] AZURE_KEY_VAULT_KEY_ID names the same KMS key as ops; connections to sepolia refuse two entries for one key, so use one of them.
```

Run `kms accounts` for each network before you deploy, and again after you change a key. A key you cannot reach shows `FAILED`, and the command exits with code 1.
