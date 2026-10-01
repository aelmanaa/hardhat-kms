# Live proof

Audience: contributors and reviewers who want on-chain evidence that the plugin signs with real KMS keys.

Status: M9. The latest run of the live suite on Sepolia ([#44](https://github.com/aelmanaa/hardhat-kms/issues/44)), with Google Cloud KMS and Azure Key Vault keys. The AWS KMS key has not run in this suite yet.

## Run

| Field     | Value                                                                                     |
| --------- | ----------------------------------------------------------------------------------------- |
| Date      | 2026-10-01, 14:11 to 14:13 UTC                                                            |
| Commit    | `ed9299f` (`test: add the live test suite on Sepolia`), on the branch that adds the suite |
| Chain id  | 11155111 (Sepolia)                                                                        |
| RPC       | the default, `https://ethereum-sepolia-rpc.publicnode.com`                                |
| Gas price | about 1.02 gwei                                                                           |
| Command   | `pnpm run test:live`                                                                      |
| Providers | Google Cloud KMS and Azure Key Vault, in parallel; AWS KMS skipped                        |

Every transaction below was signed by the provider's KMS key through the plugin. The suite waited for each receipt and checked status 1, the KMS account as `from`, and the transaction type. The legacy transactions' `v` values, 22310258 and 22310257, carry chain id 11155111 (EIP-155). The receipts, types and authorizations were read again from the RPC after the run.

The two EIP-7702 transactions are self-sent. The first delegates the account to that run's `LiveCheck` and calls `add(1)` on it; the second authorizes the zero address, which clears the delegation. The same key signed both authorizations through the core signer. After the clear, a 1 wei transfer from the account to itself succeeded, and both accounts have no code:

```sh
cast code 0x728743B36DE6236f6d03409563a7E2c39a00EE17 --rpc-url https://ethereum-sepolia-rpc.publicnode.com
# -> 0x
cast code 0x9626Fb8498C69d88F8C080835C3Cd328453D3004 --rpc-url https://ethereum-sepolia-rpc.publicnode.com
# -> 0x
```

Both accounts started this run delegated to the `LiveCheck` of an earlier run of the suite, before it cleared its delegations. Slot 0 of each account's storage still holds the count that the delegated `add` calls wrote.

The `personal_sign` and `eth_signTypedData_v4` signatures are checked with `eth_call`: `LiveCheck` rebuilds the EIP-191 and EIP-712 digests on chain and recovers the KMS account with `ecrecover`. These checks send no transaction, so they have no hash.

## Google Cloud KMS

- Account: [`0x728743B36DE6236f6d03409563a7E2c39a00EE17`](https://sepolia.etherscan.io/address/0x728743B36DE6236f6d03409563a7E2c39a00EE17)
- `LiveCheck`: [`0x8aa003E2B90de0D35c98C8CA1C15eC31e8ddfAFf`](https://sepolia.etherscan.io/address/0x8aa003E2B90de0D35c98C8CA1C15eC31e8ddfAFf)
- Spent: 0.00100677622906374 ETH

| Step                                 | Type              | Block    | Transaction                                                                                                                                                                |
| ------------------------------------ | ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deploy `LiveCheck`                   | EIP-1559 (type 2) | 11822336 | [`0xad1589cca97ac0e546a3b59afdfc0cd5a34f4183631afa9f34689bc14e7ad25c`](https://sepolia.etherscan.io/tx/0xad1589cca97ac0e546a3b59afdfc0cd5a34f4183631afa9f34689bc14e7ad25c) |
| `add(1)`                             | Legacy (type 0)   | 11822339 | [`0xad47903089fae8c78c18592eddc39ef1e32464eb8292c4688b7edd2e826debc7`](https://sepolia.etherscan.io/tx/0xad47903089fae8c78c18592eddc39ef1e32464eb8292c4688b7edd2e826debc7) |
| `add(1)` with an access list         | EIP-2930 (type 1) | 11822341 | [`0xcaf79fb3f2f70baecb8a7b79e3144d4579ca9c1b6ad3957a612641fd77bbb8aa`](https://sepolia.etherscan.io/tx/0xcaf79fb3f2f70baecb8a7b79e3144d4579ca9c1b6ad3957a612641fd77bbb8aa) |
| `add(1)`                             | EIP-1559 (type 2) | 11822342 | [`0x7b3e2d1ebf8a052486a68d606437d432597182b203588e2ea0580ba235a36a4e`](https://sepolia.etherscan.io/tx/0x7b3e2d1ebf8a052486a68d606437d432597182b203588e2ea0580ba235a36a4e) |
| delegate to `LiveCheck` and `add(1)` | EIP-7702 (type 4) | 11822343 | [`0x79d024caab3b4e3f65a6024d6890670126d39811e70574409a8e1611da060875`](https://sepolia.etherscan.io/tx/0x79d024caab3b4e3f65a6024d6890670126d39811e70574409a8e1611da060875) |
| clear the delegation                 | EIP-7702 (type 4) | 11822344 | [`0x0ef3cbbe8ce453c042c497a83a79cf33a2e5451bed4a638fd56a589dfb1fe694`](https://sepolia.etherscan.io/tx/0x0ef3cbbe8ce453c042c497a83a79cf33a2e5451bed4a638fd56a589dfb1fe694) |
| send 1 wei to itself                 | EIP-1559 (type 2) | 11822345 | [`0xf54512273b2e969a8fffa2dd201ad6db33e86ecf8d813c81759b8a85e58dd475`](https://sepolia.etherscan.io/tx/0xf54512273b2e969a8fffa2dd201ad6db33e86ecf8d813c81759b8a85e58dd475) |

## Azure Key Vault

- Account: [`0x9626Fb8498C69d88F8C080835C3Cd328453D3004`](https://sepolia.etherscan.io/address/0x9626Fb8498C69d88F8C080835C3Cd328453D3004)
- `LiveCheck`: [`0x6A58C690dffD2a9364F4e8520ae5AcAE629C17E2`](https://sepolia.etherscan.io/address/0x6A58C690dffD2a9364F4e8520ae5AcAE629C17E2)
- Spent: 0.00100677622906374 ETH

| Step                                 | Type              | Block    | Transaction                                                                                                                                                                |
| ------------------------------------ | ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deploy `LiveCheck`                   | EIP-1559 (type 2) | 11822336 | [`0xcde13600fe9507d9324826f72a9656d3c4147ddabfd973c244b77b00c522270b`](https://sepolia.etherscan.io/tx/0xcde13600fe9507d9324826f72a9656d3c4147ddabfd973c244b77b00c522270b) |
| `add(1)`                             | Legacy (type 0)   | 11822339 | [`0x31ea2ea3b0fd928d3f40ab0cee1d45d56607174139ff6b3b1aae1e720b28006d`](https://sepolia.etherscan.io/tx/0x31ea2ea3b0fd928d3f40ab0cee1d45d56607174139ff6b3b1aae1e720b28006d) |
| `add(1)` with an access list         | EIP-2930 (type 1) | 11822341 | [`0x8469d5c5f09bd7551cc3601700236a30c89912999bf213c6a763118bee712f22`](https://sepolia.etherscan.io/tx/0x8469d5c5f09bd7551cc3601700236a30c89912999bf213c6a763118bee712f22) |
| `add(1)`                             | EIP-1559 (type 2) | 11822342 | [`0x9953caae34d6464c170737aea5dfa0a57092935ce040deb556b5832af265280f`](https://sepolia.etherscan.io/tx/0x9953caae34d6464c170737aea5dfa0a57092935ce040deb556b5832af265280f) |
| delegate to `LiveCheck` and `add(1)` | EIP-7702 (type 4) | 11822343 | [`0xfe2267a42e2d4b1702b583c5516b40bfe3fcc6373bb966640efeea365658d8a3`](https://sepolia.etherscan.io/tx/0xfe2267a42e2d4b1702b583c5516b40bfe3fcc6373bb966640efeea365658d8a3) |
| clear the delegation                 | EIP-7702 (type 4) | 11822344 | [`0xba43bd81db5a59e1c9a68c5bed1eb0ca8b9bed284354697224bd9819f7fb8abb`](https://sepolia.etherscan.io/tx/0xba43bd81db5a59e1c9a68c5bed1eb0ca8b9bed284354697224bd9819f7fb8abb) |
| send 1 wei to itself                 | EIP-1559 (type 2) | 11822345 | [`0x3977babac08c7466e2d398dde0e8c7f021a37e44ad98251db69fa89bbaadd416`](https://sepolia.etherscan.io/tx/0x3977babac08c7466e2d398dde0e8c7f021a37e44ad98251db69fa89bbaadd416) |

The two providers together spent 0.00201355245812748 ETH.
