# Sending from smart accounts and Safes: research

Audience: contributors deciding whether hardhat-kms should send through a smart contract wallet, and reviewers who want to know why [#653](https://github.com/aelmanaa/hardhat-kms/issues/653) (Safe proposals) came before [#56](https://github.com/aelmanaa/hardhat-kms/issues/56) (a smart-account send mode).

Status: research done on 2026-11-02. Package versions, download counts and issue states are as of that day. Each fact was checked against npm, GitHub or the vendor's docs; the [last section](#not-verified) lists what was not. No decision record yet: [#653](https://github.com/aelmanaa/hardhat-kms/issues/653) asks for one after its spike.

## 1. Question

Can a Hardhat 3 user deploy contracts and send transactions from a smart contract wallet (an ERC-4337 account, an EIP-7702 delegated EOA, a Safe multisig) with viem, ethers or Ignition today? If no good tool exists, which use case should hardhat-kms serve, and how?

Three use cases are kept apart, because they need different designs:

- **(a) Sponsored deploys:** one developer deploys without holding gas, through a paymaster.
- **(b) Safe:** deploy, admin and upgrade calls go through a Safe multisig. Other owners sign later, so the flow is asynchronous.
- **(c) Smart account as the deployer:** a 4337 or 7702 account is the identity that deploys and sends.

## 2. What exists for Hardhat 3

No Hardhat 3 plugin makes ordinary viem, ethers or Ignition sends go through a smart wallet, and none proposes to the Safe Transaction Service.

| Tool                                                            | What it does                                                                                                                                                                                                                                                   | Hardhat 3                                                                             | Last release           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------- |
| `@nomicfoundation/hardhat-ignition` 3.1.9, ignition-core 3.1.11 | Deploys with the `basic` or `create2` (CreateX) strategy. `resolve-strategy.js` throws `UNKNOWN_STRATEGY` for any other name, so a plugin cannot add one.                                                                                                      | Yes, no Safe or smart-account path                                                    | 2026-10-15             |
| `hardhat-deploy` 2.3.0 (rocketh 0.26.2)                         | When the sender is a Safe it cannot sign for, the run pauses and prints the call for a person to execute in the Safe app (`onUnknownSigner`). Rehearses on a fork by impersonating the Safe. Does not propose through the Safe API. No 4337 or paymaster path. | Yes (peer `hardhat ^3.6.0`)                                                           | 2026-10-28             |
| `hardhat-reown` 0.0.7                                           | WalletConnect wallets as Hardhat accounts, interactive. Its README says only EOAs can deploy.                                                                                                                                                                  | Yes                                                                                   | 2025-10-15             |
| `@openzeppelin/hardhat-upgrades` 4.1.0                          | Proxy deploys and upgrades. Its "propose the upgrade to a multisig" path ran through OpenZeppelin Defender, retired on 2026-07-01.                                                                                                                             | Yes                                                                                   | 2026-07-23             |
| `@defi-wonderland/hardhat-account-abstraction` 1.0.0            | The only prior plugin that sent every transaction as a user operation through a bundler and paymaster, deployed through CreateX and rewrote receipts. The closest prior art for a send mode.                                                                   | No (Hardhat 2.19, viem 1); repository gone; 4 downloads a week                        | 2024-02-08, only one   |
| `hardhat-gasless-deployer`                                      | Gasless deploys through the Gas Station Network.                                                                                                                                                                                                               | No; 24 downloads a week                                                               | 2023                   |
| `hardhat-aa`, `hardhat-useroperation` and similar               | Early 4337 experiments.                                                                                                                                                                                                                                        | No (`hardhat ^2`)                                                                     | 2023–2024, abandoned   |
| `hardhat-safe-deployer` (rmeissner, and a fork)                 | Routed deploys to a Safe through the Safe service.                                                                                                                                                                                                             | No                                                                                    | original archived 2022 |
| `@bloq/safe-ops` (GitHub only)                                  | Stages, rehearses and proposes Safe transactions from hardhat-deploy scripts.                                                                                                                                                                                  | No (Hardhat 2 API)                                                                    | pushed 2026-10-02      |
| `@layerzerolabs/toolbox-hardhat`                                | LayerZero wiring, can submit through a Safe.                                                                                                                                                                                                                   | No (Hardhat 2), LayerZero only                                                        | 2026-06-30             |
| Safe protocol-kit 8.0.11, api-kit 5.0.4                         | Build, sign and propose Safe transactions.                                                                                                                                                                                                                     | Library only; Safe's docs mention Hardhat only for deploying Safe's own contracts     | 2026-10-28             |
| permissionless 0.5.2, viem `account-abstraction`                | 4337 accounts, bundler and paymaster clients.                                                                                                                                                                                                                  | Library only                                                                          | 2026-10-23             |
| `@alchemy/wallet-apis` 5.3.0 and other smart-account SDKs       | ZeroDev, Biconomy, thirdweb, Coinbase CDP, Openfort, Gelato.                                                                                                                                                                                                   | Library only; their docs mention Hardhat 0 times (Pimlico's mention Foundry 54 times) | Oct 2026               |

Hardhat itself: Ignition's maintainer wrote in [discussion 5533](https://github.com/NomicFoundation/hardhat/discussions/5533) (2024-07-17) that multisig support "is on our roadmap. Our intention is to support a `safe` strategy, that will proxy deployments and calls through the multisig, halting the execution awaiting sign-off." Nothing has shipped and no tracking issue exists. EIP-5792 batch calls in hardhat-viem and hardhat-ethers are open without priority ([NomicFoundation/hardhat#7401](https://github.com/NomicFoundation/hardhat/issues/7401)). The community plugins list has no Safe, multisig or account-abstraction entry.

hardhat-kms already covers smart-account use from library code: `connection.kms.getAccount` is the signer of an Alchemy Wallet APIs smart wallet, and `checkPreparedCalls` checks what Alchemy prepared ([guide](../../user/guides/alchemy-wallet-apis.md)).

## 3. Foundry, for comparison

- Safe: community libraries let a forge script propose to a Safe in a few lines, Ledger included: [Recon-Fuzz/safe-utils](https://github.com/Recon-Fuzz/safe-utils), [ind-igo/forge-safe](https://github.com/ind-igo/forge-safe) (129 stars), treb, Sphinx (Foundry only). Foundry closed its own Safe request as solved by those libraries ([foundry-rs/foundry#1232](https://github.com/foundry-rs/foundry/issues/1232), 2025-06-12), then shipped `cast safe create/propose/sign/simulate/execute` (PR 16377, merged 2026-08-31).
- EIP-7702: native (`cast send --auth`, `vm.signDelegation`). The account-abstraction request ([foundry-rs/foundry#7128](https://github.com/foundry-rs/foundry/issues/7128)) was closed as covered by 7702.
- 4337 bundlers and paymasters: not native in Foundry either.

## 4. Demand

| Use case                          | Demand                  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Sponsored deploys             | Weak                    | The two Hardhat plugins built for it get 24 and 4 downloads a week. Foundry's account-abstraction request had 5 👍 and was narrowed to 7702.                                                                                                                                                                                                                                                                                                                                       |
| (b) Safe                          | Moderate, the strongest | Foundry's Safe request is the most-reacted in this space (16 👍, 28 comments). Hardhat put an Ignition `safe` strategy on its roadmap in 2024. [hardhat-deploy#101](https://github.com/wighawag/hardhat-deploy/issues/101) asked for a Safe as deployer (23 comments). [raycashxyz/deployoor#65](https://github.com/raycashxyz/deployoor/issues/65) (2026-10-28) asks for Safe and smart-account submitters. Defender's retirement left Hardhat teams without their proposal flow. |
| (c) Smart account as the deployer | Weak                    | No requests in the Hardhat, viem or account-abstraction SDK repositories.                                                                                                                                                                                                                                                                                                                                                                                                          |

The Safe need is mostly proposing admin and upgrade calls, not deploying from the Safe. The documented practice is to deploy from an EOA, often a KMS key or a Ledger, then transfer ownership to the Safe ([OpenZeppelin](https://docs.openzeppelin.com/defender/v1/guide-upgrades), [LayerZero](https://docs.layerzero.network/v2/developers/evm/technical-reference/transfer-ownership)).

Weekly npm downloads, 2026-10-26 to 2026-11-01: `hardhat` 554,673; `@nomicfoundation/hardhat-ignition` 138,311; `hardhat-deploy` 84,288; `@safe-global/protocol-kit` 224,784; `@safe-global/api-kit` 148,284; `permissionless` 205,450; `@alchemy/wallet-apis` 16,222; `@openzeppelin/defender-sdk` 1,769. The smart-account SDKs have an audience as large as Hardhat's, mostly in apps and wallets; the near-zero downloads of the Hardhat plugins suggest little of it is deploy tooling.

## 5. What a send mode would have to solve

A transparent send mode for (a) or (c), where `eth_sendTransaction` from a KMS account goes out as a user operation, meets these problems. The first four were read in ignition-core 3.1.9; their effect on a send mode is analysis, not tested.

- Deploys: a smart account deploys through a factory, so the receipt's `contractAddress` is null, and Ignition's `basic` strategy reads it (`jsonrpc-client.js`). Ignition's `create2` strategy reads the address from CreateX's event instead, so it is the way in.
- Hashes: tools expect a transaction hash and then poll its receipt. A user operation first has a user-operation hash; the plugin would wait for the bundle and return the outer transaction, whose receipt is the bundler's and may hold other operations.
- Nonces: Ignition reconciles each sender with `eth_getTransactionCount` (`get-nonce-sync-messages.js`), which does not move per user operation.
- `msg.sender` in constructors becomes the factory, so `Ownable` and role grants land on it.
- EIP-7702 helps: the KMS address itself becomes the smart wallet, so the address users know stays the same.

## 6. Conclusion

- No good Hardhat 3 solution exists for any of the three use cases.
- Build the Safe proposer first ([#653](https://github.com/aelmanaa/hardhat-kms/issues/653)): the KMS key signs a Safe transaction (EIP-712, which the plugin already signs) and proposes it to the Safe Transaction Service, and the other owners approve in the Safe app. It serves the strongest demand, fills the gap Defender left, and fits hardhat-kms: an unattended KMS key is the Safe owner a CI pipeline needs. It does not touch the send path.
- Ignition support for Safes has to be a strategy inside Ignition. Ask the Hardhat team whether their planned `safe` strategy is still coming before building an Ignition path.
- Park the smart-account send mode ([#56](https://github.com/aelmanaa/hardhat-kms/issues/56)) until users ask for it. If it is built, start from Ignition's `create2` strategy and Wonderland's receipt rewriting.

## Not verified

- Whether OpenZeppelin Defender has shut down as planned on 2026-07-01, and whether its CREATE2 proposal flow has no replacement (one forum post).
- How many Hardhat 3 projects call protocol-kit or permissionless from scripts (GitHub code search was rate-limited).
- Whether `hardhat-reown` works with a Safe.
- Whether the Safe Transaction Service needs an API key for proposals; [#653](https://github.com/aelmanaa/hardhat-kms/issues/653)'s spike checks it.
- Reddit, Discord and X were not searched.
