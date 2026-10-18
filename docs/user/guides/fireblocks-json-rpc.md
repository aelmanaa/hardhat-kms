---
title: Use Fireblocks through its JSON-RPC proxy
description: "Point a Hardhat 3 network at Fireblocks' local JSON-RPC proxy: setup, config, viem, ethers and Ignition sends, message signing, and the limits."
---

# Use Fireblocks through its JSON-RPC proxy

This guide sends Hardhat 3 transactions from a Fireblocks vault account. It runs Fireblocks' local JSON-RPC proxy, `@fireblocks/fireblocks-json-rpc`, and points a Hardhat HTTP network at it, the way Fireblocks documents Foundry. hardhat-kms has no Fireblocks provider yet ([#55](https://github.com/aelmanaa/hardhat-kms/issues/55)); this is a way to use Fireblocks today, next to the plugin, not a hardhat-kms provider.

You need a Fireblocks workspace with an API user and a vault account that holds Sepolia ETH, and a Hardhat 3 project.

> [!NOTE]
> Audience: teams whose keys live in Fireblocks and who want Hardhat 3 to deploy and call contracts through them.
>
> Not verified. Nothing on this page has been run against a Fireblocks workspace yet. Every statement comes from reading the sources on 2026-10-18: `@fireblocks/fireblocks-json-rpc` 0.2.6 ([commit `a6db393`](https://github.com/fireblocks/fireblocks-json-rpc/tree/a6db393)), `@fireblocks/fireblocks-web3-provider` 1.5.0 ([commit `65ebe22`](https://github.com/fireblocks/fireblocks-web3-provider/tree/65ebe22)), Hardhat 3.18.1, `@nomicfoundation/hardhat-viem` 3.0.9, `@nomicfoundation/hardhat-ethers` 4.2.0, `@nomicfoundation/hardhat-ignition` 3.1.8 with `ignition-core` 3.1.9, and viem 2.57.1. The steps marked "not verified" are the ones a Sandbox run must confirm.

## What this route is, and what it skips

Fireblocks does not ship a Hardhat 3 plugin: `@fireblocks/hardhat-fireblocks` 1.3.6 has a peer dependency on `hardhat ^2.6.0`, and [fireblocks/hardhat-fireblocks#24](https://github.com/fireblocks/hardhat-fireblocks/issues/24), "Add Hardhat V3 support", is open. Fireblocks documents its [EVM local JSON-RPC](https://developers.fireblocks.com/reference/evm-local-json-rpc) for web3.py, Brownie and Foundry. The proxy is a small Express server that hands every JSON-RPC request to `FireblocksWeb3Provider` ([`src/server.ts:42-76`](https://github.com/fireblocks/fireblocks-json-rpc/blob/a6db393/src/server.ts#L42-L76)). For Hardhat it is one more node URL.

What the proxy does with each request ([`src/provider.ts:362-421`](https://github.com/fireblocks/fireblocks-web3-provider/blob/65ebe22/src/provider.ts#L362-L421)):

| JSON-RPC method                                           | What happens                                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eth_accounts`, `eth_requestAccounts`                     | The first address of the chain's asset in each vault account the proxy may use                                                                                                 |
| `eth_sendTransaction`                                     | A Fireblocks `CONTRACT_CALL` (with data) or `TRANSFER` (without), from the vault account that owns `from`. Fireblocks signs it, assigns the nonce and broadcasts it            |
| `personal_sign`, `eth_sign`                               | A Fireblocks `TYPED_MESSAGE` of type `ETH_MESSAGE` (EIP-191). `eth_sign` is read in `personal_sign` parameter order, so a standard `[address, data]` call fails (not verified) |
| `eth_signTypedData`, `eth_signTypedData_v1`, `_v3`, `_v4` | A Fireblocks `TYPED_MESSAGE` of type `EIP712`                                                                                                                                  |
| `eth_signTransaction`, `eth_signTypedData_v2`             | Error `4200`, "not implemented"                                                                                                                                                |
| Everything else, `eth_sendRawTransaction` included        | Forwarded to the proxy's RPC node                                                                                                                                              |

hardhat-kms does not see these requests. On a network with no `kmsAccounts` the plugin passes every request through ([RPC methods](../reference/rpc-methods.md#rpc-behaviour)), so none of its checks apply: no `address` pin, no signature verification or low-S check, no chain-id rule for typed data, no send lock and no double-broadcast protection. The proxy and Fireblocks' policy engine are the only checks on this route. Fireblocks policies see the full contract call, which is the point of the route.

## 1. Create the API user and the vault account

1. Sign up for a [Developer Sandbox](https://developers.fireblocks.com/docs/workspace-environments) or use a Testnet workspace. In a Sandbox every transaction is auto-approved, policies cannot be edited, and up to 5 API users are allowed.
2. Create an API user. In a Testnet or Mainnet workspace, give it the Signer role: it can initiate and sign transactions ([Segregate duties](https://developers.fireblocks.com/docs/segregate-duties)). Generate its private key and CSR locally ([Create a CSR for an API user](https://developers.fireblocks.com/docs/generate-a-csr-for-an-api-user)) and keep the key file outside the project. A Sandbox has only three roles, Non-Signing Admin, Editor and Viewer, and creates the CSR in the browser ([Workspace comparison](https://developers.fireblocks.com/docs/workspace-environments)). Viewer cannot initiate transactions. Which of Editor and Non-Signing Admin a Sandbox needs for the proxy is not verified: try Editor first.
3. Create a vault account with the Sepolia asset, `ETH_TEST5` ([`src/constants.ts:10`](https://github.com/fireblocks/fireblocks-web3-provider/blob/65ebe22/src/constants.ts#L10)), and fund its address with Sepolia ETH.
4. In a Testnet or Mainnet workspace, add policy rules that allow contract calls from that vault account, and a Typed Message rule if you sign messages ([Sign typed messages](https://developers.fireblocks.com/docs/typed-message-signing-1)). Deployments go to a one-time address `0x0`, so one-time addresses must be on, as they are by default in the proxy (`oneTimeAddressesEnabled`, [`src/provider.ts:485-508`](https://github.com/fireblocks/fireblocks-web3-provider/blob/65ebe22/src/provider.ts#L485-L508)).

## 2. Install and start the proxy

Install the proxy globally, as Fireblocks documents:

```sh
npm install -g @fireblocks/fireblocks-json-rpc
```

The proxy reads its settings from flags or environment variables, and loads a `.env` file from the current directory ([`src/command.ts`](https://github.com/fireblocks/fireblocks-json-rpc/blob/a6db393/src/command.ts)). Set them in your shell or a secret manager, not in the project:

| Variable                          | Value                                                                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIREBLOCKS_API_KEY`              | The API user's key                                                                                                                                                                                                                                       |
| `FIREBLOCKS_API_PRIVATE_KEY_PATH` | The path of the API user's private key file (the variable also takes the key's contents)                                                                                                                                                                 |
| `FIREBLOCKS_API_BASE_URL`         | `https://sandbox-api.fireblocks.io` for a Sandbox. Leave it unset for other workspaces                                                                                                                                                                   |
| `FIREBLOCKS_CHAIN_ID`             | `11155111` for Sepolia. It picks the Fireblocks asset                                                                                                                                                                                                    |
| `FIREBLOCKS_RPC_URL`              | Your Sepolia RPC URL, for every read. Without it the proxy reads from `ethereum-sepolia-rpc.publicnode.com` ([`src/constants.ts:10`](https://github.com/fireblocks/fireblocks-web3-provider/blob/65ebe22/src/constants.ts#L10))                          |
| `FIREBLOCKS_VAULT_ACCOUNT_IDS`    | The vault account id, or a comma-separated list. Without it the proxy loads the first 20 vault accounts that hold the asset ([`src/provider.ts:202-217`](https://github.com/fireblocks/fireblocks-web3-provider/blob/65ebe22/src/provider.ts#L202-L217)) |
| `FIREBLOCKS_HTTP_PATH`            | A path of your own, such as a random one. Without it the path is `/<API key>` ([`src/server.ts:19`](https://github.com/fireblocks/fireblocks-json-rpc/blob/a6db393/src/server.ts#L19))                                                                   |

Always set `FIREBLOCKS_HTTP_PATH`. By default the proxy's URL path is the API key itself, and the proxy prints its URL when it starts ([`src/cli.ts:34`](https://github.com/fireblocks/fireblocks-json-rpc/blob/a6db393/src/cli.ts#L34)), so the key would end up in the terminal, in CI logs and in the URL Hardhat holds. Fireblocks' own Brownie example puts `${FIREBLOCKS_API_KEY}` in the network URL; do not copy that.

Run Hardhat as the proxy's child process. The proxy starts on `127.0.0.1:8545` (`FIREBLOCKS_PORT` changes the port), sets `FIREBLOCKS_JSON_RPC_ADDRESS` to its URL in the child's environment, removes `FIREBLOCKS_API_KEY` and `FIREBLOCKS_API_PRIVATE_KEY_PATH` from it, and stops when the child exits ([`src/cli.ts:39-65`](https://github.com/fireblocks/fireblocks-json-rpc/blob/a6db393/src/cli.ts#L39-L65)):

```sh
FIREBLOCKS_HTTP_PATH="/$(openssl rand -hex 16)" fireblocks-json-rpc --http -- npx hardhat run scripts/fireblocks-viem.ts --network fireblocks
```

So Hardhat never sees the API key or the private key path, and the proxy listens only while the command runs. The proxy has no authentication of its own: while it runs, any process on the machine that knows its port and path can ask Fireblocks to sign. Keep the default host `127.0.0.1`; the proxy warns when you change it ([`src/cli.ts:35-37`](https://github.com/fireblocks/fireblocks-json-rpc/blob/a6db393/src/cli.ts#L35-L37)).

To list the vault account's address first, run `eth_accounts` through the same wrapper, as Fireblocks' Foundry guide does (not verified):

```sh
FIREBLOCKS_HTTP_PATH="/$(openssl rand -hex 16)" fireblocks-json-rpc --http -- curl -s -X POST -H "Content-Type: application/json" --data '{"method":"eth_accounts","params":[],"id":1,"jsonrpc":"2.0"}' {}
```

The proxy replaces `{}` with its URL ([`src/cli.ts:29`](https://github.com/fireblocks/fireblocks-json-rpc/blob/a6db393/src/cli.ts#L29)).

## 3. Add the network to the Hardhat config

The `fireblocks` network below takes its URL from `FIREBLOCKS_JSON_RPC_ADDRESS`, which the proxy sets. It lists no `kmsAccounts`: the proxy holds the accounts. The project keeps a KMS key on its `sepolia` network, to show that both work side by side; leave that network out if you only use Fireblocks.

```ts
import hardhatKmsAws from "@hardhat-kms/aws";
import hardhatIgnitionViem from "@nomicfoundation/hardhat-ignition-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatKmsAws, hardhatIgnitionViem],
  solidity: "0.8.24",
  kms: {
    keys: { deployer: { provider: "aws", keyId: "alias/deployer" } },
  },
  networks: {
    // Signed by a KMS key, through hardhat-kms.
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["deployer"],
    },
    // Signed and broadcast by Fireblocks, through fireblocks-json-rpc. The proxy sets the URL.
    fireblocks: {
      type: "http",
      url: configVariable("FIREBLOCKS_JSON_RPC_ADDRESS"),
      chainId: 11155111,
      // The proxy's eth_accounts lists the vault accounts.
      accounts: "remote",
      // Each eth_sendTransaction waits for Fireblocks' approval: 30 minutes, not the default 5.
      timeout: 1_800_000,
      ignition: {
        // A bumped-fee resend would be a new Fireblocks transaction with its own nonce.
        disableFeeBumping: true,
        // Wait up to a minute for a broadcast transaction to reach your RPC node.
        maxRetries: 60,
      },
    },
  },
});
```

The fields that matter:

- `accounts: "remote"` is the default for an HTTP network: Hardhat asks the node, here the proxy, for its accounts and sends `eth_sendTransaction` unsigned ([Hardhat configuration reference](https://hardhat.org/docs/reference/configuration)).
- `chainId` makes Hardhat check `eth_chainId`, which the proxy reads from `FIREBLOCKS_RPC_URL`. The proxy also refuses a transaction whose `chainId` differs from `FIREBLOCKS_CHAIN_ID` ([`src/provider.ts:577-579`](https://github.com/fireblocks/fireblocks-web3-provider/blob/65ebe22/src/provider.ts#L577-L579)).
- `timeout` is the time Hardhat waits for each answer, in milliseconds. It defaults to 300,000, five minutes ([`config-resolution.ts`](https://github.com/NomicFoundation/hardhat/blob/hardhat%403.18.1/packages/hardhat/src/internal/builtin-plugins/network-manager/config-resolution.ts)), and applies to connecting, the headers and the body of every request. Each `eth_sendTransaction` and signing request stays open until Fireblocks finishes, so the timeout must cover your approval time. See [Approvals and timeouts](#approvals-and-timeouts).
- `ignition` is explained in [step 5](#5-deploy-with-ignition).

## 4. Deploy and call with viem or ethers

Scripts need no Fireblocks code. These are the [examples'](../../../examples/README.md) scripts, pointed at the `fireblocks` network.

With viem, save `scripts/fireblocks-viem.ts` (not verified):

```ts
// Loads the types of `connection.viem`. hardhat.config.ts already does this in a project.
import "@nomicfoundation/hardhat-viem";
import { network } from "hardhat";

const { viem } = await network.create("fireblocks");
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
if (deployer === undefined) {
  throw new Error("The proxy listed no accounts. Check FIREBLOCKS_VAULT_ACCOUNT_IDS.");
}
console.log(`Deployer: ${deployer.account.address}`);

// Fireblocks signs and broadcasts the deployment and the call.
const counter = await viem.deployContract("Counter", ["deployed with Fireblocks", 7n], {
  client: { wallet: deployer },
});
console.log(`Counter: ${counter.address}`);
const hash = await counter.write.add([5n], { account: deployer.account });
await publicClient.waitForTransactionReceipt({ hash });
console.log(`Count: ${await counter.read.count()}`);
```

With ethers, add `@nomicfoundation/hardhat-ethers` to the project and its `plugins`, and save `scripts/fireblocks-ethers.ts` (not verified). This repository does not install hardhat-ethers, so its checks do not typecheck this script:

<!-- docs-check: skip -->

```ts
import type { ContractTransactionResponse } from "ethers";
import { network } from "hardhat";

const { ethers } = await network.create("fireblocks");
const [deployer] = await ethers.getSigners();
if (deployer === undefined) {
  throw new Error("The proxy listed no accounts. Check FIREBLOCKS_VAULT_ACCOUNT_IDS.");
}

const counter = await ethers.deployContract("Counter", ["deployed with Fireblocks", 7n], deployer);
await counter.waitForDeployment();
console.log(`Counter: ${await counter.getAddress()}`);
const tx: ContractTransactionResponse = await counter.getFunction("add").send(5n);
await tx.wait();
console.log(`Count: ${await counter.getFunction("count").staticCall()}`);
```

Run either through the proxy, as in [step 2](#2-install-and-start-the-proxy):

```sh
FIREBLOCKS_HTTP_PATH="/$(openssl rand -hex 16)" fireblocks-json-rpc --http -- npx hardhat run scripts/fireblocks-viem.ts --network fireblocks
```

### Who sets the nonce, gas and fees

Hardhat fills a transaction before it reaches the proxy, and the proxy forwards some fields and drops others:

| Field                                     | Hardhat, for a remote account                                                                                                                                                                                                                                                                                                                                                                     | Proxy and Fireblocks                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nonce                                     | Not set. Only Hardhat's local-account handler fills a nonce ([`local-accounts.ts`](https://github.com/NomicFoundation/hardhat/blob/hardhat%403.18.1/packages/hardhat/src/internal/builtin-plugins/network-manager/request-handlers/handlers/accounts/local-accounts.ts)); viem and ethers send one only when you pass it                                                                          | Dropped. Fireblocks' transaction request has no nonce field; Fireblocks assigns it                                                                                                                                                                                                                                                                |
| Gas limit                                 | Estimated with `eth_estimateGas` when unset (`gas: "auto"`, the default)                                                                                                                                                                                                                                                                                                                          | Forwarded as `gasLimit`                                                                                                                                                                                                                                                                                                                           |
| Fees                                      | Filled when unset (`gasPrice: "auto"`, the default): `maxFeePerGas` and `maxPriorityFeePerGas` from `eth_feeHistory`, or `gasPrice` on a chain without EIP-1559 ([`automatic-gas-price-handler.ts`](https://github.com/NomicFoundation/hardhat/blob/hardhat%403.18.1/packages/hardhat/src/internal/builtin-plugins/network-manager/request-handlers/handlers/gas/automatic-gas-price-handler.ts)) | Forwarded in gwei as `maxFee` and `priorityFee`, or `fee`, because the gas limit is set too. Fireblocks then uses Hardhat's fees, and the proxy's fallback fee level (`FIREBLOCKS_FALLBACK_FEE_LEVEL`) is never used ([`src/provider.ts:587-606`](https://github.com/fireblocks/fireblocks-web3-provider/blob/65ebe22/src/provider.ts#L587-L606)) |
| `type`, `accessList`, `authorizationList` | Passed on as given                                                                                                                                                                                                                                                                                                                                                                                | Dropped. An EIP-7702 request is sent as a plain contract call, without its authorizations                                                                                                                                                                                                                                                         |

Hardhat has no setting that leaves the fees unset on an HTTP network: `gasPrice` is `"auto"` or a fixed legacy price. To let Fireblocks pick the fee level, the request would need no gas limit, which `gas: "auto"` always fills. So on this route the fees come from Hardhat, or from `gasPrice` in the config.

The proxy returns the transaction hash once Fireblocks reports `BROADCASTING`, `CONFIRMING` or `COMPLETED` ([`src/constants.ts:99-113`](https://github.com/fireblocks/fireblocks-web3-provider/blob/65ebe22/src/constants.ts#L99-L113)). Fireblocks may not have set the hash yet in `BROADCASTING`; a send that returns no hash then fails in viem or ethers although Fireblocks still broadcasts it (not verified). Check the Fireblocks console before you send again.

## 5. Deploy with Ignition

Ignition sends `eth_sendTransaction` from its default sender, the first address of `eth_accounts`. With one vault account in `FIREBLOCKS_VAULT_ACCOUNT_IDS`, that is the vault account. Pass `--default-sender` to be explicit:

```sh
FIREBLOCKS_HTTP_PATH="/$(openssl rand -hex 16)" fireblocks-json-rpc --http -- npx hardhat ignition deploy ignition/modules/Counter.ts --network fireblocks --default-sender 0x…
```

Ignition differs from viem and ethers on this route (read from `ignition-core` 3.1.9; not verified):

- Ignition plans every nonce itself: it reads the pending count and sends `nonce`, `gas` and fees explicitly ([`jsonrpc-client.ts`](https://github.com/NomicFoundation/hardhat/blob/%40nomicfoundation/ignition-core%403.1.9/packages/ignition-core/src/internal/execution/jsonrpc-client.ts)). The proxy drops the nonce and Fireblocks assigns its own. The two agree when nothing else sends from the vault account on Sepolia during the deployment. Ignition tracks each transaction by the hash the proxy returns, so a different nonce is not noticed while the run lasts, but its journal records the planned nonce, which a later resume relies on.
- Before each send, Ignition checks the pending count of your RPC node against the nonce it plans, and retries for about one second when the node lags. Fireblocks broadcasts through its own nodes, so your node can lag after a send and Ignition stops with a nonce error ([`json-rpc-nonce-manager.ts`](https://github.com/NomicFoundation/hardhat/blob/%40nomicfoundation/ignition-core%403.1.9/packages/ignition-core/src/internal/execution/nonce-management/json-rpc-nonce-manager.ts)). Run the same command again to resume once the transaction is visible.
- After a send, Ignition looks the transaction up on your node `maxRetries` times, `retryInterval` apart (10 times, 1 second, by default), and stops with "dropped transaction" when it never appears. `ignition.maxRetries: 60` in the config gives it a minute.
- When a transaction is not mined within three minutes, Ignition resends it with the same nonce and higher fees, up to four times. Through Fireblocks that resend is a second transaction with its own nonce, queued behind the first: two deployments or two calls. Set `ignition.disableFeeBumping: true`, as in the config above; Ignition then stops with a timeout instead, and you run it again after the first transaction is mined.
- Fireblocks processes one EVM transaction at a time per vault account ([Statuses](https://developers.fireblocks.com/reference/statuses)), and each send holds its HTTP request open until Fireblocks returns, so a module's transactions go out one after the other.

## 6. Sign messages and typed data

`personal_sign` and `eth_signTypedData_v4` reach Fireblocks as typed messages ([`src/provider.ts:621-671`](https://github.com/fireblocks/fireblocks-web3-provider/blob/65ebe22/src/provider.ts#L621-L671)). In a Testnet or Mainnet workspace a Typed Message policy rule must allow them ([Sign typed messages](https://developers.fireblocks.com/docs/typed-message-signing-1)). The proxy returns `r ‖ s ‖ v` with `v` 27 or 28. It does not check the signature, and neither does hardhat-kms on this route, so check it yourself. Save `scripts/fireblocks-sign.ts` (not verified):

```ts
// Loads the types of `connection.viem`. hardhat.config.ts already does this in a project.
import "@nomicfoundation/hardhat-viem";
import { network } from "hardhat";
import { isAddressEqual, recoverMessageAddress, recoverTypedDataAddress } from "viem";

const { viem } = await network.create("fireblocks");
const [signer] = await viem.getWalletClients();
if (signer === undefined) {
  throw new Error("The proxy listed no accounts. Check FIREBLOCKS_VAULT_ACCOUNT_IDS.");
}
const address = signer.account.address;

const message = "hello from Fireblocks";
const messageSignature = await signer.signMessage({ message });
const messageSigner = await recoverMessageAddress({ message, signature: messageSignature });
console.log("personal_sign recovers to the account:", isAddressEqual(messageSigner, address));

const typedData = {
  domain: { name: "Example", version: "1", chainId: 11155111 },
  types: { Greeting: [{ name: "text", type: "string" }] },
  primaryType: "Greeting",
  message: { text: "hello" },
} as const;
const typedSignature = await signer.signTypedData(typedData);
const typedSigner = await recoverTypedDataAddress({ ...typedData, signature: typedSignature });
console.log("eth_signTypedData_v4 recovers to the account:", isAddressEqual(typedSigner, address));
```

The proxy signs typed messages with the chain's asset (`ETH_TEST5` on Sepolia). Fireblocks' [Sign typed messages in Ethereum](https://developers.fireblocks.com/reference/sign-typed-messages-for-ethereum-and-evm-networks) says to pass `ETH` for every EVM network. Whether both give the same key in a testnet workspace is what the recovery check above shows.

## Approvals and timeouts

Each `eth_sendTransaction`, `personal_sign` and `eth_signTypedData_v4` is one HTTP request that stays open while Fireblocks screens, approves, signs and broadcasts. The proxy polls the Fireblocks transaction every second (`FIREBLOCKS_POLLING_INTERVAL`, in milliseconds), with no overall limit, and gives up only after five polling errors in a row ([`src/provider.ts:673-712`](https://github.com/fireblocks/fireblocks-web3-provider/blob/65ebe22/src/provider.ts#L673-L712)).

- A Sandbox approves everything automatically, so the default five minutes should be enough there (not verified).
- In a Testnet or Mainnet workspace, a transaction can wait in `PENDING_AUTHORIZATION` for two hours, and in `PENDING_SIGNATURE` for two more after authorization, before Fireblocks fails it ([Statuses](https://developers.fireblocks.com/reference/statuses)). Set `timeout` to the longest approval you expect. Fireblocks recommends an API Co-signer to avoid manual signing delays.
- When Hardhat's timeout ends first, the script fails, but the Fireblocks transaction is not cancelled: it can still be approved and broadcast. Hardhat does not resend a timed-out request (it retries only HTTP 429), and viem sends `eth_sendTransaction`, `personal_sign` and `eth_signTypedData_v4` with `retryCount: 0`, so a timeout does not create a second Fireblocks transaction. Running the script again does. Look the transaction up in the Fireblocks console first, and cancel it there if it should not go out.

## Limits

- No hardhat-kms checks: no address pin, no signature verification, no typed-data chain-id rule, no send lock. The mined transaction is not compared with the request.
- `eth_signTransaction` fails with `4200`; nothing can sign without broadcasting. `kms sign-tx`, `kms sign` and the other `kms` tasks work only with KMS keys, not with Fireblocks vault accounts.
- No EIP-7702: the proxy drops `authorizationList`.
- The nonce is Fireblocks', not Hardhat's or Ignition's.
- The fees are Hardhat's, not a Fireblocks fee level.
- No local rehearsal: an `edr-simulated` network or a fork cannot sign with the vault account. Rehearse with a local account or a KMS key, then deploy through the proxy.
- Errors from Fireblocks reach Hardhat as JSON-RPC error `-32603` with Fireblocks' message, such as `Fireblocks transaction … was not completed successfully. Final Status: BLOCKED (…)`.
- The proxy's last release was 0.2.6, on 2026-02-17.

## Troubleshooting

| Symptom                                                                              | Cause and fix                                                                                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `error: chainId or rpcUrl must be provided`                                          | Set `FIREBLOCKS_CHAIN_ID`, `FIREBLOCKS_RPC_URL` or both.                                                                                    |
| `Failed to populate accounts: Fireblocks SDK Error: …`                               | The API key, the private key file or `FIREBLOCKS_API_BASE_URL` is wrong. A Sandbox needs `https://sandbox-api.fireblocks.io`.               |
| `eth_accounts` returns `[]`, or Hardhat finds no wallet client                       | No vault account holds `ETH_TEST5`, or the ids in `FIREBLOCKS_VAULT_ACCOUNT_IDS` are wrong.                                                 |
| `Transaction sent from an unsupported address`                                       | `from` is not an address of the proxy's vault accounts. Pass `--default-sender` or the right account.                                       |
| `Contract deployment is currently not available without enabling one-time addresses` | `FIREBLOCKS_ONE_TIME_ADDRESSES_ENABLED` is `false`. Deployments need one-time addresses.                                                    |
| `Final Status: BLOCKED`, `REJECTED` or `FAILED`                                      | A policy blocked it, an approver rejected it, or the chain refused it. The substatus in brackets and the Fireblocks console say which.      |
| `Network connection timed out` while Fireblocks still shows the transaction          | Hardhat's `timeout` is shorter than the approval. Raise it, and see [Approvals and timeouts](#approvals-and-timeouts) before running again. |
| Ignition stops with a nonce error or "dropped transaction"                           | Your RPC node has not seen Fireblocks' broadcast yet. Wait, then run the same command again. Raise `ignition.maxRetries`.                   |
| `fireblocks-json-rpc` exits with `EADDRINUSE`                                        | Another node uses port 8545. Set `FIREBLOCKS_PORT`.                                                                                         |
| The API key appears in a URL or a log                                                | `FIREBLOCKS_HTTP_PATH` is unset. Set it, and rotate the API key if the log was shared.                                                      |

Pass `--verbose` to `fireblocks-json-rpc` to print every request and response it handles, and `--logTransactionStatusChanges true` to print each Fireblocks status change (neither verified). Prefer the `--verbose` flag to its variable: `FIREBLOCKS_VERBOSE` also turns on `--raw`, which hides the proxy's other output ([`src/command.ts:48-49`](https://github.com/fireblocks/fireblocks-json-rpc/blob/a6db393/src/command.ts#L48-L49)). Verbose output includes every request's parameters, so do not share it unreviewed.

## Related

- [Comparison with Foundry](../explanation/foundry-comparison.md#fireblocks): Foundry uses the same proxy.
- [Deploy with Hardhat Ignition](deploy-with-ignition.md): Ignition with a KMS key, including a rehearsal on a simulated network.
- [Security model](../explanation/security-model.md): the checks hardhat-kms adds for KMS keys, which this route does not have.
