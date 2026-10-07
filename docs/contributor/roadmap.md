# Roadmap

Audience: Anyone who wants to know what ships in 1.0 and what comes after.

Status: the [GitHub milestones](https://github.com/aelmanaa/hardhat-kms/milestones) track the work; this page gives the themes.

## 1.0

- The signing core: every signature is verified against the key, and an address pin refuses a key that is not the one expected.
- AWS KMS, Google Cloud KMS and Azure Key Vault, each as its own package.
- Accounts, messages, typed data and every transaction type through the network hook, so `hardhat-viem`, `hardhat-ethers`, Ignition and scripts sign with a KMS key without code changes.
- The `--kms` option, which takes a key from Foundry's environment variables without a config entry.
- The `kms` tasks: `accounts`, `address`, `public-key`, `sign`, `sign-tx`, `sign-auth` and `verify`.
- `connection.kms.getAccount` for viem: a local account backed by a KMS key, for library code.
- `kms history`: a key's sign events, read from the provider's audit log.
- Live tests on Sepolia with the three providers, with the [live proof](../live-proof.md) they write.

## After 1.0

From 1.0, everything a provider implements, receives or augments in `hardhat-kms/types` is stable: `KmsKeyAdapter`, `SignContext`, `KeyDescription`, `SignatureOutput`, `TypedData`, the resolved key types (`KmsKeyConfig`, `KmsKeyCommonConfig`, `ExternalKmsKeyConfig`, `KmsIdentifier`), the `KmsProviderUserConfigs` and `KmsProviderConfigs` interfaces with `KmsKeyCommonUserConfig`, the `kms.audit` config (`KmsAuditConfig`), the `kms` hook and the history reader types. A minor release may add optional members to them, a method to the `kms` hook, or a built-in provider to the two provider config interfaces; this is how the Turnkey and Fireblocks providers will add `signTransaction`, `sendTransaction` and their key types. Changing or removing a member needs a major. `hardhat-kms/provider-utils` stays experimental. The [provider contract](providers.md#provider-contract) has the details.

| Release | Theme                                                                                                                                                                                                                                                                                                                     | Milestone                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| v1.1    | An Alchemy Wallet APIs recipe in the docs.                                                                                                                                                                                                                                                                                | [v1.1](https://github.com/aelmanaa/hardhat-kms/milestone/12)   |
| v1.2    | Turnkey provider: an address-pinned adapter with no public-key call. It returns `{r, s, v}`, which the core re-normalizes and verifies. It can use the structured `signTransaction`/`signTypedData` so Turnkey policies see the full request. `TURNKEY_API_PRIVATE_KEY` must be a config variable and is never displayed. | [v1.2](https://github.com/aelmanaa/hardhat-kms/milestone/13)   |
| v1.3    | Fireblocks provider, with `broadcast` and `raw` modes.                                                                                                                                                                                                                                                                    | [v1.3](https://github.com/aelmanaa/hardhat-kms/milestone/14)   |
| Later   | An Alchemy or smart-account send mode; a PKCS#11 HSM provider.                                                                                                                                                                                                                                                            | [Future](https://github.com/aelmanaa/hardhat-kms/milestone/15) |

A PKCS#11 HSM fits the adapter contract: its raw r‖s output is what the core expects. HashiCorp Vault transit is not a candidate, because it has no secp256k1 support.

Upstream, the project proposes that Hardhat export its transaction filler or add a post-fill signing stage. If Hardhat accepts, the ported fill logic goes away. The proposal is filed as [NomicFoundation/hardhat#8656](https://github.com/NomicFoundation/hardhat/issues/8656), with an implementation in [NomicFoundation/hardhat#8657](https://github.com/NomicFoundation/hardhat/pull/8657), and waits on the Hardhat maintainers ([#27](https://github.com/aelmanaa/hardhat-kms/issues/27)).
