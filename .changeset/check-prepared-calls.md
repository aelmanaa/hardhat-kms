---
"hardhat-kms": minor
---

The new `hardhat-kms/alchemy` entry point exports `checkPreparedCalls`. It checks what `prepareCalls` of `@alchemy/wallet-apis` returned before a KMS key signs it. It recomputes the EntryPoint v0.7 user operation hash with your chain id and decodes the Modular Account v2 calls. It refuses the response unless the calls match yours exactly, the sender is the key's address, the signature request is `personal_sign` over that hash, a paymaster pays when a policy is set, and any EIP-7702 authorization names your pinned delegate without re-delegating the account. Each refusal has an error in the catalogue under `core.alchemy`. The entry point needs viem, as `connection.kms.getAccount` does.

Issue: [#495](https://github.com/aelmanaa/hardhat-kms/issues/495)
