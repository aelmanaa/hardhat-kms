# 0002: Fill transactions in the plugin

Status: Accepted

## Context

Hardhat runs plugin network hooks before its built-in request handlers. The built-in handlers are the ones that fill a transaction's nonce, gas, fees and chain id. A plugin that intercepts `eth_sendTransaction` therefore sees an unfilled transaction, and Hardhat does not export its filler.

## Decision

Port Hardhat's fill logic into `rpc/transaction-filler.ts`, behind a `TransactionFiller` interface and pinned to a Hardhat commit. Build the signed transaction field for field like Hardhat's local-accounts handler.

## Consequences

- A KMS account's transactions are filled the same way as a local account's, so viem, ethers and Ignition need no special handling.
- The port can drift from Hardhat. A differential test fills the same request as a local account and through the plugin, on the minimum supported Hardhat version and on the latest, and requires the same fields and the same unsigned bytes.
- If Hardhat exports its filler or adds a post-fill signing stage, the port is deleted. The upstream proposal, [NomicFoundation/hardhat#8656](https://github.com/NomicFoundation/hardhat/issues/8656), was filed once the port existed.
