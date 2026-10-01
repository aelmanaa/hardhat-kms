# Live proof

Audience: contributors and reviewers who want on-chain evidence that the plugin signs with real KMS keys.

Status: M9. The latest run of the live suite on Sepolia ([#44](https://github.com/aelmanaa/hardhat-kms/issues/44)), with AWS KMS, Google Cloud KMS and Azure Key Vault keys.

## Run

| Field      | Value                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| Date       | 2026-10-01, blocks mined from 21:47:36 to 21:48:48 UTC                                                         |
| Commit     | `809b55a` (`test: harden the fork proxy and tie anvil to the test process`), on the branch that adds fork mode |
| Chain id   | 11155111 (Sepolia)                                                                                             |
| Blocks     | 11824595 to 11824601                                                                                           |
| Command    | `HARDHAT_KMS_LIVE_NETWORK=sepolia pnpm run test:live`                                                          |
| Providers  | AWS KMS, Google Cloud KMS and Azure Key Vault, in parallel                                                     |
| Result     | 35 tests: 34 passed, 0 failed, 1 skipped (the proxy check, which runs only in fork mode)                       |
| Gas prices | 3 gwei for the legacy and EIP-2930 transactions; 1.33 to 1.43 gwei effective for the others                    |

Every transaction below was signed by the provider's KMS key through the plugin. The suite waited for each receipt and checked status 1, the KMS account as `from`, and the transaction type. After the run, each receipt was read again from the RPC and matched: status, type, sender, block and, for the EIP-7702 transactions, the authorization's address. The legacy transactions' `v` value (22310258 for all three accounts) carries chain id 11155111 (EIP-155).

The two EIP-7702 transactions of each account are self-sent. The first delegates the account to that run's `LiveCheck` and calls `add(1)` on it; the second authorizes the zero address, which clears the delegation. The same key signed both authorizations through the core signer. After the clear, a 1 wei transfer from the account to itself succeeded, and none of the three accounts has code:

```sh
cast code 0x0b545a5a4cA04252184A7813D0D4D3fBA31Af2fd --rpc-url https://ethereum-sepolia-rpc.publicnode.com
# -> 0x
cast code 0x728743B36DE6236f6d03409563a7E2c39a00EE17 --rpc-url https://ethereum-sepolia-rpc.publicnode.com
# -> 0x
cast code 0x9626Fb8498C69d88F8C080835C3Cd328453D3004 --rpc-url https://ethereum-sepolia-rpc.publicnode.com
# -> 0x
```

Slot 0 of each account's storage still holds the count that the delegated `add` calls wrote; clearing a delegation does not reset storage.

The `personal_sign` and `eth_signTypedData_v4` signatures are checked with `eth_call`: `LiveCheck` rebuilds the EIP-191 and EIP-712 digests on chain and recovers the KMS account with `ecrecover`. These checks send no transaction, so they have no hash.

The amounts spent are the sum of `gasUsed × effectiveGasPrice` over each account's receipts; the 1 wei transfer goes back to the same account.

## AWS KMS

- Account: [`0x0b545a5a4cA04252184A7813D0D4D3fBA31Af2fd`](https://sepolia.etherscan.io/address/0x0b545a5a4cA04252184A7813D0D4D3fBA31Af2fd)
- `LiveCheck`: [`0xfCf784480EAC2e7b2b816f8affb8e2d1dD6Cb20C`](https://sepolia.etherscan.io/address/0xfCf784480EAC2e7b2b816f8affb8e2d1dD6Cb20C)
- Spent: 0.00134478221061743 ETH

| Step                                 | Type              | Block    | Transaction                                                                                                                                                                |
| ------------------------------------ | ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deploy `LiveCheck`                   | EIP-1559 (type 2) | 11824595 | [`0xb2310a931050a5ad16dd8b62596bc24db09e7cd91fe588b3191c7f34d4fff9df`](https://sepolia.etherscan.io/tx/0xb2310a931050a5ad16dd8b62596bc24db09e7cd91fe588b3191c7f34d4fff9df) |
| `add(1)`                             | Legacy (type 0)   | 11824596 | [`0xde4da390ee2443eeade08d097768c709662679b41620be6ad29e5fc1a505090d`](https://sepolia.etherscan.io/tx/0xde4da390ee2443eeade08d097768c709662679b41620be6ad29e5fc1a505090d) |
| `add(1)` with an access list         | EIP-2930 (type 1) | 11824597 | [`0x62d78c014a39600ac9d9f8dc39b6659f49023fd3bd2a16bd7d605404f313e91c`](https://sepolia.etherscan.io/tx/0x62d78c014a39600ac9d9f8dc39b6659f49023fd3bd2a16bd7d605404f313e91c) |
| `add(1)`                             | EIP-1559 (type 2) | 11824598 | [`0xb15e8650241279ea465c3eee70acc1c838e01fc27b4bd338def9f9a17e978808`](https://sepolia.etherscan.io/tx/0xb15e8650241279ea465c3eee70acc1c838e01fc27b4bd338def9f9a17e978808) |
| delegate to `LiveCheck` and `add(1)` | EIP-7702 (type 4) | 11824599 | [`0xdca2fa457e3eba434622bd1972ad9e02bffb54d2c7fbc87d73dbc8c0e02cf348`](https://sepolia.etherscan.io/tx/0xdca2fa457e3eba434622bd1972ad9e02bffb54d2c7fbc87d73dbc8c0e02cf348) |
| clear the delegation                 | EIP-7702 (type 4) | 11824600 | [`0x806e5548fc975aaf2d6483e96b951215167f107caaafade4b636f41ca41e1f0e`](https://sepolia.etherscan.io/tx/0x806e5548fc975aaf2d6483e96b951215167f107caaafade4b636f41ca41e1f0e) |
| send 1 wei to itself                 | EIP-1559 (type 2) | 11824601 | [`0xa1e4212987eceaf54af068b3895b220f7418e5a7b0f0fc51f1cb3a6bb0f3ecf2`](https://sepolia.etherscan.io/tx/0xa1e4212987eceaf54af068b3895b220f7418e5a7b0f0fc51f1cb3a6bb0f3ecf2) |

## Google Cloud KMS

- Account: [`0x728743B36DE6236f6d03409563a7E2c39a00EE17`](https://sepolia.etherscan.io/address/0x728743B36DE6236f6d03409563a7E2c39a00EE17)
- `LiveCheck`: [`0x359d6F0F102673097231EA618A8A8dc746A73D1f`](https://sepolia.etherscan.io/address/0x359d6F0F102673097231EA618A8A8dc746A73D1f)
- Spent: 0.00134478221061743 ETH

| Step                                 | Type              | Block    | Transaction                                                                                                                                                                |
| ------------------------------------ | ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deploy `LiveCheck`                   | EIP-1559 (type 2) | 11824595 | [`0xcb1e0f5d2c52fd60d208ffca47cfcd01d043d8beb73d852eebc6fa302b811834`](https://sepolia.etherscan.io/tx/0xcb1e0f5d2c52fd60d208ffca47cfcd01d043d8beb73d852eebc6fa302b811834) |
| `add(1)`                             | Legacy (type 0)   | 11824596 | [`0xebaa237baccac25f4796131367494ec5cd8fbacdbb5a4a090c7eaf1bda46653c`](https://sepolia.etherscan.io/tx/0xebaa237baccac25f4796131367494ec5cd8fbacdbb5a4a090c7eaf1bda46653c) |
| `add(1)` with an access list         | EIP-2930 (type 1) | 11824597 | [`0xd6ab8d7747a544c16a1da18c3f50999dcec55a44fb1cfac38d6f35f50be8ae06`](https://sepolia.etherscan.io/tx/0xd6ab8d7747a544c16a1da18c3f50999dcec55a44fb1cfac38d6f35f50be8ae06) |
| `add(1)`                             | EIP-1559 (type 2) | 11824598 | [`0xb85b525419b5a2ef0922baa66f55184c8b13364f52ce901f39912233193c6bcd`](https://sepolia.etherscan.io/tx/0xb85b525419b5a2ef0922baa66f55184c8b13364f52ce901f39912233193c6bcd) |
| delegate to `LiveCheck` and `add(1)` | EIP-7702 (type 4) | 11824599 | [`0xd3b6a2c434b9d20bfa37a93d206bfb04bf523d1ee1bdb4585217f3b4c6c74557`](https://sepolia.etherscan.io/tx/0xd3b6a2c434b9d20bfa37a93d206bfb04bf523d1ee1bdb4585217f3b4c6c74557) |
| clear the delegation                 | EIP-7702 (type 4) | 11824600 | [`0xd780c84516b662ea0743b6a3e3a943c04f06c3d77e88d957ef64761a56f2fb80`](https://sepolia.etherscan.io/tx/0xd780c84516b662ea0743b6a3e3a943c04f06c3d77e88d957ef64761a56f2fb80) |
| send 1 wei to itself                 | EIP-1559 (type 2) | 11824601 | [`0x4a546baba9299a2d9c63e7e7d392be9449532bbad08264ed3c4a098b4547f9ee`](https://sepolia.etherscan.io/tx/0x4a546baba9299a2d9c63e7e7d392be9449532bbad08264ed3c4a098b4547f9ee) |

## Azure Key Vault

- Account: [`0x9626Fb8498C69d88F8C080835C3Cd328453D3004`](https://sepolia.etherscan.io/address/0x9626Fb8498C69d88F8C080835C3Cd328453D3004)
- `LiveCheck`: [`0x0651514b24F5c788720A51768e952584665F22e3`](https://sepolia.etherscan.io/address/0x0651514b24F5c788720A51768e952584665F22e3)
- Spent: 0.00134478221061743 ETH

| Step                                 | Type              | Block    | Transaction                                                                                                                                                                |
| ------------------------------------ | ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deploy `LiveCheck`                   | EIP-1559 (type 2) | 11824595 | [`0x7ea234804e8f8215ba411c0365f9734719749ea1203454c738f240053d12d188`](https://sepolia.etherscan.io/tx/0x7ea234804e8f8215ba411c0365f9734719749ea1203454c738f240053d12d188) |
| `add(1)`                             | Legacy (type 0)   | 11824596 | [`0x33ec995470f2d9ed33f4866b13665fef097e366c6244695ae870bcb55e8a3e1f`](https://sepolia.etherscan.io/tx/0x33ec995470f2d9ed33f4866b13665fef097e366c6244695ae870bcb55e8a3e1f) |
| `add(1)` with an access list         | EIP-2930 (type 1) | 11824597 | [`0x2072d36ac4889086fee802c697410f5e27fa115c2f9777b17aefd619f714fbbe`](https://sepolia.etherscan.io/tx/0x2072d36ac4889086fee802c697410f5e27fa115c2f9777b17aefd619f714fbbe) |
| `add(1)`                             | EIP-1559 (type 2) | 11824598 | [`0xc684b2ec854b02a5b2e62d951d78a57609e3b91b7a81d53adb9af1e285362582`](https://sepolia.etherscan.io/tx/0xc684b2ec854b02a5b2e62d951d78a57609e3b91b7a81d53adb9af1e285362582) |
| delegate to `LiveCheck` and `add(1)` | EIP-7702 (type 4) | 11824599 | [`0x692a0c580100019d63797b2ef88a257cb12febacaa10e92b5b25271a652bfa57`](https://sepolia.etherscan.io/tx/0x692a0c580100019d63797b2ef88a257cb12febacaa10e92b5b25271a652bfa57) |
| clear the delegation                 | EIP-7702 (type 4) | 11824600 | [`0x0003b56fb586c155d7657da068be2c879d684e9f4d693fddd33eb0ed5edee0c5`](https://sepolia.etherscan.io/tx/0x0003b56fb586c155d7657da068be2c879d684e9f4d693fddd33eb0ed5edee0c5) |
| send 1 wei to itself                 | EIP-1559 (type 2) | 11824601 | [`0x30b2c93c95ce0c1b33553350e3f96f26bc9f2a4309ef2c78abee4951c0bd99b5`](https://sepolia.etherscan.io/tx/0x30b2c93c95ce0c1b33553350e3f96f26bc9f2a4309ef2c78abee4951c0bd99b5) |

The three providers together spent 0.00403434663185229 ETH.
