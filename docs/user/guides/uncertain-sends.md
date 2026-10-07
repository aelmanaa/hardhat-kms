---
title: After an uncertain send
description: "After a KMS send with no clear answer, or one that is not mined: look it up, compare the pending and latest counts, then wait or fill a nonce."
---

# After an uncertain send

Audience: users who send transactions from a KMS account on a live network and got an error that does not say whether the transaction went out, or see a transaction that does not get mined. Assumes a working key setup and the `@nomicfoundation/hardhat-viem` plugin.

Checked against hardhat-kms 0.8.0, viem 2.57.1 and a local anvil node on 2026-10-07; not run on a public network.

Do not send again from the account until step 2 tells you what happened to the first transaction.

Hardhat Ignition handles a send that fails with `core.tx.outcome-unknown` on its own: it reads the hash from the error and follows that transaction. These steps are for scripts and tests that send with viem, ethers or `provider.request`.

## When a send is uncertain

You are in one of these cases:

- The send failed with [`core.tx.outcome-unknown`](../reference/errors.md#transactions), JSON-RPC code `-32000`. The plugin signed the transaction and handed it to the node, but no answer came back, because the request timed out or failed with an HTTP error status. The transaction may be in the node's pool, or may never have arrived.
- The send failed with an answer from a gateway that its backend timed out: code `-32603`, or a message saying that the request timed out or that a deadline was exceeded. The plugin passes that answer on unchanged, so it carries no hash.
- A transaction stays unmined, or later transactions from the account do not get mined.

[Parallel sends and failed broadcasts](../reference/rpc-methods.md#parallel-sends-and-failed-broadcasts) explains what the plugin does in each case. The rule that matters here: the plugin remembers its nonces only per connection, and a lookup that fails counts as "not known", so a later send can reuse the nonce of a transaction that did reach the node.

## 1. Get the transaction hash

The error message of `core.tx.outcome-unknown` names it:

```text
eth_sendTransaction: transaction 0x… was handed to the node, but no answer came back (…). It may still be mined: look it up by its hash before sending another transaction. Repeating the same request within 120 s sends the same transaction again.
```

viem prints this message as the `Details:` line of its error, under a first line that says "Missing or invalid parameters" (viem reads code `-32000` as invalid input). In code, the hash is `transactionHash` on the plugin's error (also `data.hash`), which is in the `cause` chain of viem's `TransactionExecutionError`. This function finds it:

```ts
/** The hash of a send whose outcome is unknown, from the error or any of its causes. */
export function sentHashOf(error: unknown): string | undefined {
  let current = error;
  while (typeof current === "object" && current !== null) {
    if ("transactionHash" in current && typeof current.transactionHash === "string") {
      return current.transactionHash;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
```

After a `-32000` error, viem sends the request once more as `wallet_sendTransaction`. The plugin refuses it for a KMS account with `-32601`, so viem throws the error above, with the hash in its `cause` chain. The hash is also in the debug output: run with `DEBUG=hardhat:kms:*` ([Debug output](debug-output.md)) and look for `sending transaction 0x… got no answer` in the `hardhat:kms:rpc` lines.

A gateway's timeout answer has no hash. Skip to [step 3](#3-compare-the-pending-and-latest-counts).

## 2. Look the transaction up

Save this as `scripts/check-send.ts`. It asks the node for the transaction, its receipt, and the account's `latest` and `pending` transaction counts:

```ts
import "@nomicfoundation/hardhat-viem";
import { network } from "hardhat";
import {
  getAddress,
  isHash,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from "viem";

const hash = process.env.TX_HASH;
const account = process.env.KMS_ADDRESS;
if (hash === undefined || !isHash(hash) || account === undefined) {
  throw new Error("set TX_HASH to the transaction hash and KMS_ADDRESS to the sender");
}
const address = getAddress(account);

const { viem, networkName } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
console.log(`network ${networkName}, chain ${await publicClient.getChainId()}`);

const latest = await publicClient.getTransactionCount({ address, blockTag: "latest" });
const pending = await publicClient.getTransactionCount({ address, blockTag: "pending" });
console.log(`latest count ${latest}, pending count ${pending}`);

const transaction = await publicClient.getTransaction({ hash }).catch((error: unknown) => {
  if (error instanceof TransactionNotFoundError) {
    return undefined;
  }
  throw error;
});
if (transaction === undefined) {
  console.log("not known to this node");
} else {
  const receipt = await publicClient.getTransactionReceipt({ hash }).catch((error: unknown) => {
    if (error instanceof TransactionReceiptNotFoundError) {
      return undefined;
    }
    throw error;
  });
  const fees =
    transaction.maxFeePerGas === undefined
      ? `gasPrice ${transaction.gasPrice}`
      : `maxFeePerGas ${transaction.maxFeePerGas}, maxPriorityFeePerGas ${transaction.maxPriorityFeePerGas}`;
  console.log(
    receipt === undefined
      ? `in the pool with nonce ${transaction.nonce}, ${fees}`
      : `mined in block ${receipt.blockNumber} with nonce ${transaction.nonce}: ${receipt.status}`,
  );
}
```

Run it with `--network` set to the network the send used. The first line it prints names the network and its chain id; check them before you read the rest, because a lookup on the wrong network also says `not known to this node`.

```sh
TX_HASH=0x… KMS_ADDRESS=0x… npx hardhat run --network <network> scripts/check-send.ts
```

What to do with the answer:

| The script prints        | Meaning                                                    | Next                                                                                                        |
| ------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `mined …: success`       | The transaction ran.                                       | Nothing. Do not send it again.                                                                              |
| `mined …: reverted`      | It ran and reverted. Its nonce is used, and so is the fee. | Fix the cause, then send a new transaction.                                                                 |
| `in the pool …`          | The node has it and has not mined it yet.                  | Wait. If it stays there because its fees are too low, [replace it](#4-fill-a-gap-or-replace-a-transaction). |
| `not known to this node` | The node does not have it (yet).                           | [Wait, then look again](#when-to-wait) before you send anything new from the account.                       |

## 3. Compare the pending and latest counts

The `latest` count is the number of the account's transactions in mined blocks, so it is the next nonce the chain expects. The `pending` count adds the transactions the node holds in its pool that can run in order after them.

- `pending` equals `latest`: the node holds nothing from the account that can run next. A transaction you sent and cannot find did not reach this node, or the node dropped it.
- `pending` is above `latest`: transactions with the nonces from `latest` up to `pending` minus one are waiting to be mined.
- A transaction whose nonce is above the `pending` count waits behind a gap: no transaction with the nonces from `pending` up to its nonce minus one has reached the node. It is not mined until each of those nonces is used, by a transaction you send for it.

Behind a load-balanced RPC endpoint, two requests can reach two backends whose counts differ. Run the script twice before you act on a gap.

The plugin can leave such a gap itself. It remembers the highest nonce the node accepted on each connection, and the next send on that connection never takes a lower one. If the node accepted a transaction and then dropped it, later sends on the same connection wait behind its nonce. That memory ends with the connection: the next `hardhat run` starts again from the node's `pending` count.

## 4. Fill a gap or replace a transaction

Send a transaction with an explicit `nonce`. The plugin always uses a `nonce` you give, even one that was sent before, and does not look anything up first. A transfer of 0 from the account to itself fills a gap, and with higher fees it also cancels a transaction stuck in the pool. Save this as `scripts/fill-nonce.ts`:

```ts
import "@nomicfoundation/hardhat-viem";
import { network } from "hardhat";
import { getAddress } from "viem";

const account = process.env.KMS_ADDRESS;
const nonce = process.env.NONCE;
if (account === undefined || nonce === undefined || !/^\d+$/.test(nonce)) {
  throw new Error("set KMS_ADDRESS to the sender and NONCE to the nonce to fill or replace");
}
const address = getAddress(account);

const { viem, networkName } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
console.log(`network ${networkName}, chain ${await publicClient.getChainId()}`);
const wallet = await viem.getWalletClient(address);

// Twice the current estimate. To replace a transaction, the fees must also be at least 10 % above
// the old transaction's maxFeePerGas and maxPriorityFeePerGas, which step 2 prints, on Geth's
// default settings.
const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
const hash = await wallet.sendTransaction({
  to: address,
  value: 0n,
  nonce: Number(nonce),
  maxFeePerGas: maxFeePerGas * 2n,
  maxPriorityFeePerGas: maxPriorityFeePerGas * 2n,
});
console.log(`sent ${hash} with nonce ${nonce}`);
```

Run it the same way, with `--network`:

```sh
KMS_ADDRESS=0x… NONCE=… npx hardhat run --network <network> scripts/fill-nonce.ts
```

- To fill a gap, run it once for each missing nonce, from the `pending` count up to the waiting transaction's nonce minus one.
- To replace a transaction in the pool, use its nonce, which step 2 prints. The node keeps the one that pays more, and drops the other. Fees too close to the old ones fail with `replacement transaction underpriced`; raise them and send again. A nonce that is already mined fails with `nonce too low`.
- Running the script again with the same nonce and the same fee estimate signs the same transaction. The node answers that it already has it, and viem reports that as a nonce lower than the account's current nonce, although the transaction is in the pool, not mined. viem's `Details:` line shows the node's own words: `already known` (Geth) or `transaction already imported` (anvil) means the transaction is in the pool, and only `nonce too low` means the nonce is mined. Run step 2 to be sure.
- To send the same call again instead of a 0 transfer, send that call with the same explicit `nonce`. Two transactions with one nonce can never both be mined.

## When to wait

- A transaction in the pool with a nonce equal to the `latest` count is next in line. Wait three or four blocks (under a minute on most networks) before you replace it.
- A transaction the node does not know can still arrive from a backend or a peer that had it. Look it up again after a minute, and run step 3. Do not send a new transaction from the account until `pending` equals `latest`, or you know which nonce the lost transaction had.
- While the script that got the error is still running, the plugin can retry for you: the same request, with the same params, on the same connection within 120 seconds sends the same signed transaction again. It cannot be mined twice. A new run has no such memory.

In a new run, a send without a `nonce` takes the node's `pending` count. If the lost transaction was the account's last one and `pending` equals `latest`, the new send gets the same nonce, so at most one of the two is mined. If the lost transaction arrives first, the new send fails with `nonce too low` or `replacement transaction underpriced`, or replaces it when it pays enough more.

## Avoid nonce reuse

- Use one connection per network in a script. `network.getOrCreate()` returns the same connection each time it is called for a network and chain type, while each `network.create()` opens a new one, as the deprecated `network.connect()` does. Sends on two connections still run one at a time, but each connection remembers only its own nonces, so a node whose `pending` count lags can give both the same nonce.
- Do not send from one key in two processes at the same time. The plugin does not coordinate them.
