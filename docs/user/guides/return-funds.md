---
title: Return the funds from a KMS address
description: "A Hardhat script that sends a KMS account's Sepolia balance back to your wallet before you delete the key, with what it refuses and how it stops."
---

# Return the funds from a KMS address

Audience: users who funded a KMS key's address on a test network, such as in the first-deploy tutorials, and want the balance back before they delete the key.

The address belongs to the key alone. Once the key is deleted or destroyed, nothing can move what is left at the address, so send the balance back first. The [first-deploy tutorials](../tutorials/first-deploy-aws.md) run this script in their clean-up step, before they remove the key.

## 1. Check the project

The script expects the project the tutorials build:

- a key named `deployer` in `kms.keys`, with its `address` pinned;
- a `sepolia` network that lists `deployer` in `kmsAccounts`;
- `@nomicfoundation/hardhat-viem`, which Hardhat's viem template installs.

For another key or network, change `"deployer"` and `"sepolia"` in the script. In a new shell, set the variables the config reads, such as `SEPOLIA_RPC_URL`, before you run it: the script loads the config.

## 2. Save the script

Save this script as `scripts/return-funds.ts`. It reads the deployer address from the pin, and sends the whole balance, less the fee, to the address in `RETURN_TO`. It refuses the zero address, the deployer address and any address with code. It also checks that the transfer succeeded:

```ts
// The project's hardhat.config.ts loads these plugins' types; the imports make the file stand alone.
import "@nomicfoundation/hardhat-viem";
import "hardhat-kms";
import hre from "hardhat";
import {
  WaitForTransactionReceiptTimeoutError,
  formatEther,
  isAddress,
  isAddressEqual,
  zeroAddress,
} from "viem";

/**
 * Sends the deployer's balance, less the fee, to RETURN_TO.
 *
 * @returns Why it stopped without returning the funds, or nothing once the funds are returned.
 */
async function returnFunds(): Promise<string | undefined> {
  const to = process.env.RETURN_TO;
  if (to === undefined || to === "") {
    return "set RETURN_TO to the address that gets the funds";
  }
  if (!isAddress(to)) {
    return `RETURN_TO is not a valid address, or its checksum is wrong: ${to}`;
  }
  if (isAddressEqual(to, zeroAddress)) {
    return "RETURN_TO is the zero address, and funds sent there are lost";
  }

  // The address pinned on the deployer key in hardhat.config.ts.
  const from = hre.config.kms.keys["deployer"]?.address;
  if (from === undefined || !isAddress(from)) {
    return "pin the deployer key's address in hardhat.config.ts first";
  }
  if (isAddressEqual(to, from)) {
    return `RETURN_TO is the deployer address ${from}; set it to the address that gets the funds`;
  }

  const { viem } = await hre.network.create("sepolia");
  const wallets = await viem.getWalletClients();
  if (!wallets.some((wallet) => isAddressEqual(wallet.account.address, from))) {
    return `${from} is not an account of the sepolia network; check its kmsAccounts`;
  }
  const wallet = await viem.getWalletClient(from);
  const publicClient = await viem.getPublicClient();

  // A plain transfer with 21,000 gas runs out of gas at an address with code, and the funds stay.
  if ((await publicClient.getCode({ address: to })) !== undefined) {
    return `${to} has code, so it is a contract or a smart account (EIP-7702); send to an address with no code`;
  }

  const balance = await publicClient.getBalance({ address: from });
  const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
  const value = balance - 21_000n * maxFeePerGas;
  if (value <= 0n) {
    return `the balance of ${from}, ${formatEther(balance)} ETH, does not cover the fee`;
  }

  console.log(`sending ${formatEther(value)} ETH from ${from} to ${to}`);
  const hash = await wallet.sendTransaction({
    to,
    value,
    gas: 21_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  // viem waits up to 3 minutes for the receipt, then throws this error.
  const receipt = await publicClient.waitForTransactionReceipt({ hash }).catch((error: unknown) => {
    if (error instanceof WaitForTransactionReceiptTimeoutError) {
      return undefined;
    }
    throw error;
  });
  if (receipt === undefined) {
    return `the transfer ${hash} is not confirmed yet and may still go through; look it up on a Sepolia explorer before you run the script again`;
  }
  if (receipt.status !== "success") {
    return `the transfer reverted in ${hash}; only the fee was spent, and the rest is still at ${from}`;
  }
  console.log(`sent in ${hash}`);
  return undefined;
}

const stopped = await returnFunds();
if (stopped !== undefined) {
  console.error(stopped);
  process.exitCode = 1;
}
```

## 3. Run it

Set `RETURN_TO` to an address with no code, such as your own wallet's, and run the script:

```sh
RETURN_TO=<return address> npx hardhat run scripts/return-funds.ts
```

It prints the amount and the transaction hash:

```text
sending … ETH from <deployer address> to <return address>
sent in <transaction hash>
```

A tiny amount stays behind, between 0.0000015 and 0.0000056 ETH in the tutorials' recorded runs, because the script reserves the fee at the highest price the transaction may pay. Run it again and the script stops with `the balance of <deployer address>, … ETH, does not cover the fee` and sends nothing.

Before you remove the key, open the deployer address on [Sepolia Etherscan](https://sepolia.etherscan.io) or [Sepolia Blockscout](https://eth-sepolia.blockscout.com) and check that its balance is close to zero.

## What the script refuses

When the script stops, it prints one line and exits with code 1. It checks everything in this table before it sends anything:

| Message                                                                                          | Cause                                                                                                     |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `set RETURN_TO to the address that gets the funds`                                               | `RETURN_TO` is not set, or is empty.                                                                      |
| `RETURN_TO is not a valid address, or its checksum is wrong: …`                                  | Not 40 hex digits, or a mixed-case address whose checksum does not match.                                 |
| `RETURN_TO is the zero address, and funds sent there are lost`                                   | `RETURN_TO` is `0x0000000000000000000000000000000000000000`.                                              |
| `pin the deployer key's address in hardhat.config.ts first`                                      | The `deployer` key has no `address`.                                                                      |
| `RETURN_TO is the deployer address …; set it to the address that gets the funds`                 | `RETURN_TO` is the address the funds come from.                                                           |
| `… is not an account of the sepolia network; check its kmsAccounts`                              | The `sepolia` network has no account at the pinned address: it does not list `deployer` in `kmsAccounts`. |
| `… has code, so it is a contract or a smart account (EIP-7702); send to an address with no code` | `RETURN_TO` is a contract, or a wallet address whose smart account setting is on.                         |
| `the balance of …, … ETH, does not cover the fee`                                                | The balance is at most the fee, as after a first run.                                                     |

The script sends a plain transfer with 21,000 gas, which runs out of gas at an address with code, so it refuses a contract. A wallet address whose smart account setting is on has code too ([EIP-7702](https://eips.ethereum.org/EIPS/eip-7702)). If the script refuses your wallet address for that reason, use another account of the wallet with the setting off, or create a new account in the wallet.

After it sends, two more lines can stop it:

- `the transfer reverted in <transaction hash>; only the fee was spent, and the rest is still at <deployer address>`. Run the script again with another address that has no code.
- `the transfer <transaction hash> is not confirmed yet and may still go through; look it up on a Sepolia explorer before you run the script again`. The transfer was not mined within 3 minutes, viem's limit for the receipt. It was sent, and once it is mined, the funds are returned.

An integration test runs this script, as it appears on this page, with `hardhat run` against a local `hardhat node`: each refusal of `RETURN_TO`, a reverted transfer, a transfer that is not mined in time, a full transfer and a second run.
