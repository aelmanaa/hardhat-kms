---
title: A KMS key or a Ledger
description: "hardhat-ledger or a KMS key in Hardhat 3: unattended signing in CI and scripts versus a prompt on a hardware wallet, and how to use both in one project."
---

# A KMS key or a Ledger

Audience: users who sign with a Ledger through `@nomicfoundation/hardhat-ledger`, or who are choosing between a Ledger and a cloud KMS key for a Hardhat 3 project. Assumes you know what a hardware wallet is; no cloud experience.

Both keep the private key out of your Hardhat process. A Ledger signs when a person approves the request on the device. A KMS key signs when the cloud's access control allows the caller, with no person in the loop. That one difference decides most of the choice.

The facts about hardhat-ledger below come from its npm page and its README in the published package, version 3.1.0, checked on 2026-10-07: [`@nomicfoundation/hardhat-ledger` on npm](https://www.npmjs.com/package/@nomicfoundation/hardhat-ledger), source in [`packages/hardhat-ledger`](https://github.com/NomicFoundation/hardhat/tree/main/packages/hardhat-ledger) of the Hardhat repository. Version 3.1.0 was published on 2026-09-17 and declares `hardhat` `^3.8.0` as a peer dependency. The Hardhat 2 line is on npm under the `hh2` tag, at 1.2.2.

## How they differ

| Topic                         | Ledger with hardhat-ledger 3.1.0                                                                                                                                                          | KMS key with hardhat-kms                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who approves a signature      | A person, on the device, for each request. The device must be connected with the Ethereum app open.                                                                                       | Nobody at signing time. The cloud's IAM or RBAC decides which identities may sign ([How the plugin reaches your cloud](cloud-access.md)).                      |
| CI and scripts that run alone | Need a person at a connected device.                                                                                                                                                      | Run unattended, with the CI job's or the server's identity ([CI with OIDC](cloud-access.md#ci-with-oidc)).                                                     |
| Where the key lives           | On the device.                                                                                                                                                                            | In the cloud's KMS or HSM. Nobody holds a copy; deleting the key loses its address for good ([Prevent and recover from losing a key](../guides/key-loss.md)).  |
| Config                        | `ledgerAccounts`, a list of addresses on a network. The plugin looks for each address on the device, by default on the derivation paths from `m/44'/60'/0'/0'/0` to `m/44'/60'/20'/0'/0`. | `kmsAccounts`, a list of key names on a network, each declared once under `kms.keys` ([Configuration](../reference/configuration.md)).                         |
| Install                       | Builds `node-hid`, a native module. With pnpm, the README's install line adds `--allow-build=node-hid`.                                                                                   | No native modules. One package per cloud, with that cloud's JavaScript SDK ([Configuration](../reference/configuration.md#provider-packages)).                 |
| EIP-7702                      | "Currently, `EIP-7702` is not supported, as the underlying Ledger library doesn't implement it" (README).                                                                                 | Signs EIP-7702 transactions and authorizations ([`kms sign-auth`](../reference/tasks.md#kms-sign-auth), [Library accounts](../reference/library-accounts.md)). |
| Record of what was signed     | Sent transactions show on chain. The README describes no log of signatures.                                                                                                               | The cloud's audit log; `kms history` lists a key's sign events ([`kms history`](../reference/tasks.md#kms-history)).                                           |
| Cost                          | The device.                                                                                                                                                                               | A fee per sign call, and on AWS and Google Cloud a monthly fee per key ([Cost and latency per signature](kms-or-env-key.md#cost-and-latency-per-signature)).   |

With a Ledger, the person at the device reviews each request and approves or declines it (README). Nobody reviews a KMS sign request: hardhat-kms checks the request's shape, such as the chain, and refuses a bare digest over JSON-RPC. Explicit raw signing is available through the CLI task ([`kms sign --no-hash`](../reference/tasks.md#raw-digests)) or an opted-in library account ([`rawSign: true`](../reference/library-accounts.md#options)), and neither asks anyone to approve. It signs every request that passes those checks ([Security model](security-model.md)).

## Both in one project

hardhat-kms works next to hardhat-ledger. A network can list Ledger accounts and KMS keys together, and each request goes to the plugin that owns its `from` address. List hardhat-ledger first in `plugins`. [Add local or Ledger accounts](../guides/multiple-keys.md#add-local-or-ledger-accounts) shows the config, and [Other signing plugins](../reference/configuration.md#other-signing-plugins) explains what the order changes.

In that setup, name the sender by address in every script. With hardhat-ledger first, the Ledger addresses come before the KMS addresses in `eth_accounts`, so a library's default sender on a node without accounts is the first Ledger address ([Choose the sender by address](../guides/multiple-keys.md#choose-the-sender-by-address)).

## When to use which

- A Ledger fits a key that a person uses now and then and wants to approve each time: a contract owner or an admin role, an upgrade, a treasury transfer.
- A KMS key fits a key that signs without a person: deploys from CI, scheduled scripts, a server, or runs that several people start.
- Both: a KMS key deploys and runs the routine calls, and the roles that can change or drain a contract sit with a Ledger address. The deploy script then hands those roles to the Ledger address, and only a person at the device can use them.

For a private key in `.env` or the Hardhat keystore, read [A KMS key or a private key in .env](kms-or-env-key.md). For other KMS signers, read [Compared with other KMS signers](other-kms-signers.md).
