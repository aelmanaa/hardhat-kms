# Live proof

Audience: contributors and reviewers who want on-chain evidence that the plugin signs with real KMS keys.

Status: M9. The latest run of the live suite on Sepolia ([#44](https://github.com/aelmanaa/hardhat-kms/issues/44)), with AWS KMS, Google Cloud KMS and Azure Key Vault keys.

## Run

| Field      | Value                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------- |
| Date       | 2026-10-01, blocks mined from 19:06:24 to 19:07:48 UTC                                              |
| Commit     | `16cbd7a` (`test: pin live state checks to the receipt's block`), on the branch that adds the suite |
| Chain id   | 11155111 (Sepolia)                                                                                  |
| Blocks     | 11823789 to 11823796                                                                                |
| Command    | `pnpm run test:live`                                                                                |
| Providers  | AWS KMS, Google Cloud KMS and Azure Key Vault, in parallel                                          |
| Result     | 16 tests passed, 0 failed, 0 skipped                                                                |
| Gas prices | 2 gwei for the legacy and EIP-2930 transactions; 0.98 to 1.12 gwei effective for the others         |

Every transaction below was signed by the provider's KMS key through the plugin. The suite waited for each receipt and checked status 1, the KMS account as `from`, and the transaction type. After the run, each receipt was read again from the RPC and matched: status, type, sender, block and, for the EIP-7702 transactions, the authorization's address. The legacy transactions' `v` values (22310258 for AWS and Google Cloud, 22310257 for Azure) carry chain id 11155111 (EIP-155).

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
- `LiveCheck`: [`0x82514318411770813B9FAEB166EeBccd2C77415a`](https://sepolia.etherscan.io/address/0x82514318411770813B9FAEB166EeBccd2C77415a)
- Spent: 0.00102504703218161 ETH

| Step                                 | Type              | Block    | Transaction                                                                                                                                                                |
| ------------------------------------ | ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deploy `LiveCheck`                   | EIP-1559 (type 2) | 11823789 | [`0xecbffeb0caa46b29634eaedd97aa5af32009fd38e11c5f67cb8076c639992b13`](https://sepolia.etherscan.io/tx/0xecbffeb0caa46b29634eaedd97aa5af32009fd38e11c5f67cb8076c639992b13) |
| `add(1)`                             | Legacy (type 0)   | 11823790 | [`0x8d41489bb43e99fbe1810dfc5fcb988aa21aeee455de0a764b033604d9c6d6e5`](https://sepolia.etherscan.io/tx/0x8d41489bb43e99fbe1810dfc5fcb988aa21aeee455de0a764b033604d9c6d6e5) |
| `add(1)` with an access list         | EIP-2930 (type 1) | 11823791 | [`0x4b8a0b2361b8ef05a5c73c395a9f2d2cb96ad0a2010a9d3e63eaa4ad28ca9fdc`](https://sepolia.etherscan.io/tx/0x4b8a0b2361b8ef05a5c73c395a9f2d2cb96ad0a2010a9d3e63eaa4ad28ca9fdc) |
| `add(1)`                             | EIP-1559 (type 2) | 11823792 | [`0x0411bad9027e9d9235cf2e9576873cfa31f7c7ab94348cc3a31cc667442a4c97`](https://sepolia.etherscan.io/tx/0x0411bad9027e9d9235cf2e9576873cfa31f7c7ab94348cc3a31cc667442a4c97) |
| delegate to `LiveCheck` and `add(1)` | EIP-7702 (type 4) | 11823794 | [`0xbf01d1f32e319ba0909c89e961668b959c6107213ac9beca75b099a66ec27a2c`](https://sepolia.etherscan.io/tx/0xbf01d1f32e319ba0909c89e961668b959c6107213ac9beca75b099a66ec27a2c) |
| clear the delegation                 | EIP-7702 (type 4) | 11823795 | [`0x0bd996950625334cc8de61f251f7832503f57b834a9235ce9ff4ca0c3dd51696`](https://sepolia.etherscan.io/tx/0x0bd996950625334cc8de61f251f7832503f57b834a9235ce9ff4ca0c3dd51696) |
| send 1 wei to itself                 | EIP-1559 (type 2) | 11823796 | [`0x9bbe04bd3442a31ef28cc178d3b1e8694996a13ee1aec0c7922de770b3a7c125`](https://sepolia.etherscan.io/tx/0x9bbe04bd3442a31ef28cc178d3b1e8694996a13ee1aec0c7922de770b3a7c125) |

## Google Cloud KMS

- Account: [`0x728743B36DE6236f6d03409563a7E2c39a00EE17`](https://sepolia.etherscan.io/address/0x728743B36DE6236f6d03409563a7E2c39a00EE17)
- `LiveCheck`: [`0x3fe50B6296ed165bb91fDe6F4eA08203c7260FBf`](https://sepolia.etherscan.io/address/0x3fe50B6296ed165bb91fDe6F4eA08203c7260FBf)
- Spent: 0.00102504703218161 ETH

| Step                                 | Type              | Block    | Transaction                                                                                                                                                                |
| ------------------------------------ | ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deploy `LiveCheck`                   | EIP-1559 (type 2) | 11823789 | [`0x1aca8b634fb8c643992786e374a7a133f49541c472eaf835a62d92f33d3ba239`](https://sepolia.etherscan.io/tx/0x1aca8b634fb8c643992786e374a7a133f49541c472eaf835a62d92f33d3ba239) |
| `add(1)`                             | Legacy (type 0)   | 11823790 | [`0x22678a876fdfe0d38a7c629fc8659fb24a553c4aebc808a583c815f6d771f4e9`](https://sepolia.etherscan.io/tx/0x22678a876fdfe0d38a7c629fc8659fb24a553c4aebc808a583c815f6d771f4e9) |
| `add(1)` with an access list         | EIP-2930 (type 1) | 11823791 | [`0x91fae3a20b72ab077eca81b6309ae9b5da16117598c0bad9362001a57083bfc9`](https://sepolia.etherscan.io/tx/0x91fae3a20b72ab077eca81b6309ae9b5da16117598c0bad9362001a57083bfc9) |
| `add(1)`                             | EIP-1559 (type 2) | 11823792 | [`0x80c42c7cced20ec6b959c1b2452b71f0393fda501b4a1ad5c164034c08ef52c4`](https://sepolia.etherscan.io/tx/0x80c42c7cced20ec6b959c1b2452b71f0393fda501b4a1ad5c164034c08ef52c4) |
| delegate to `LiveCheck` and `add(1)` | EIP-7702 (type 4) | 11823794 | [`0x2c01f45e877b90b1bf7fe58c299a147f96178c384b8989c2f64aa470c4d268a8`](https://sepolia.etherscan.io/tx/0x2c01f45e877b90b1bf7fe58c299a147f96178c384b8989c2f64aa470c4d268a8) |
| clear the delegation                 | EIP-7702 (type 4) | 11823795 | [`0xe86161e466c917354c1cfaa46bb90b0bef4e1faeb4174f725d9c9d1b9f9fe7ae`](https://sepolia.etherscan.io/tx/0xe86161e466c917354c1cfaa46bb90b0bef4e1faeb4174f725d9c9d1b9f9fe7ae) |
| send 1 wei to itself                 | EIP-1559 (type 2) | 11823796 | [`0x6fce8c498de02068e7f12302db6b3130aaf0b7ac35fcca056fd6e7f703640e50`](https://sepolia.etherscan.io/tx/0x6fce8c498de02068e7f12302db6b3130aaf0b7ac35fcca056fd6e7f703640e50) |

## Azure Key Vault

- Account: [`0x9626Fb8498C69d88F8C080835C3Cd328453D3004`](https://sepolia.etherscan.io/address/0x9626Fb8498C69d88F8C080835C3Cd328453D3004)
- `LiveCheck`: [`0xfE9F3d190E92d12D7f374eeBfff5d8eC48c1C760`](https://sepolia.etherscan.io/address/0xfE9F3d190E92d12D7f374eeBfff5d8eC48c1C760)
- Spent: 0.00102504703218161 ETH

| Step                                 | Type              | Block    | Transaction                                                                                                                                                                |
| ------------------------------------ | ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deploy `LiveCheck`                   | EIP-1559 (type 2) | 11823789 | [`0x33e0c30f9ceea5d22ebf4b338c90b9cfb34a00704125731b87d6c81764abc19c`](https://sepolia.etherscan.io/tx/0x33e0c30f9ceea5d22ebf4b338c90b9cfb34a00704125731b87d6c81764abc19c) |
| `add(1)`                             | Legacy (type 0)   | 11823790 | [`0x320b7750b74b6481359e4e6b0648d7077bd574ef5441db1ed8455d7bd5f3d836`](https://sepolia.etherscan.io/tx/0x320b7750b74b6481359e4e6b0648d7077bd574ef5441db1ed8455d7bd5f3d836) |
| `add(1)` with an access list         | EIP-2930 (type 1) | 11823791 | [`0x84e4a7f2527df6e5da0951125c5398ac360bb61721cdf188261073e75614c5c1`](https://sepolia.etherscan.io/tx/0x84e4a7f2527df6e5da0951125c5398ac360bb61721cdf188261073e75614c5c1) |
| `add(1)`                             | EIP-1559 (type 2) | 11823792 | [`0x5df95dccc5d302f6339fdca4f95bba372e71857225bc1e3021538b227d2c51ab`](https://sepolia.etherscan.io/tx/0x5df95dccc5d302f6339fdca4f95bba372e71857225bc1e3021538b227d2c51ab) |
| delegate to `LiveCheck` and `add(1)` | EIP-7702 (type 4) | 11823794 | [`0xf02445e183ef976ec6d9ca5d8a069f6d50eccdb8e970ba80c22fe4f4f2f6c221`](https://sepolia.etherscan.io/tx/0xf02445e183ef976ec6d9ca5d8a069f6d50eccdb8e970ba80c22fe4f4f2f6c221) |
| clear the delegation                 | EIP-7702 (type 4) | 11823795 | [`0xadf69a662996394da885c5e6104045899f7fd788008bec2e44d85fdfaf7f8dc5`](https://sepolia.etherscan.io/tx/0xadf69a662996394da885c5e6104045899f7fd788008bec2e44d85fdfaf7f8dc5) |
| send 1 wei to itself                 | EIP-1559 (type 2) | 11823796 | [`0x20c3c560defef0e6050ba67b6f765a63a70a5511e6ae8185be56d5554ca123a6`](https://sepolia.etherscan.io/tx/0x20c3c560defef0e6050ba67b6f765a63a70a5511e6ae8185be56d5554ca123a6) |

The three providers together spent 0.00307514109654483 ETH.
