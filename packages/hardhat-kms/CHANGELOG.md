# hardhat-kms

## 1.4.1

### Patch Changes

- [#633](https://github.com/aelmanaa/hardhat-kms/pull/633) [`4609f97`](https://github.com/aelmanaa/hardhat-kms/commit/4609f9754b9f30200ed2eb9cc6ff416872f5f460) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The README on npm shows the Hardhat plugin badge: hardhat-kms is listed on Hardhat's community plugins page.

## 1.4.0

### Minor Changes

- [#616](https://github.com/aelmanaa/hardhat-kms/pull/616) [`74d2388`](https://github.com/aelmanaa/hardhat-kms/commit/74d23886a1a1a78bec325adc2f1fcc104c644588) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `kms accounts` now shows what each key may delegate its account to with an EIP-7702 authorization. When any listed key has `allowedDelegates`, a `DELEGATES` column shows `any`, `revoke only` (an empty list, which allows only the zero address) or `N listed`, and `--json` adds `allowedDelegates`, the number of entries, to those keys. A key with `allowRawDigests: true` gets a line under its row saying so, and `allowRawDigests: true` in the JSON. Entries for one KMS key that differ in either setting are no longer merged into one row. The configuration reference now says how to lock a deployer or admin key against any delegation with `allowedDelegates: []`, and the key rotation guide how to retire authorizations a key signed that nobody sent.
  
  Issue: [#564](https://github.com/aelmanaa/hardhat-kms/issues/564)

### Patch Changes

- [#606](https://github.com/aelmanaa/hardhat-kms/pull/606) [`b7446c7`](https://github.com/aelmanaa/hardhat-kms/commit/b7446c7d5c105ef338013a95367a64dceeb9bec8) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `eth_sendTransaction`, `eth_signTransaction` and `kms sign-tx` now refuse an `authorizationList` without `to`, and an empty `authorizationList`, before the fee and gas requests, with `core.tx.authorization-no-to` and `core.tx.authorization-list-empty`. `kms sign-tx` refuses them before it opens the key. Before, such a request failed late with micro-eth-signer's `fields had validation errors`, or at `eth_estimateGas` with the node's message. Any other field micro-eth-signer refuses now fails with `core.tx.invalid-fields`, which names each field and its reason.
  
  Issue: [#586](https://github.com/aelmanaa/hardhat-kms/issues/586)

- [#609](https://github.com/aelmanaa/hardhat-kms/pull/609) [`a9a4a45`](https://github.com/aelmanaa/hardhat-kms/commit/a9a4a458236a07c2ec0e4fd3c850052681d11554) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `eth_sendTransaction`, `eth_signTransaction` and `kms sign-tx` now refuse an `authorizationList` that is not an array, an item of it that is not an object, and a `to` beside it that is not a 20-byte hex address, before the fee and gas requests, with `core.tx.authorization-list-not-array`, `core.tx.authorization-not-object` and `core.tx.authorization-to-not-address`. Before, such a request reached the node's fee and gas requests and then failed with a schema error. `kms sign-tx` refuses them, and `authorizationList: null`, before it opens the key.
  
  Issue: [#607](https://github.com/aelmanaa/hardhat-kms/issues/607)

- [#615](https://github.com/aelmanaa/hardhat-kms/pull/615) [`0cb9268`](https://github.com/aelmanaa/hardhat-kms/commit/0cb92683b9ec2701e11326a7d7522a6cded0d3d1) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A transaction with `data: "0x"` is now signed with no calldata, and `personal_sign` or `eth_sign` with the message `"0x"` signs the empty message. Before, when the project's `@nomicfoundation/hardhat-zod-utils` used an `@nomicfoundation/hardhat-utils` release older than 5.1.1, the plugin read `"0x"` as one zero byte: it signed calldata `0x00`, so a contract ran its `fallback` function instead of `receive`, or a one-byte message. Which `hardhat-utils` copy is installed depends on the lockfile, so the plugin now decodes these fields itself. `eth_sendTransaction`, `eth_signTransaction` and `kms sign-tx` are fixed.
  
  Issue: [#614](https://github.com/aelmanaa/hardhat-kms/issues/614)

- [#613](https://github.com/aelmanaa/hardhat-kms/pull/613) [`efa27ca`](https://github.com/aelmanaa/hardhat-kms/commit/efa27cab01f0c0c7d16e0aade3c957f63cb1a2f3) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `hardhat-kms` now accepts `@nomicfoundation/hardhat-utils` 5 as well as 4 (`^4.3.0 || ^5.0.0`), so a project on Hardhat 3.20 or later can install one copy of it instead of both majors. The `@nomicfoundation/hardhat-zod-utils` floor rises from 3.0.5 to 3.0.7, since earlier releases have no `type` in the transaction request schema that `kms sign-tx` and the transaction filler read. The `@nomicfoundation/hardhat-errors` range stays `^3.1.0`. Each floor, both majors of `hardhat-utils` included, is now tested before every release.
  
  Issue: [#587](https://github.com/aelmanaa/hardhat-kms/issues/587)

- [#605](https://github.com/aelmanaa/hardhat-kms/pull/605) [`fa7b517`](https://github.com/aelmanaa/hardhat-kms/commit/fa7b517e28dbfa53168a49ef67638a17e314b39a) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `eth_sendTransaction`, `eth_signTransaction` and a library account's `signAuthorization` and `signTransaction` now refuse an EIP-7702 authorization from a `--kms` key that is the same KMS key as a config key with `allowedDelegates`, with `core.delegate.command-line-key`. The config key can be in `kms.keys` or in any network's `kmsAccounts`. Before, a connection compared `--kms` keys only with its own network's `kmsAccounts`, so a copy of a listed key from elsewhere in the config signed with no list. An authorization to the zero address still signs, as every list allows it.
  
  Issue: [#593](https://github.com/aelmanaa/hardhat-kms/issues/593)

## 1.3.0

### Minor Changes

- [#574](https://github.com/aelmanaa/hardhat-kms/pull/574) [`a2ec3d5`](https://github.com/aelmanaa/hardhat-kms/commit/a2ec3d50a46442ee91655961515f93dd87d19bc8) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A key can now set `allowedDelegates` to limit the contracts it may delegate its account to with an EIP-7702 authorization. Each entry has an `address`, the `chains` it is allowed on or `"all"`, and an optional `label` and `codeHash`. `kms sign-auth`, a library account's `signAuthorization`, and a transaction that carries the key's own authorization refuse any other delegate before the KMS signs. A chain-0 authorization matches only entries with `chains: "all"`. With `codeHash`, the plugin reads the delegate's code from the network and refuses a mismatch. The zero address always passes. No flag overrides the list. `kms sign-auth` and `kms sign-tx` refuse a `--kms` key that is the same KMS key as a config key with `allowedDelegates`. Keys without `allowedDelegates` work as before.
  
  Resolved keys in `hre.config.kms.keys` and each network's `kmsAccounts` are now frozen. What should I do? Nothing, unless a plugin or script changes a resolved key in place. Change the user config before Hardhat loads it instead.
  
  Issue: [#562](https://github.com/aelmanaa/hardhat-kms/issues/562)

- [#572](https://github.com/aelmanaa/hardhat-kms/pull/572) [`3892d18`](https://github.com/aelmanaa/hardhat-kms/commit/3892d181b937ff20e156ed014168e16db61be0a0) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Security change. `kms sign --no-hash` now asks at a terminal before it signs a raw digest, and signs only after `y` or `yes`. A raw digest can be the hash of an EIP-7702 authorization, and the plugin cannot tell. Without a terminal, the task signs only for a key with the new `allowRawDigests: true` field and with the new `--yes` flag. `--yes` skips the question only for such a key. A declined or unanswered question fails with `core.task.raw-digest-declined` and makes no sign request. `connection.kms.getAccount(address, { rawSign: true })` now fails with `core.account.raw-sign-not-allowed` unless the key sets `allowRawDigests: true`. Keys given with `--kms` cannot set it, so their raw digests need a terminal. Turnkey sends raw digests and EIP-7702 authorizations as the same `HASH_FUNCTION_NO_OP` request, so a Turnkey policy on authorizations binds only when that request is denied, as the Turnkey setup guide now shows.
  
  What should I do? Add `allowRawDigests: true` to each key in `kms.keys` or `kmsAccounts` that signs raw digests in CI or with `rawSign`, and pass `--yes` to `kms sign --no-hash` where no terminal is attached. Leave it off every other key.
  
  Issue: [#561](https://github.com/aelmanaa/hardhat-kms/issues/561)

- [#575](https://github.com/aelmanaa/hardhat-kms/pull/575) [`cce6a8d`](https://github.com/aelmanaa/hardhat-kms/commit/cce6a8dc4dc6043fbf8dfb7e1398c24dbfb17243) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Security change. `kms sign-auth` now shows what an EIP-7702 authorization does and asks before it signs. With `--network` it reads the account's nonce and code and the delegate's code and ERC-1967 slot, and the question shows the account, the delegate with its `allowedDelegates` label, the chain (`ALL CHAINS` for chain 0), the nonce against the account's nonce, the delegate's code size and hash, and the account's current delegation. At a terminal only `y` or `yes` signs; any other answer or closed input fails with `core.task.auth-declined` and exits non-zero. The new `--yes` skips the question, but only for a delegate in the key's `allowedDelegates` or the zero address. Without a terminal the task signs only with `--yes` and such a delegate; a key without `allowedDelegates`, which includes every `--kms` key, can then only revoke. `--force` still allows chain 0 and does not skip the question. The task now refuses authorizations that cannot apply: a nonce the account has passed, a delegate that is itself delegated, a precompile delegate, and an account with contract code. It warns about a nonce far ahead, a `--nonce` a pending transaction will likely use first, a re-delegation, a proxy delegate and a delegate without code. With `--network` the task now always connects to the node.
  
  What should I do? Add the delegate to the key's `allowedDelegates` and pass `--yes` in CI. To sign without a node, use `--chain` with `--nonce`.
  
  Issue: [#563](https://github.com/aelmanaa/hardhat-kms/issues/563)

### Patch Changes

- [#592](https://github.com/aelmanaa/hardhat-kms/pull/592) [`342cda7`](https://github.com/aelmanaa/hardhat-kms/commit/342cda7df0c047ad8c29c5014236d6320f349e78) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `kms sign-auth` and `kms sign-tx` now refuse a `--kms` AWS key with the same key id or alias as a config key with `allowedDelegates`, even when the two keys set the region, profile or endpoint differently, or one of them writes the key as an ARN. Before, a config key that set its own `region` while the `--kms` key took its region from `AWS_REGION` was not refused, so the config key's list did not apply. An Azure key URL now matches whatever its case or trailing slash, and a key URL without a version matches every version of that key.
  
  Issue: [#589](https://github.com/aelmanaa/hardhat-kms/issues/589)

- [#583](https://github.com/aelmanaa/hardhat-kms/pull/583) [`3a7cf41`](https://github.com/aelmanaa/hardhat-kms/commit/3a7cf414aa7f08a858b8ee5aecc3b0c6ce510fff) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `eth_sendTransaction` and `eth_signTransaction` from a KMS account accept a `type` such as `2`, `"0x02"`, `"0X2"` or `"2"` again. With `@nomicfoundation/hardhat-zod-utils` 3.0.7 or later, which a fresh install of any Hardhat 3 release gets, these requests failed with a raw schema error and nothing was signed. Hardhat's own local accounts refuse these forms. A request that also goes to a Hardhat account should send `type` as a `0x` quantity without leading zeros, such as `"0x2"`.
  
  Issue: [#585](https://github.com/aelmanaa/hardhat-kms/issues/585)

## 1.2.0

### Minor Changes

- [#528](https://github.com/aelmanaa/hardhat-kms/pull/528) [`3bed0ce`](https://github.com/aelmanaa/hardhat-kms/commit/3bed0ce8dbf90616398403549b9c61a60ea117d8) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Provider adapters can now implement `signTransaction`. The plugin calls it for every transaction from `eth_sendTransaction`, `eth_signTransaction`, a library account's `signTransaction` and `kms sign-tx`. It receives the unsigned serialized transaction, its digest, its type and its chain id, and returns only the signature. The plugin checks that signature against its own digest and the key, and sends or prints its own transaction. Adapters without `signTransaction` keep signing transactions through `signDigest`. EIP-7702 authorizations, `kms sign-auth` and `kms sign --no-hash` still go to `signDigest`.
  
  What should I do? Nothing, unless you maintain a provider plugin whose adapter already has a method named `signTransaction`. The provider contract has reserved that name since 1.0. Such an adapter now receives every transaction through it, so rename the method or make it follow the contract.
  
  Issue: [#514](https://github.com/aelmanaa/hardhat-kms/issues/514)

- [#518](https://github.com/aelmanaa/hardhat-kms/pull/518) [`f735ed1`](https://github.com/aelmanaa/hardhat-kms/commit/f735ed128e40066f4bb0b1e0c8bb74f591306ba4) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A key with `provider: "turnkey"` now passes config validation. Before, `turnkey` in any case failed with `core.config.provider-reserved`. Its `apiPrivateKey` takes only `configVariable(NAME)`, without a `default` or a `format`: a literal API private key fails validation with `core.config.secret-variable`, and the error never shows the value. `Turnkey`, `turnky` and other near misses of the id fail with `core.config.provider-misspelled`. The configuration reference lists the key's fields.
  
  What should I do? Nothing, unless your code narrows a resolved key on `provider`. `KmsKeyConfig` now includes `TurnkeyKmsKeyConfig`, so code that reads `keyId` from every key that is not a `gcp` key needs a `turnkey` case.
  
  Issue: [#510](https://github.com/aelmanaa/hardhat-kms/issues/510)

- [#520](https://github.com/aelmanaa/hardhat-kms/pull/520) [`f952e64`](https://github.com/aelmanaa/hardhat-kms/commit/f952e64f38fd4d0aaaf936caadec2e8973a5ca61) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The new package `@hardhat-kms/turnkey` signs with the `turnkey` keys of a `kms` config. It calls Turnkey's API with the key's API key and has no runtime dependencies. Transactions go through Turnkey's `sign_transaction` activity, or as a 32-byte digest for a key with `transactionSigning: "digest"`. Messages reach Turnkey as the EIP-191 message, which Turnkey hashes with Keccak-256. Typed data reaches Turnkey as EIP-712 JSON. EIP-7702 authorizations reach Turnkey as a 32-byte digest. A key whose Turnkey policy needs an approval fails at once, and the error names the pending activity to reject. After a rate limit, a server error or no answer, the plugin sends the request again with the same body, so Turnkey signs it once. Errors show Turnkey's HTTP status and error code, never its message.
  
  `kms accounts` lists two Turnkey keys that name the same organization and address once when they also use the same API keys and the same `transactionSigning`; otherwise each gets a row of its own, and `--check-sign` checks each.
  
  Issue: [#511](https://github.com/aelmanaa/hardhat-kms/issues/511)

- [#529](https://github.com/aelmanaa/hardhat-kms/pull/529) [`c839a8a`](https://github.com/aelmanaa/hardhat-kms/commit/c839a8ac7e4ffa9787dbfb9707857cfe95cb9df0) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Turnkey keys sign transactions through Turnkey's `sign_transaction` activity (`ACTIVITY_TYPE_SIGN_TRANSACTION_V2`). Turnkey parses the transaction, so its policies can read the transaction's fields (`eth.tx.*`): a policy can limit a key to one contract, one chain or a value. The plugin decodes the signed transaction Turnkey returns, refuses it unless its type and every field equal the transaction it sent (`turnkey.sign.transaction-mismatch`), and keeps only the signature. It sends its own transaction, never Turnkey's bytes. Messages, typed data, EIP-7702 authorizations, `kms sign-auth` and `kms sign --no-hash` go through `sign_raw_payload`.
  
  A Turnkey key takes an optional field, `transactionSigning`: `"transaction"`, the default, or `"digest"`, which signs each transaction's hash through `sign_raw_payload` with `HASH_FUNCTION_NO_OP`, as Foundry does. The core validates it and resolves it to `"transaction"` when unset.
  
  What should I do? Nothing. When a key and its Turnkey policy are shared with Foundry and the policy allows only `SIGN_RAW_PAYLOAD`, set `transactionSigning: "digest"` on the key, or add the second policy of the Turnkey setup guide, which allows `SIGN_TRANSACTION`.
  
  Issue: [#515](https://github.com/aelmanaa/hardhat-kms/issues/515)

- [#540](https://github.com/aelmanaa/hardhat-kms/pull/540) [`93f9e40`](https://github.com/aelmanaa/hardhat-kms/commit/93f9e40f196efd4488279aef2e8ee1c39759f992) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A Turnkey transaction that fails after its request reached Turnkey no longer lets the plugin sign its nonce again. This covers a timeout, an abort by a library account's `signal`, an activity that needs approval, a status query that fails, an answer the plugin cannot read, and a signed transaction it refused. Turnkey keeps working on an activity it accepted, and a completed `sign_transaction` activity holds the signed transaction, which every user of the organization can read and broadcast. Before, the next send took the same nonce, so two valid transactions could exist for it. Now the error, `core.signer.transaction-outstanding`, starts with the cause and names the nonce and the activity id, and the network connection's later sends from the account skip that nonce: a gap, never a duplicate. The hold covers `eth_sendTransaction`, `eth_signTransaction` and a library account's `signTransaction`, and ends once the nonce is mined, when Turnkey's copy itself reaches the node through the connection, or when the connection closes. These release the nonce as before: a definite refusal by Turnkey (a 4xx answer, or an activity that ended `FAILED` or `REJECTED`), a request that failed before it left, a key with `transactionSigning: "digest"`, and AWS, Google Cloud and Azure keys.
  
  Turnkey also keeps every transaction it signs. A Turnkey transaction that the node refused for certain, for example for insufficient funds, now fails with `core.tx.refused-provider-copy`, which names the nonce, the kind of refusal and the node's code, and the nonce stays held: Turnkey's copy becomes valid once the cause goes away. A refusal at a nonce the node has already mined past is passed on unchanged, and "already known" counts as sent. With a Turnkey key, `eth_signTransaction` holds its nonce until it is mined, or its signed transaction reaches the node through the connection. When held nonces put a send above the node's pending count, the plugin warns that the transaction waits behind them.
  
  For every provider, `eth_signTransaction` without a `nonce` now signs the nonce a send would take, past the account's earlier sends on the connection, its reserved nonces and its held ones, instead of the node's pending count. It still does not wait for sends, except with a Turnkey key that signs with `sign_transaction`: there it takes its turn like a send, so two `eth_signTransaction` calls, or one next to a send, no longer sign the same nonce.
  
  A send that waited for its account's earlier send, or for the plugin's look-up of an unanswered transaction, while its connection closed now fails with `core.tx.connection-closed` before it asks the provider to sign. Before, it signed and then refused to broadcast, which with Turnkey left a signed transaction behind.
  
  Provider plugins get three optional members: `KmsKeyAdapter.signTransactionOutlivesAbort`, for a provider that may still sign a transaction after the plugin gave up on it; `SignContext.requestSent`, which such an adapter calls when its request may have reached the provider; and `SignContext.requestRefused`, which it calls when the provider refused the request for certain. `@hardhat-kms/turnkey` sets the flag for keys that sign with `sign_transaction`.
  
  What should I do? If you use `eth_signTransaction` and expected the node's pending count, note that it may now be higher after sends on the same connection; pass `nonce` to choose it yourself. If a Turnkey send fails with `core.tx.refused-provider-copy`, fix the cause it names, then send a replacement with that nonce, or broadcast Turnkey's signed transaction. If a Turnkey send fails with `core.signer.transaction-outstanding`, open the activity the message names in the Turnkey dashboard before you send anything else from the account. Reject it while it is pending; then, or if it completed, send a replacement transaction with the nonce the message names. If you maintain a provider plugin, nothing changes unless your provider keeps signing a transaction after the call ends and stores the result where others can broadcast it; then set `signTransactionOutlivesAbort` and call `ctx.requestSent` and `ctx.requestRefused`, as the provider guide describes.
  
  Issue: [#537](https://github.com/aelmanaa/hardhat-kms/issues/537)

### Patch Changes

- [#551](https://github.com/aelmanaa/hardhat-kms/pull/551) [`37cd6d5`](https://github.com/aelmanaa/hardhat-kms/commit/37cd6d557b8e6403d59709ba817751fb21229c1a) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The package description and keywords now mention Turnkey.

- [#527](https://github.com/aelmanaa/hardhat-kms/pull/527) [`9af93d1`](https://github.com/aelmanaa/hardhat-kms/commit/9af93d152b9d8542c238b0dfa3177c036b6ec788) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `kms history` on a Turnkey key fails with `core.history.unsupported`, which says that the task does not read Turnkey keys yet. The message names neither the organization id nor the key's address. A key of AWS KMS, Google Cloud KMS or Azure Key Vault whose provider package is missing still gets `core.history.no-reader-builtin`.
  
  What should I do? Nothing. Read a Turnkey key's activities in the Turnkey dashboard, or with Turnkey's `list_activities` query.
  
  Issue: [#524](https://github.com/aelmanaa/hardhat-kms/issues/524)

- [#517](https://github.com/aelmanaa/hardhat-kms/pull/517) [`fab818f`](https://github.com/aelmanaa/hardhat-kms/commit/fab818fdc97795ba134aa491343cb087fc4f03d5) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A key whose `provider` is `pkcs11`, in any case, now fails config validation with `core.config.provider-reserved`. The message links the issue that tracks the planned PKCS#11 HSM provider. The core also refuses to build an adapter for such a key. A third-party plugin's `kms` handler never receives one.
  
  What should I do? Nothing, unless a third-party plugin serves keys under `pkcs11`. Give that plugin's provider another id, and change the `provider` of its keys to match.
  
  Issue: [#516](https://github.com/aelmanaa/hardhat-kms/issues/516)

- [#539](https://github.com/aelmanaa/hardhat-kms/pull/539) [`465ac83`](https://github.com/aelmanaa/hardhat-kms/commit/465ac838524bd847325e836d903f4b5db5e836ba) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A Turnkey key's `transactionSigning` now decides which signer it gets. Before, a connection whose config override changed only `transactionSigning` shared the first connection's signer, so the override was ignored without an error: a key overridden to `"digest"` still signed through `sign_transaction`, and the reverse. `kms accounts` now lists Turnkey keys for one account as one entry only when they use the same API keys and the same `transactionSigning`, so `--check-sign` checks each API user.
  
  Issue: [#536](https://github.com/aelmanaa/hardhat-kms/issues/536)

- [#550](https://github.com/aelmanaa/hardhat-kms/pull/550) [`1b68eec`](https://github.com/aelmanaa/hardhat-kms/commit/1b68eec706df0665dfb135ddf34543fa2a3a9fdb) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A Turnkey key whose `apiPrivateKey` or `organizationId` variable is not set now fails with Hardhat's own error, which names the variable, for example `HHE7: Configuration Variable "TURNKEY_API_PRIVATE_KEY" not found`. Before, `kms sign`, `kms accounts --check-sign` and a send failed with `the provider call failed (HardhatError)`, which did not say which variable was missing. The error names the variable, never a value. The signer passes on only this error, rebuilt from the variable's name; Hardhat's other errors still show as `the provider call failed (HardhatError)`, since some quote a value. AWS, Google Cloud and Azure keys read their variables when the adapter is created, so their errors do not change.
  
  What should I do? Nothing. If a Turnkey key fails with the HHE7 error, set the variable it names in the environment or in `hardhat-keystore`.
  
  Issue: [#544](https://github.com/aelmanaa/hardhat-kms/issues/544)

## 1.1.0

### Minor Changes

- [#505](https://github.com/aelmanaa/hardhat-kms/pull/505) [`57858e0`](https://github.com/aelmanaa/hardhat-kms/commit/57858e0f212d9d39f98f7a7a31e562cd9756569c) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The new `hardhat-kms/alchemy` entry point exports `checkPreparedCalls`. It checks what `prepareCalls` of `@alchemy/wallet-apis` returned before a KMS key signs it. It recomputes the EntryPoint v0.7 user operation hash with your chain id and decodes the Modular Account v2 calls. It refuses the response unless the calls match yours exactly, the sender is the key's address, the signature request is `personal_sign` over that hash, a paymaster pays when a policy is set, and any EIP-7702 authorization names your pinned delegate without re-delegating the account. Without a policy, it requires a `maxGasCost` in wei and refuses a user operation whose gas limits times `maxFeePerGas` exceed it. With an `accountNonce`, it also requires the authorization to be for that nonce. Each refusal has an error in the catalogue under `core.alchemy`. The entry point needs viem, as `connection.kms.getAccount` does.
  
  Issue: [#495](https://github.com/aelmanaa/hardhat-kms/issues/495)

- [#503](https://github.com/aelmanaa/hardhat-kms/pull/503) [`9122630`](https://github.com/aelmanaa/hardhat-kms/commit/912263054a517dffa7f642a74f7fca3877f73e38) Thanks [@aelmanaa](https://github.com/aelmanaa)! - On `edr-simulated` networks, a send from a KMS account without a `nonce` now fills the nonces the node lost after its pending count falls, as after `evm_revert`, `hardhat_reset` or `hardhat_dropTransaction`. A library account's reserved nonce still counts after the fall. A send now takes the lowest nonce at or above the new pending count that no reserved nonce uses and at which the node holds none of the transactions sent on the connection. The plugin asks the node with `eth_getTransactionByHash` about every transaction it recorded at that nonce. A nonce whose lookup fails is skipped.
  
  Before, a reserved nonce or a transaction the node no longer held made the next send skip ahead. That left a nonce gap, and later transactions waited behind it.
  
  What should I do? Nothing. Sends on `http` networks are unchanged.
  
  Issue: [#489](https://github.com/aelmanaa/hardhat-kms/issues/489)

- [#502](https://github.com/aelmanaa/hardhat-kms/pull/502) [`0675660`](https://github.com/aelmanaa/hardhat-kms/commit/0675660e5e0566df25a9507f702ce0a12487341b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `eth_sendTransaction` and `eth_signTransaction` from a KMS account now refuse a `type` they cannot sign as written, before any request to the node. A request that sets `gasPrice`, `maxFeePerGas` or `maxPriorityFeePerGas` and a `type` those fields contradict fails with `core.tx.type-mismatch`; before, it was signed as the type the fields give. For example, `type: "0x2"` with `gasPrice` was signed as legacy, `type: "0x0"` with `maxFeePerGas` as EIP-1559, and `type: "0x4"` without an `authorizationList` as EIP-1559. The message says what to change: set the fee fields of the type you ask for, add an `authorizationList` for type 4, or remove `type`. `type: "0x1"` with `gasPrice` and no `accessList`, as viem's `eip2930` and ethers' `type: 1` send it, is now signed as an EIP-2930 transaction with an empty access list instead of as legacy. A numeric `type` other than 0 to 4 now fails with `core.tx.unsupported-type` instead of being ignored, for example Celo's fee-currency type `0x7b` or zkSync's `0x71`, which were signed as plain transactions without their chain-specific fields. A `type` with no fee field, such as viem's `type: "legacy"` without fees, signs as before.
  
  Issue: [#496](https://github.com/aelmanaa/hardhat-kms/issues/496)

### Patch Changes

- [#498](https://github.com/aelmanaa/hardhat-kms/pull/498) [`a03068b`](https://github.com/aelmanaa/hardhat-kms/commit/a03068bd3b542b924fd7f4a59ceec65357d1fdeb) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `eth_sendTransaction` and `eth_signTransaction` from a KMS account now estimate gas at the `pending` block. A self-sponsored EIP-7702 transaction could be signed with too little gas and run out of gas. This happened when the account had another transaction pending, or when a load-balanced RPC answered from a node a block behind. A request whose `nonce` replaces a pending transaction is estimated without a block tag, as before. When a node refuses the `pending` tag, the plugin estimates again without it.
  
  Issue: [#492](https://github.com/aelmanaa/hardhat-kms/issues/492)

- [#508](https://github.com/aelmanaa/hardhat-kms/pull/508) [`ef40620`](https://github.com/aelmanaa/hardhat-kms/commit/ef406206da9b7cd4d2488f61f878bd0de0a51684) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A send from a KMS account without a `nonce` no longer reuses the nonce of an earlier transaction that got no answer when a later one, sent with a `nonce` or as a raw transaction, got no answer either. Before, the plugin remembered only the last such transaction on the connection. If the node had the earlier one but its pending count lagged, as behind a load balancer, the next send took that nonce. With higher fees, a Geth node then replaced the earlier transaction without an error.
  
  The plugin now remembers every transaction that got no answer, up to 256 per account and connection, and the next send without a `nonce` asks the node about each of them. A lookup that fails now counts as the node having the transaction, as on `edr-simulated`; before, it counted as not known, and the next send could take the same nonce. Beyond 256, the oldest counts as in the node too. In both cases later sends skip the nonce: at worst a nonce gap, never a reused nonce.
  
  What should I do? Nothing.
  
  Issue: [#506](https://github.com/aelmanaa/hardhat-kms/issues/506)

- [#507](https://github.com/aelmanaa/hardhat-kms/pull/507) [`a4a8536`](https://github.com/aelmanaa/hardhat-kms/commit/a4a8536058b7f5cbc24c9a28f0b264ffd2fe282e) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The `core.tx.type-mismatch` message now names only the fields the request sets. For example, `type: "0x4"` with `maxFeePerGas` and `maxPriorityFeePerGas` now says "Add an authorizationList, or remove type.", and `type: "0x0"` with `gasPrice` and an `accessList` says "Remove accessList, or remove type.". A `null` `gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`, `accessList` or `authorizationList` in `eth_sendTransaction` or `eth_signTransaction` now fails with `core.tx.null-field`, which names the field, before any request to the node. Before, it failed with a raw schema error. With automatic fees (the default), a lone `null` `maxFeePerGas` or `maxPriorityFeePerGas`, with no `gasPrice` and the other EIP-1559 field left out, is still filled like an absent field, as Hardhat does. Requests whose numeric `type` contradicts their fee fields once such a `null` is filled, which signed before, now fail with `core.tx.type-mismatch`, as they do with a value in place of the `null`. For example, `type: "0x0"` with `maxFeePerGas: null` was signed as type 2, and `type: "0x2"` with `maxFeePerGas: null` and an `authorizationList` was signed as type 4.
  
  Issue: [#504](https://github.com/aelmanaa/hardhat-kms/issues/504)

## 1.0.1

### Patch Changes

- [#488](https://github.com/aelmanaa/hardhat-kms/pull/488) [`f4d5550`](https://github.com/aelmanaa/hardhat-kms/commit/f4d55503075d06099a8634902e9688accfafaa26) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `eth_sendTransaction` and `eth_signTransaction` from a KMS account now refuse type 3 in every form with `core.tx.blob`, before any request to the node: `"0x03"`, `"0X3"`, the number `3`, a bigint, `"3"` and `"eip4844"`, with or without surrounding whitespace, not only `"0x3"`. These were signed as legacy or EIP-1559 transactions before. Every other `type` is still ignored, as in Hardhat.
  
  Issue: [#484](https://github.com/aelmanaa/hardhat-kms/issues/484)

## 1.0.0

### Major Changes

- [#453](https://github.com/aelmanaa/hardhat-kms/pull/453) [`e05ee84`](https://github.com/aelmanaa/hardhat-kms/commit/e05ee848fd8d042cca2dd8b3ac49824b24fc3c09) Thanks [@aelmanaa](https://github.com/aelmanaa)! - hardhat-kms 1.0 is a Hardhat 3 plugin that signs transactions, messages, typed data and EIP-7702 authorizations with secp256k1 keys in AWS KMS, Google Cloud KMS and Azure Key Vault, and the private key never leaves the service.
  
  From 1.0, semver covers the config keys, task names and flags, error codes, the account returned by `connection.kms.getAccount`, and the provider interface for plugin authors. Removing or renaming one of these, or dropping a Hardhat major, requires a major release. Items marked `Experimental` in the API reference and `hardhat-kms/provider-utils` may change in a minor release. [Release channels and versioning](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/versioning.md#semver-and-the-public-api) defines the public API.
  
  The core package, `hardhat-kms`, works with one provider package per cloud. They are `@hardhat-kms/aws` for AWS KMS, `@hardhat-kms/gcp` for Google Cloud KMS and `@hardhat-kms/azure` for Azure Key Vault. The four packages are released together at one version, and each provider package requires the core at exactly its own version.
  
  The eight tasks in the `kms` namespace are `kms accounts`, `kms address`, `kms public-key`, `kms sign`, `kms verify`, `kms sign-tx`, `kms sign-auth` and `kms history`. The [tasks reference](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/tasks.md) gives each one's flags, output and errors.
  
  `connection.kms.getAccount(address)` returns a viem account for a KMS key. It supports `signAuthorization` and can serve as a smart-account owner or sign directly in a script. Its `signal` option cancels in-flight KMS calls and prevents further signing after it aborts. [Library accounts](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/library-accounts.md) documents its options, methods and refusals.
  
  `kms history` lists a key's sign events from the provider's audit log. It reads AWS CloudTrail, Google Cloud Audit Logs or Azure Key Vault's audit events in a Log Analytics workspace. The plugin keeps no record of its own.
  
  No JSON-RPC method signs a bare 32-byte digest. Raw signing requires `kms sign --no-hash` or a `getAccount` account created with `rawSign: true`. Typed data whose `domain.chainId` differs from the connection's chain is refused unless `kms.allowCrossChainTypedData` is `true`. Blob transactions (EIP-4844) are refused. A self-authorization in an EIP-7702 transaction must use chain 0 or the transaction's chain and start at the transaction nonce plus 1. Further self-authorizations need consecutive nonces.
  
  hardhat-kms 1.0 needs Hardhat `^3.18.0` and Node.js 22.13.0 or later. viem `^2.55.13` is an optional peer of `hardhat-kms`, needed only by `connection.kms.getAccount`. The [compatibility table](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/versioning.md#compatibility-table) lists the ranges.
  
  The pre-1.0 [registry acceptance pass](https://github.com/aelmanaa/hardhat-kms/issues/466) tested the published 0.10.1 packages with all three clouds. The [0.10.1 live proof](https://github.com/aelmanaa/hardhat-kms/blob/6864a19d7ab4d6e0c88dd99b1892b9e6faaf05c4/docs/live-proof.md) records legacy, EIP-2930, EIP-1559 and EIP-7702 transactions and EIP-191 and EIP-712 signatures on Sepolia at release commit `90d1b96`, in blocks 11886654 to 11886668. Promoting 1.0.0 requires a new Sepolia proof for the `v1.0.0` tag commit.
  
  To check that the packages you installed were built from this repository, run `npm audit signatures` as [Verify a release](https://github.com/aelmanaa/hardhat-kms/blob/main/README.md#verify-a-release) says.
  
  The [docs index](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/README.md) lists every tutorial, guide and reference page. The [security model](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/explanation/security-model.md) says what the plugin protects against and what it does not.
  
  What should I do? Upgrade `hardhat-kms` and every provider package in the project to 1.0.0 together. This release adds no API break over 0.10.1.
  
  A community plugin, built in a personal capacity; not affiliated with or endorsed by Nomic Foundation, Amazon Web Services, Google or Microsoft.
  
  Issue: [#284](https://github.com/aelmanaa/hardhat-kms/issues/284)

### Patch Changes

- [#468](https://github.com/aelmanaa/hardhat-kms/pull/468) [`c207494`](https://github.com/aelmanaa/hardhat-kms/commit/c207494cc0aede97e810c2fe5268a09d6b8d4c9d) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The README describes pre-1.0 releases without naming an outdated version. The install guide explains how pnpm and Yarn can select an older version during their release-age window and how to select the intended release. The Google Cloud and Azure tutorials link the 0.10.1 restricted-role acceptance results.
  
  Issue: [#467](https://github.com/aelmanaa/hardhat-kms/issues/467)

- [#470](https://github.com/aelmanaa/hardhat-kms/pull/470) [`8ce3648`](https://github.com/aelmanaa/hardhat-kms/commit/8ce3648ed7ead36abf3d4b30a75f55f68364b929) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The security policy links the recorded maintainer review of the signing and sending paths and the 0.10.1 registry acceptance results. The 1.0.0 announcement instructions link the new Sepolia proof at its merged commit.
  
  Issue: [#334](https://github.com/aelmanaa/hardhat-kms/issues/334), [#308](https://github.com/aelmanaa/hardhat-kms/issues/308)

## 0.10.1

### Patch Changes

- [#441](https://github.com/aelmanaa/hardhat-kms/pull/441) [`00bff53`](https://github.com/aelmanaa/hardhat-kms/commit/00bff531b0bfcce42ae518ed4ce60e28a6a516a6) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A send through the plugin could sign the same nonce as a `connection.kms.getAccount` send from the same KMS key. If its fees were high enough, the node then replaced the library transaction whose hash viem had already returned; otherwise one of the two failed. Four cases did this:
  
  - The library transaction went out through a second connection. That connection learned its nonce, but the account's own connection did not, so with a node that reports a lagging pending count, the next send there took the same nonce. The account's connection now records the outcome too, including a broadcast that got no answer.
  - The library send took longer than 60 s to broadcast. The plugin released the nonce, and the send waiting behind it took it. The plugin now keeps that nonce from its own sends for up to 60 s more, and the warning no longer says that the node refuses one of the two transactions.
  - A transaction from the same account and with the same nonce, but signed for another chain, released the nonce. It now passes on unchanged.
  - The library transaction went out through a connection to the same chain that has no KMS keys. The plugin did not see it, so its sends waited up to 60 s and could then take the same nonce. Such a connection now ends the wait while a library send holds a nonce.
  
  What should I do? In most cases, nothing. One case needs action: a library send that takes over 60 s and then fails before its transaction reaches the node leaves its nonce unused, while the plugin's later sends from that connection have taken higher nonces. On a live node those later transactions are not mined until the gap is filled. A warning now names the nonce. viem also resets after a timeout, when the node may have the transaction, so first check the node for that nonce, as in [Look the transaction up](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/uncertain-sends.md#2-look-the-transaction-up). If no transaction has it, fill the gap by sending a transaction with that `nonce`, as in [Fill a gap or replace a transaction](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/uncertain-sends.md#4-fill-a-gap-or-replace-a-transaction). Sending a `getAccount` account through `custom(connection.provider)` of its own connection remains the recommended setup.
  
  Issue: [#433](https://github.com/aelmanaa/hardhat-kms/issues/433)

- [#456](https://github.com/aelmanaa/hardhat-kms/pull/456) [`5addc7f`](https://github.com/aelmanaa/hardhat-kms/commit/5addc7f4f0cdb24e8bde8ea49432a1f322249a24) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Promotion to npm `latest` now also marks the GitHub release as Latest when the optional fork-test job is skipped. Previously, a promotion using a Sepolia proof could leave the GitHub release marked as a prerelease after all four npm tags moved successfully.
  
  Issue: [#455](https://github.com/aelmanaa/hardhat-kms/issues/455)

- [#454](https://github.com/aelmanaa/hardhat-kms/pull/454) [`c2dd7f0`](https://github.com/aelmanaa/hardhat-kms/commit/c2dd7f0c59be9bd9153d276251fc110ad3c8ebe0) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Three cases let a send through the plugin sign a nonce that another send from the same KMS key still had:
  
  - A send that was waiting for its KMS signature when its connection closed was still broadcast, through a connection that no longer recorded its nonce. A send on a new connection could then take the same nonce. Such a send now fails with `core.tx.connection-closed` and nothing is sent. Before, a close at the wrong moment could also make it fail with `SendOutcomeUnknownError`, which says the transaction may still be mined, although nothing was sent. A send that is already being broadcast when the connection closes is not stopped. A `connection.kms.getAccount` send that was waiting for its turn or its nonce RPC when the connection closed now fails with `core.account.connection-closed` instead of taking a nonce that blocked the account's sends on every connection for 60 s.
  - A send through the plugin that skipped a nonce kept for a `connection.kms.getAccount` client with its own transport, such as `http(url)`, ended that nonce's reservation once the node took it, although the client had not sent it yet. On `edr-simulated` with interval mining, the next send then took that nonce. A send whose nonce the plugin chose now ends no reservation; one with a `nonce` you set, equal to it or higher, still does. On `edr-simulated`, while a nonce is kept, the nonces the node accepted past its pending count now count for the next send too, since the pending count stops at the gap; and a broadcast that got no answer is looked up before the next send, as on other networks.
  - viem's `reset` names neither the send nor the nonce. With two such clients sending at once, the older one can fail first, and its `reset` ended the newer one's reservation, so the next send through the plugin took the newer one's nonce. When a `reset` could be for several such sends, the plugin now ends none of their reservations until the sends that sign show which ones failed, or until their 60 s are up. This covers a send that already signed, whose broadcast timed out: before, a `reset` ended an unsigned reservation first. A reservation whose nonce the node already has no longer lets a `reset` end the hold of a send through the connection: viem also resets after a timeout, when the node may have the transaction.
  
  What should I do? In most cases, nothing. A warning names a possible gap when a reset releases a kept nonce below one the node accepted, or when kept nonces expire with a reset still unexplained. Automatic sends may still choose higher nonces after the reservation ends. Fill a confirmed gap with an explicit nonce. If the send that failed had one of them, that nonce is a gap: check the node for it first, as in [Look the transaction up](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/uncertain-sends.md#2-look-the-transaction-up), and if no transaction has it, send one with that `nonce`, as in [Fill a gap or replace a transaction](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/guides/uncertain-sends.md#4-fill-a-gap-or-replace-a-transaction). Sending a `getAccount` account through `custom(connection.provider)` of its own connection remains the recommended setup.
  
  Issue: [#434](https://github.com/aelmanaa/hardhat-kms/issues/434)

- [#457](https://github.com/aelmanaa/hardhat-kms/pull/457) [`05de3c7`](https://github.com/aelmanaa/hardhat-kms/commit/05de3c73b5d1d4960120b811f21e3769ec17c214) Thanks [@aelmanaa](https://github.com/aelmanaa)! - KMS transaction signing now refuses a self-authorization whose nonce or chain does not match the final transaction. The RPC send path also refuses `type: "0x3"` and `maxFeePerBlobGas`. EIP-7702 requests whose automatic fee estimation fails report that EIP-1559 fees are needed.
  
  What should I do? Set the transaction nonce explicitly before signing a self-authorization. Use that nonce plus 1 for the first self-authorization and consecutive nonces for additional ones. If fee history is unavailable, set both `maxFeePerGas` and `maxPriorityFeePerGas`.
  
  Issue: [#435](https://github.com/aelmanaa/hardhat-kms/issues/435)

- [#438](https://github.com/aelmanaa/hardhat-kms/pull/438) [`be76f29`](https://github.com/aelmanaa/hardhat-kms/commit/be76f290390645a5a136bc19dd02422830584040) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `kms sign-tx` no longer repeats part of a file that is not JSON in its error. The JSON parser's message quoted the text around the error, so passing a `.env` file by mistake printed the start of a secret. The error now names only the line and column, for example `the transaction file .env is not valid JSON at line 1, column 1`.
  
  `kms sign --data --from-file` and `kms verify --data --from-file` had the same problem with a large integer: the error quoted about 16 digits of it. It now names the key instead, for example `a number at key "chainId" is above 2^53 - 1`.
  
  Two other signing errors changed:
  
  - A provider plugin that returns a signature as `{ r, s }` with values that are not `bigint`, such as JavaScript numbers, now gets `r and s must be bigints` in the signer's `invalid signature` error, after one fresh request. Before, a high `s` ended in a `TypeError`.
  - When the EIP-712 encoder refuses typed data, the error cuts the encoder's message, which can quote a whole value, to 200 characters ending in `...`.
  
  What should I do? Nothing.
  
  Issue: [#436](https://github.com/aelmanaa/hardhat-kms/issues/436)

## 0.10.0

### Minor Changes

- [#413](https://github.com/aelmanaa/hardhat-kms/pull/413) [`ed85784`](https://github.com/aelmanaa/hardhat-kms/commit/ed857842fe8b50142c228e72a965b1bce7512744) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `connection.kms.getAccount` takes a `signal` option. When the `AbortSignal` aborts, the account's KMS call in progress stops with `cancelled by the caller's abort signal` and is not retried. After that, every method of the account, and `getAccount` called with the same signal, refuses before any KMS call. A request that already reached the KMS can still be signed there, but the account never returns that signature.
  
  Issue: [#8](https://github.com/aelmanaa/hardhat-kms/issues/8)

### Patch Changes

- [#422](https://github.com/aelmanaa/hardhat-kms/pull/422) [`b7b294f`](https://github.com/aelmanaa/hardhat-kms/commit/b7b294f056169b51fdb85a27664f807db3898ee4) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The package READMEs link to the Node.js support page by its new title, Supported Node.js versions. Its URL is unchanged.
  
  Issue: [#379](https://github.com/aelmanaa/hardhat-kms/issues/379)

- [#421](https://github.com/aelmanaa/hardhat-kms/pull/421) [`a74b722`](https://github.com/aelmanaa/hardhat-kms/commit/a74b72225483fcbcbe06cfe04b1d6061f40c5aef) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Two sends from the same KMS key could take the same nonce, so the node kept only one of them. This could happen to code that keeps using a `connection.kms.getAccount` account after its connection is closed, while another connection sends from the same key. viem calls the account's `nonceManager.reset` when a send fails, even when the account refused to give it a nonce, and that reset released the send lock that the other connection's send was holding. The account now ignores the `reset` that follows a nonce it refused, and a reset only releases the lock for a send of its own connection. A reset owed by a send whose broadcast failed is now counted for that send's connection only, so a reset through another connection cannot use it up.
  
  What should I do? Nothing. An account still refuses to send once its connection is closed; call `getAccount` on an open connection to send again.
  
  Issue: [#416](https://github.com/aelmanaa/hardhat-kms/issues/416)

- [#407](https://github.com/aelmanaa/hardhat-kms/pull/407) [`ce294f0`](https://github.com/aelmanaa/hardhat-kms/commit/ce294f06379eabede447b615d71142449b8e7409) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A key whose `provider` is `turnkey` or `fireblocks`, in any case, now fails config validation with `core.config.provider-reserved`. The message links the issue that tracks the planned provider. The core also refuses to build an adapter for such a key. A third-party plugin's `kms` handler never receives one.
  
  What should I do? Nothing, unless a third-party plugin serves keys under `turnkey` or `fireblocks`. Give that plugin's provider another id, and change the `provider` of its keys to match.
  
  Issue: [#349](https://github.com/aelmanaa/hardhat-kms/issues/349)

## 0.9.0

### Minor Changes

- [#298](https://github.com/aelmanaa/hardhat-kms/pull/298) [`d04324e`](https://github.com/aelmanaa/hardhat-kms/commit/d04324e99f4bbc87e0bfe213a11ce6ea7d203f47) Thanks [@aelmanaa](https://github.com/aelmanaa)! - 0.9.0 is the first published version of hardhat-kms and of the `@hardhat-kms/aws`, `@hardhat-kms/gcp` and `@hardhat-kms/azure` providers. It is the release candidate for 1.0.0. The maintainer installs 0.9.0 from npm and runs it against AWS KMS, Google Cloud KMS and Azure Key Vault; 1.0.0 is the 0.9.x that passes, with only the version number changed. Until 1.0.0 is published, use 0.9.0 with test keys on testnets.
  
  Issue: [#284](https://github.com/aelmanaa/hardhat-kms/issues/284)

- [#256](https://github.com/aelmanaa/hardhat-kms/pull/256) [`1f73bfb`](https://github.com/aelmanaa/hardhat-kms/commit/1f73bfbb1d03656d20ce697a99a5175f21aceec2) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `signAuthorization` on the account from `connection.kms.getAccount` no longer returns `v`, which viem marks as deprecated. The result has `address`, `chainId`, `nonce`, `r`, `s` and `yParity`, and is still viem's `SignedAuthorization`. An authorization list entry with `v` and no `yParity` still signs. The signature bytes do not change.
  
  What should I do? Code that read `v` from the result should read `yParity`.
  
  Issue: [#249](https://github.com/aelmanaa/hardhat-kms/issues/249)

- [#260](https://github.com/aelmanaa/hardhat-kms/pull/260) [`d9f77bf`](https://github.com/aelmanaa/hardhat-kms/commit/d9f77bf132af4f6e8f216a43541c7380a873ce60) Thanks [@aelmanaa](https://github.com/aelmanaa)! - An AWS key's `profile` and `region`, and `kms.defaults.aws.region`, now take `configVariable(...)` as well as a literal string. The plugin reads the variable when the key is first used. An empty value leaves the field unset, so `configVariable("AWS_KMS_PROFILE", { default: "" })` makes the profile optional. An unset variable without a `default` fails at first use with Hardhat's error, which names the variable. A key ARN whose region conflicts with a `region` from a variable fails at first use. Errors, `kms accounts` and `kms history` show a value from a variable as `<VARIABLE_NAME>` or `<hidden>` unless `--show-ids` is given.
  
  What should I do? Nothing changes in a config that uses literal strings. In the resolved config, `AwsKmsKeyConfig.region`, `AwsKmsKeyConfig.profile` and `KmsConfig.defaults.aws.region` are now `KmsIdentifier` values. A plugin that reads one of them should call `await key.region?.get()` and print `key.region?.display`. The `kms accounts` report keeps `region` and `profile` as strings.
  
  Issue: [#243](https://github.com/aelmanaa/hardhat-kms/issues/243)

- [#127](https://github.com/aelmanaa/hardhat-kms/pull/127) [`5b696a0`](https://github.com/aelmanaa/hardhat-kms/commit/5b696a06e2b6f1d9d3ad49720716a01caedb541f) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `@hardhat-kms/azure` is the Azure Key Vault provider. It checks that the key is an enabled `EC` or `EC-HSM` key on `P-256K` that may sign, pins the key version on first use and signs with `ES256K` against that version. A signature whose `kid` names another version is refused. Credentials come from a service principal, workload identity, `az`, `azd`, then a managed identity. The managed identity lookup gives up after 10 seconds, and each of its requests after 3. The package depends on `@azure/keyvault-keys` 4.10.2, `@azure/identity` 4.13.3 and `@azure/core-rest-pipeline` 1.25.0 or later. `hardhat-kms/provider-utils` now exports `publicKeyFromJwk` and `parseAzureKeyId`. An `azure` key without the package fails with the command that installs it.
  
  Issue: [#30](https://github.com/aelmanaa/hardhat-kms/issues/30)

- [#255](https://github.com/aelmanaa/hardhat-kms/pull/255) [`7192a5b`](https://github.com/aelmanaa/hardhat-kms/commit/7192a5b976f9a7fd308233bc4085dd4badebe823) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The Azure credential chain no longer signs in with `AZURE_USERNAME` and `AZURE_PASSWORD`. That sign-in cannot do multifactor authentication. With `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_USERNAME` and `AZURE_PASSWORD` set and no client secret or certificate, signing and `kms history` fail with the new `azure.credential.username-password` error, which names the variables but not their values. A stray `AZURE_USERNAME` or `AZURE_PASSWORD` in any other case is ignored, with a `hardhat:kms:azure` debug line that names it. `az login`, service principal, workload identity and managed identity setups keep working.
  
  `AZURE_ADDITIONALLY_ALLOWED_TENANTS` now takes effect for a service principal from the environment, so a vault in an allowed tenant other than `AZURE_TENANT_ID` can sign. Before, the variable had no effect. A service principal that fails for any reason, including a tenant that is not allowed, still stops the chain. An invalid `AZURE_TENANT_ID` now fails with `azure.credential.tenant-id`. Before, it failed with a generic adapter error.
  
  `hardhat-kms/provider-utils` now exports `kmsDebug`, the `hardhat:kms:*` debug logger. It prints plain values only and refuses a namespace other than lowercase letters, digits and `-`.
  
  What should I do? A setup that signed in with a username and password stops working. Set `AZURE_CLIENT_SECRET` or `AZURE_CLIENT_CERTIFICATE_PATH`, or unset the two variables and use `az login`, workload identity or a managed identity.
  
  Issue: [#245](https://github.com/aelmanaa/hardhat-kms/issues/245)

- [#130](https://github.com/aelmanaa/hardhat-kms/pull/130) [`d371753`](https://github.com/aelmanaa/hardhat-kms/commit/d3717530dc8edcc8c0dcb25a4f7e42cf08833eb5) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `@hardhat-kms/gcp` is the Google Cloud KMS provider. It signs with the configured key version and refuses a version whose algorithm is not `EC_SIGN_SECP256K1_SHA256`. It checks every request and response with CRC32C and retries a mismatch or an unavailable service at most three times. `hardhat run` exits when the script ends. The package depends on `@google-cloud/kms` 6.2.1 or later and on `google-gax` 6.5.0 or later. `hardhat-kms/provider-utils` now exports `publicKeyFromSpkiPem` and `crc32c`. A `gcp` key without the package fails with the command that installs it.
  
  Issue: [#29](https://github.com/aelmanaa/hardhat-kms/issues/29)

- [#180](https://github.com/aelmanaa/hardhat-kms/pull/180) [`6cff615`](https://github.com/aelmanaa/hardhat-kms/commit/6cff6150b369202003168b57d20800f350206d07) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `kms accounts` gains `--balances` and `--check-sign`. `--balances` shows each address's balance on the `--network` network, in ether in the table and as a decimal wei string in the JSON's `balance` field. `kms accounts` refuses `--balances` without `--network`. `--check-sign` has each key sign a random EIP-191 message through the normal signer and its signature check, which proves the credentials may sign and not only read the public key. The signature is never printed. The JSON gains `signCheck`, which is `"ok"` or `null`. Both fields appear only with their option, and the report keeps `"version": 1`. A failed balance read or sign check fails only its row, and the command then exits with code 1.
  
  Issue: [#52](https://github.com/aelmanaa/hardhat-kms/issues/52)

- [#135](https://github.com/aelmanaa/hardhat-kms/pull/135) [`a3885df`](https://github.com/aelmanaa/hardhat-kms/commit/a3885df2b041cb08f973b6fc8dfd711c66aaa798) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `kms accounts` lists the KMS keys with their provider, source, key id and address, and checks each key against the KMS and its `address` pin. Every key is tried. A key that fails is shown with its error, and the command then exits with code 1. A pin that does not match prints both addresses. A key without a pin gets an `address` line to paste into its config. With `--network`, the task lists that network's keys. Without it, every key is listed once. Key ids read from configuration variables are masked unless `--show-ids` is given. `--json` prints the list as JSON with `"version": 1`. The JSON types, `AccountsReport` and `AccountEntry`, are exported from `hardhat-kms/types`.
  
  Issue: [#32](https://github.com/aelmanaa/hardhat-kms/issues/32)

- [#132](https://github.com/aelmanaa/hardhat-kms/pull/132) [`e2a3448`](https://github.com/aelmanaa/hardhat-kms/commit/e2a34485c15447714e874062e4c0006a3908d959) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The new `kms` task namespace has `kms address <key>`, which prints a key's EIP-55 address, and `kms public-key <key>`, which prints its 65-byte uncompressed public key. A task names a key by its name in `kms.keys`, as `<network>.kmsAccounts[<index>]` for an inline key, or by the variable a `--kms` key was read from, such as `AWS_KMS_KEY_ID`. An unknown name fails with the known names and suggests one that differs only in case. An `address` pin that does not match the key fails with both addresses. Standard output holds only the result. Provider status messages go to standard error. The command exits once it has printed.
  
  Issue: [#33](https://github.com/aelmanaa/hardhat-kms/issues/33)

- [#80](https://github.com/aelmanaa/hardhat-kms/pull/80) [`4054934`](https://github.com/aelmanaa/hardhat-kms/commit/4054934e9bca1bcfcbda8da73a01dc9912f420bf) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The `kms` config section and `kmsAccounts` on networks are new. Keys for AWS KMS, Google Cloud KMS and Azure Key Vault are validated when the config loads, with errors that name the exact config path. Values from configuration variables are checked when first read.
  
  Issue: [#10](https://github.com/aelmanaa/hardhat-kms/issues/10)

- [#182](https://github.com/aelmanaa/hardhat-kms/pull/182) [`b52d5bf`](https://github.com/aelmanaa/hardhat-kms/commit/b52d5bf0238c72b7e9006010009e6b0c59fb6b17) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `kms history <key>` lists a key's sign events from its provider's audit log, newest first, with `--since`, `--until`, `--limit`, `--json` and `--show-ids`. The plugin stores nothing and fills in nothing. Fields the provider never logs are listed in `notLogged`, an empty result says that logging is not confirmed, and a recent or old range gets a note. The config gains `kms.audit.azure.workspaceId`. Provider plugins add readers through the new `readSignHistory` method of the `kms` hook, and `hardhat-kms/provider-utils` exports `auditLogAccessDenied` and `auditLogThrottled` for them. The AWS, Google Cloud and Azure readers ship in their packages.
  
  Issue: [#126](https://github.com/aelmanaa/hardhat-kms/issues/126)

- [#109](https://github.com/aelmanaa/hardhat-kms/pull/109) [`9230518`](https://github.com/aelmanaa/hardhat-kms/commit/923051815765eb00a36df0b543acad78bfaf3f2c) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `--kms` keys now join the selected network, which is the `--network` value or `default` without one. They come after the network's `kmsAccounts`. A command-line key that names the same KMS key as a config key on that network fails with an error that names both, without the value.
  
  What should I do? Give the key in `kmsAccounts` or on `--kms`, not both.
  
  Issue: [#84](https://github.com/aelmanaa/hardhat-kms/issues/84)

- [#139](https://github.com/aelmanaa/hardhat-kms/pull/139) [`6602a69`](https://github.com/aelmanaa/hardhat-kms/commit/6602a69d65079383076edf6f55786b582d0f82f9) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `kms sign-auth <key> <delegate>` signs an EIP-7702 authorization and prints it as the JSON tuple an `eth_sendTransaction` `authorizationList` takes. The chain comes from `--chain` or `--network`, which cannot be combined. The nonce comes from `--nonce` or from the `--network` node's pending count. `--self-broadcast` adds one for a key that also sends the transaction, and cannot be combined with `--nonce`. Chain 0 needs `--force`. Before the KMS call, a line on standard error names the authority, chain, nonce and delegate, and with `--network` the task warns when the delegate has no code on the node. The tuple must recover to the key, with a low `s`, before it is printed.
  
  Issue: [#35](https://github.com/aelmanaa/hardhat-kms/issues/35)

- [#133](https://github.com/aelmanaa/hardhat-kms/pull/133) [`8565c0c`](https://github.com/aelmanaa/hardhat-kms/commit/8565c0cf0bf3133a90e547370d491806a2449808) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `kms sign <key> <message>` prints a 65-byte `r || s || v` signature, as `cast wallet sign` does. A `0x` message is signed as bytes and anything else as UTF-8 text, both with the EIP-191 prefix. `--data` signs EIP-712 typed data given as JSON, or read from a file with `--from-file`. Typed data that names a chain must match `--chain` or the `--network` chain, which cannot be combined, unless `--allow-cross-chain` or `kms.allowCrossChainTypedData` is set. The `--network` chain is the config's `chainId`, else the node's. `--no-hash` signs a raw 32-byte digest, prints a warning to standard error and refuses any other length. No RPC method offers it. Every signature must recover to the key before it is printed.
  
  Issue: [#34](https://github.com/aelmanaa/hardhat-kms/issues/34)

- [#136](https://github.com/aelmanaa/hardhat-kms/pull/136) [`341b2c4`](https://github.com/aelmanaa/hardhat-kms/commit/341b2c4a00e59fd7bac8959de412323dfa983d0f) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `kms sign-tx <key> <tx.json>` fills and signs a transaction without sending it, as `cast mktx` does. It reads a transaction with `eth_sendTransaction` field names from a JSON file and fills it on the `--network` node as `eth_signTransaction` does for a KMS account. It prints the raw signed transaction on standard output and its hash on standard error. `--network` is required. Before the KMS signs, the task refuses a `from` that is not the key's address, a `chainId` for another chain, a blob transaction, a `type` the fields do not give, a mixed-case address with a wrong EIP-55 checksum, a quantity that is not `0x` hex, and a field that `eth_sendTransaction` does not have, such as `gasLimit` or `input`.
  
  Issue: [#36](https://github.com/aelmanaa/hardhat-kms/issues/36)

- [#138](https://github.com/aelmanaa/hardhat-kms/pull/138) [`07997da`](https://github.com/aelmanaa/hardhat-kms/commit/07997da46b0d914fb8158b0027bd313135602896) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `kms verify` checks that an address signed a message or, with `--data` and `--from-file`, EIP-712 typed data. The expected signer is `--address`, checked without contacting the KMS, or `--key`, whose address the KMS returns. The message, `--data` and `--from-file` work as in `cast wallet verify` and `kms sign`. Signatures are read as cast reads them. `v` may be 0, 1, 27, 28 or an EIP-155 value. A high-S signature is accepted with a note that OpenZeppelin's `ECDSA.recover` rejects it. A match prints one line and exits with code 0, and a mismatch prints both addresses and exits with code 1. There is no `--no-hash`.
  
  Issue: [#37](https://github.com/aelmanaa/hardhat-kms/issues/37)

- [#185](https://github.com/aelmanaa/hardhat-kms/pull/185) [`f14e6b1`](https://github.com/aelmanaa/hardhat-kms/commit/f14e6b1a072a6294a77a8638ecc232bb639ff081) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `connection.kms.getAccount(address)` returns a viem `LocalAccount` for a KMS account of the connection, for viem's `signAuthorization`, smart-account owners and scripts outside a wallet client. It signs messages, typed data, transactions of types 0, 1, 2 and 4, and EIP-7702 authorizations, with the same checks as the RPC path. For viem-typed inputs it returns the bytes viem's `privateKeyToAccount` returns for the same key. A string `domain.chainId` in typed data, which viem drops, is kept, so the digest is the one a contract expects. Before any KMS call it refuses a transaction or authorization for another chain, a blob transaction, other types, a transaction viem's serializer encodes differently, and a chain-0 authorization unless `allowChainZeroAuthorization` is set. `sign({ hash })` exists only with `rawSign: true`, which prints a warning. After `connection.close()`, the account refuses to sign. viem is a new optional peer dependency, `^2.55.13`, loaded only by `getAccount`.
  
  Issue: [#51](https://github.com/aelmanaa/hardhat-kms/issues/51)

- [#106](https://github.com/aelmanaa/hardhat-kms/pull/106) [`527a386`](https://github.com/aelmanaa/hardhat-kms/commit/527a3861ed58e4b687a6dfb0792eb39f9855768f) Thanks [@aelmanaa](https://github.com/aelmanaa)! - On a network with `kmsAccounts`, `eth_accounts` and `eth_requestAccounts` now list the network's own accounts followed by the KMS addresses. `eth_sign`, `personal_sign` and `eth_signTypedData_v4` sign with the KMS key, with EIP-191 and strict hex as in Hardhat core. Requests for other addresses pass through. A script exits without closing its connection. Signers are closed 5 seconds after the runtime's last connection closes. `kmsAccounts` on the `default` network prints a warning. An error raised while an adapter is created keeps its message if Hardhat or a plugin raised it, and otherwise shows only its class name.
  
  Issue: [#19](https://github.com/aelmanaa/hardhat-kms/issues/19)

- [#96](https://github.com/aelmanaa/hardhat-kms/pull/96) [`cfdaf78`](https://github.com/aelmanaa/hardhat-kms/commit/cfdaf785ec450f344c55c8be2af91f8ad529fe6b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Each cloud provider's adapter now lives in its own package. `hardhat-kms` keeps the key formats and signing checks and depends on no cloud SDK. The new `hardhat-kms/provider-utils` entry point exports the helpers provider plugins build on.
  
  What should I do? Install the provider package next to `hardhat-kms`: `@hardhat-kms/aws` for an `aws` key, `@hardhat-kms/gcp` for a `gcp` key and `@hardhat-kms/azure` for an `azure` key. Without it, the key fails with the command that installs it.
  
  Issue: [#91](https://github.com/aelmanaa/hardhat-kms/issues/91)

- [#99](https://github.com/aelmanaa/hardhat-kms/pull/99) [`4ae141b`](https://github.com/aelmanaa/hardhat-kms/commit/4ae141b32ed94ff0c8202b0e526b598e168ca437) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `hardhat-kms` and each provider package, `@hardhat-kms/aws`, `@hardhat-kms/gcp` and `@hardhat-kms/azure`, now require each other at the same version. The peer dependency is exact, so npm refuses a mismatched install. When pnpm or Yarn installed a mismatch anyway, the first key of that provider fails with both versions and the install command.
  
  What should I do? Upgrade `hardhat-kms` and every `@hardhat-kms/*` package together.
  
  Issue: [#95](https://github.com/aelmanaa/hardhat-kms/issues/95)

- [#199](https://github.com/aelmanaa/hardhat-kms/pull/199) [`d783822`](https://github.com/aelmanaa/hardhat-kms/commit/d783822a7243fe2604abc4e007b86688f06161bd) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A `connection.kms.getAccount` account now has a viem `nonceManager`. Its sends and the plugin's own sends from the same account get distinct nonces. A client whose transport is `custom(connection.provider)` sends in order with the plugin's sends. A client with its own transport, such as `http(url)`, reserves its nonce for 60 seconds and prints a warning that the broadcast is not ordered. No RPC answer is rewritten, and raw transactions from other senders pass on untouched. A library send started from inside a send from the same account fails at once with `core.account.nonce-reentrant`. A send that waits 5 seconds behind a library send prints a warning, and another prints when the 60-second limit ends a hold. The viem peer range is now `^2.55.13`. `getAccount` refuses an older viem with `core.account.viem-too-old` before any KMS call. `core.account.viem-missing` no longer names a package manager. The warning printed on the first transaction a library account signs is gone.
  
  What should I do? If your project pins viem to an exact version below 2.55.13, such as `"viem": "2.47.6"`, bump it to 2.55.13 or later. With an older pin, npm stops the install with `ERESOLVE`, and pnpm and Yarn install it with a peer warning and `getAccount` then refuses it. On an automining node, a plugin send can be refused with "Nonce too high" while a client with its own transport signs or broadcasts its reserved nonce. Send through `custom(connection.provider)`, or wait for that send's receipt first.
  
  Issue: [#186](https://github.com/aelmanaa/hardhat-kms/issues/186)

- [#122](https://github.com/aelmanaa/hardhat-kms/pull/122) [`8af7ad7`](https://github.com/aelmanaa/hardhat-kms/commit/8af7ad7d38aac3e307708ac12d6ba8ef42ff103e) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `eth_sendTransaction` calls from one KMS account on one chain now run one at a time, so parallel sends get consecutive nonces. Other accounts and chains do not wait, and `eth_signTransaction` never waits. On http networks, a send without a `nonce` gets at least one more than the highest nonce the node accepted from that account on the connection, even when the node's pending count lags. A node's error answer to a broadcast, such as a revert, comes back unchanged. When no answer comes back, `eth_sendTransaction` fails with JSON-RPC error -32000 and the transaction hash in `transactionHash` and `data.hash`. The same request sent again on the same connection within 120 seconds then sends the same signed transaction again.
  
  Issue: [#25](https://github.com/aelmanaa/hardhat-kms/issues/25)

- [#117](https://github.com/aelmanaa/hardhat-kms/pull/117) [`04081e9`](https://github.com/aelmanaa/hardhat-kms/commit/04081e9733ff91ee698e4cc4adaa3c4c8e2476b2) Thanks [@aelmanaa](https://github.com/aelmanaa)! - KMS accounts now sign transactions. `eth_sendTransaction` fills the transaction as Hardhat does for a local account, signs it with the KMS key and sends it as `eth_sendRawTransaction`. `eth_signTransaction` returns the signed transaction without sending it. Legacy with EIP-155, EIP-2930, EIP-1559 and EIP-7702 transactions are supported, with the same bytes Hardhat's local accounts produce. A transaction without `from` gets the sender Hardhat would give it, and is signed when that sender is a KMS account. A pre-signed EIP-7702 authorization with a high-S or unrecoverable signature prints a warning.
  
  Issue: [#24](https://github.com/aelmanaa/hardhat-kms/issues/24)

- [#112](https://github.com/aelmanaa/hardhat-kms/pull/112) [`1cd9fee`](https://github.com/aelmanaa/hardhat-kms/commit/1cd9fee62a8499e2370b96dbefa6889e4516e50e) Thanks [@aelmanaa](https://github.com/aelmanaa)! - On `edr-simulated` networks, each new connection gives every KMS account the balance set in `kms.simulatedBalance`, so KMS accounts can pay for transactions in tests.
  
  Issue: [#103](https://github.com/aelmanaa/hardhat-kms/issues/103)

- [#108](https://github.com/aelmanaa/hardhat-kms/pull/108) [`e3a3f1f`](https://github.com/aelmanaa/hardhat-kms/commit/e3a3f1feb8af5e5e67cc411d82c8006814904eaf) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The plugin now refuses typed data whose `domain.chainId` differs from the connected chain. Typed data without `domain.chainId` is still signed, as MetaMask, Hardhat and Foundry do. The chain id is read once per connection and must match the network config's `chainId` when one is set.
  
  What should I do? To sign typed data for another chain on purpose, set `kms.allowCrossChainTypedData` to `true`.
  
  Issue: [#20](https://github.com/aelmanaa/hardhat-kms/issues/20)

### Patch Changes

- [#142](https://github.com/aelmanaa/hardhat-kms/pull/142) [`3945239`](https://github.com/aelmanaa/hardhat-kms/commit/3945239e0f401664aa0eb568f0d3ac565571df85) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The plugin now accepts an EIP-7702 authorization whose `r` or `s` is a quantity, the form viem sends. Before, the plugin refused an authorization whose `r` or `s` started with a zero byte. The plugin now refuses an `r` or `s` of 0, or of n or more, before any request to the node. It still refuses a value longer than 32 bytes, or not hex.
  
  Issue: [#140](https://github.com/aelmanaa/hardhat-kms/issues/140)

- [#173](https://github.com/aelmanaa/hardhat-kms/pull/173) [`6a5c004`](https://github.com/aelmanaa/hardhat-kms/commit/6a5c00400b7f62cd34cc0e9141daedebb0468a4d) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A provider that changes a byte array after returning or receiving it can no longer change which public key a signature is checked against, or the caller's message or typed data. A provider that returns something other than a byte array as its public key now fails with the key-material error, "expected a 65-byte uncompressed public key". Before, it failed as a provider call.
  
  Issue: [#172](https://github.com/aelmanaa/hardhat-kms/issues/172)

- [#160](https://github.com/aelmanaa/hardhat-kms/pull/160) [`f95fefd`](https://github.com/aelmanaa/hardhat-kms/commit/f95fefd8af55e93398b371dacb0a2c3e45dafe9b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Every error of `hardhat-kms` now has a stable id, a cause and a fix. The new errors reference, `docs/user/reference/errors.md`, lists them. Messages are unchanged. Third-party provider plugins keep building their errors with `kmsError`.
  
  Issue: [#72](https://github.com/aelmanaa/hardhat-kms/issues/72)

- [#397](https://github.com/aelmanaa/hardhat-kms/pull/397) [`2e33888`](https://github.com/aelmanaa/hardhat-kms/commit/2e338886fa7268450757f5e3bcb1403cb9497f3e) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A failed `eth_feeHistory` no longer makes every later KMS transaction on the connection legacy. With `gasPrice: "auto"`, the plugin asks `eth_feeHistory` a second time when the first request fails or gives an answer it cannot read. If the second fails too, only that transaction gets a legacy gas price, and the next transaction asks again. A request that times out is not asked a second time. A node that answers that it has no `eth_feeHistory` method (JSON-RPC code -32601) gets legacy gas prices for the rest of the connection, as with Hardhat. Hardhat's own local accounts still switch to legacy for the rest of the connection after any failure.
  
  Issue: [#395](https://github.com/aelmanaa/hardhat-kms/issues/395)

- [#233](https://github.com/aelmanaa/hardhat-kms/pull/233) [`bb2bfef`](https://github.com/aelmanaa/hardhat-kms/commit/bb2bfefeb4ba004258e6b6bc42b4f2ffdc857ee0) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The `--kms` option's help text no longer implies that Foundry has released an Azure signer. `aws` and `gcp` read Foundry's variables. `azure` reads the names proposed in foundry-rs/foundry#17120, which may change before Foundry ships it.
  
  Issue: [#221](https://github.com/aelmanaa/hardhat-kms/issues/221)

- [#268](https://github.com/aelmanaa/hardhat-kms/pull/268) [`894a82e`](https://github.com/aelmanaa/hardhat-kms/commit/894a82ec93f376eb7a2f6bb59ca2463bdf539141) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `kmsDebug` from `hardhat-kms/provider-utils` now refuses the namespaces hardhat-kms logs under, which are `account`, `config`, `history`, `providers`, `rpc` and `signer`. A reserved or malformed namespace throws a `HardhatPluginError` that names the namespace and the rule, `core.provider.debug-namespace-reserved` or `core.provider.debug-namespace-invalid`. Before, it threw a plain `Error` that asked for a bug report.
  
  What should I do? Log under your provider id, such as `kmsDebug("myvault")`. A namespace has at most 64 characters.
  
  Issue: [#257](https://github.com/aelmanaa/hardhat-kms/issues/257)

- [#198](https://github.com/aelmanaa/hardhat-kms/pull/198) [`e0cd4b3`](https://github.com/aelmanaa/hardhat-kms/commit/e0cd4b38adc8e8011ebe4dd721bbe2ae619179d6) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `kms history` now hides ids of 6 or 7 characters, such as a short Google Cloud project id, in user agents, `extra` fields, notes and the scope description. Before, any hidden value shorter than 8 characters was printed. A short id is hidden only as a whole word, so it is never cut out of a longer word. Scope ids are still shown in principals. A short `extraIds` value or reader hidden value is now hidden inside a principal too, as a longer one already was.
  
  Issue: [#189](https://github.com/aelmanaa/hardhat-kms/issues/189)

- [#279](https://github.com/aelmanaa/hardhat-kms/pull/279) [`6eb6808`](https://github.com/aelmanaa/hardhat-kms/commit/6eb68081631cf35930b96bdb09ea22a77fa980a9) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The Node.js policy is on the Support page of the docs, which the README links. The published packages run on Node.js 22.13.0 or later, the minimum Hardhat 3 enforces. A minor release may drop a Node.js line once it reaches end of life, never earlier.
  
  Issue: [#254](https://github.com/aelmanaa/hardhat-kms/issues/254)

- [#317](https://github.com/aelmanaa/hardhat-kms/pull/317) [`82a769d`](https://github.com/aelmanaa/hardhat-kms/commit/82a769d477dbfd3a23bf3425e1e00b2eeb32a43f) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The npm page of each package now shows the TypeScript indicator, an author link, a homepage that points at the documentation site and a description that names the cloud and Hardhat 3. The keywords start with `hardhat-plugin`. The provider packages also list `hardhat-kms`.
  
  Issue: [#301](https://github.com/aelmanaa/hardhat-kms/issues/301)

- [#230](https://github.com/aelmanaa/hardhat-kms/pull/230) [`87868a1`](https://github.com/aelmanaa/hardhat-kms/commit/87868a137359c7b945a12697aa7f7b9e70395887) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `core.signer.address-mismatch`, `azure.key.disabled`, `azure.key.no-sign-operation` and `azure.service.403` have new fix texts. Error codes are unchanged.
  
  `core.signer.address-mismatch` no longer suggests updating the configuration when a key derives to another address than its pin. It says that nothing was signed, that the key id may name the wrong key or a substituted one, or that the pin may be wrong, and points to the key rotation guide.
  
  `azure.key.disabled` and `azure.key.no-sign-operation` now print an `az keyvault key set-attributes` command with `--vault-name` or `--hsm-name`, `--name` and `--version`. Before, the command had no `--version`. A part of the key id read from a configuration variable is shown as `<vault-name>`, `<key-name>` or `<version>`. For an unversioned key id, the version is the one Key Vault returned. The fix text adds that the command needs the keys/update permission and, for a vault in another Azure cloud, `az cloud set`.
  
  `azure.service.403` now names the two data actions the identity needs on the key, `Microsoft.KeyVault/vaults/keys/read` and `Microsoft.KeyVault/vaults/keys/sign/action`, with Key Vault Crypto User as a built-in alternative, and points to step 2 of the Azure setup guide.
  
  Issues: [#215](https://github.com/aelmanaa/hardhat-kms/issues/215), [#223](https://github.com/aelmanaa/hardhat-kms/issues/223)

- [#337](https://github.com/aelmanaa/hardhat-kms/pull/337) [`a24d039`](https://github.com/aelmanaa/hardhat-kms/commit/a24d03912191f9e62201c59d5108f3d2f64807aa) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The provider contract in `hardhat-kms/types` is stable from 1.0. It covers `KmsKeyAdapter`, `SignContext`, `KeyDescription`, `SignatureOutput`, `TypedData`, the resolved key types, the provider config interfaces, the `kms.audit` config, the `kms` hook and the history reader types. A minor release may add optional members to them, a method to the `kms` hook, or a built-in provider. Changing or removing a member needs a major. `hardhat-kms/provider-utils` stays experimental and may change in a minor.
  
  Issues: [#292](https://github.com/aelmanaa/hardhat-kms/issues/292), [#333](https://github.com/aelmanaa/hardhat-kms/issues/333)

- [#370](https://github.com/aelmanaa/hardhat-kms/pull/370) [`bf2d0bf`](https://github.com/aelmanaa/hardhat-kms/commit/bf2d0bfd9b032c795173f8b264a99dc3d9b363d5) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The package READMEs link three new docs pages. They compare a KMS key with a private key in `.env`, with a Ledger used through hardhat-ledger, and with the Hardhat 2 KMS signer packages.
  
  Issue: [#309](https://github.com/aelmanaa/hardhat-kms/issues/309)

- [#318](https://github.com/aelmanaa/hardhat-kms/pull/318) [`e2c4fb4`](https://github.com/aelmanaa/hardhat-kms/commit/e2c4fb4c7df8d449b5910e085f9585e92e34ff83) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The `hardhat-kms` README now opens with badges, the three clouds, the install line with its peer dependencies and the config example. Below them it lists the `kms` tasks, the `--kms` option and how the plugin changes Hardhat. The Node.js policy moved to the Support page in the docs.
  
  Issue: [#302](https://github.com/aelmanaa/hardhat-kms/issues/302)

- [#348](https://github.com/aelmanaa/hardhat-kms/pull/348) [`caa0286`](https://github.com/aelmanaa/hardhat-kms/commit/caa02864a8a51bf3e3eb6abf40309a65715aa7eb) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The package READMEs, which are the npm pages, now say that 0.9.0 is the release candidate for 1.0.0, to use with test keys on testnets. Each one walks through one path: install, configure a key with a `chainId` on its network, run `npx hardhat kms accounts`, pin the printed address, then run `npx hardhat kms accounts --check-sign` to prove the credentials may sign. They state that the `address` pin is optional, and that AWS and Google Cloud keys use their SDK's credential discovery while Azure keys use the plugin's own chain. The three provider READMEs share one structure and no longer say the packages are unpublished. The full "Verify a release" procedure moved to a guide on the docs site; the core README keeps the `npm audit signatures` check and links the guide. Links in the READMEs point at the docs site.
  
  Issue: [#339](https://github.com/aelmanaa/hardhat-kms/issues/339)

- [#322](https://github.com/aelmanaa/hardhat-kms/pull/322) [`6fe2299`](https://github.com/aelmanaa/hardhat-kms/commit/6fe2299f341278f0c7df9ef7abc1b57b6322e06c) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The `hardhat-kms` README has a "Verify a release" section. It shows how to check a version's registry signatures with `npm audit signatures`, read its provenance and compare the tarball's files with the repository at the release tag. It also says what provenance proves and what to do when a check fails.
  
  Issue: [#287](https://github.com/aelmanaa/hardhat-kms/issues/287)

- [#347](https://github.com/aelmanaa/hardhat-kms/pull/347) [`2552333`](https://github.com/aelmanaa/hardhat-kms/commit/255233343cc3ea3a9e7f8e42268ad3c1b06d93b8) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The `kms sign-auth --self-broadcast` help now says that the task sends nothing. The flag signs the authorization for the pending nonce + 1, for when the same key sends the transaction that carries it. Before, the help said that the key also sends that transaction. The new help text is "Sign for the pending nonce + 1, for when this key sends the transaction that carries the authorization. The task sends nothing".
  
  Issue: [#338](https://github.com/aelmanaa/hardhat-kms/issues/338)

- [#155](https://github.com/aelmanaa/hardhat-kms/pull/155) [`f99866a`](https://github.com/aelmanaa/hardhat-kms/commit/f99866ad5cbd8c17ddbc00dc6e6d95c04b84fa4b) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A send that would wait on the send lock forever now fails. A send from a KMS account and chain, made by code that runs inside a send from the same account and chain, such as another plugin's network hook during the fill, fails at once. Before, it hung. A send that waits 120 seconds while none of the account's earlier sends finish fails. A send also fails at once when 1024 sends from the account and chain already wait. In each case the error names the account and the chain, and nothing is signed or sent. The two limits are not configurable.
  
  What should I do? A send that nothing awaits, such as one started from a listener the hook triggers, now rejects. Await and catch it, or start it after the outer send returns. An uncaught rejection ends the process.
  
  Issue: [#120](https://github.com/aelmanaa/hardhat-kms/issues/120)

- [#156](https://github.com/aelmanaa/hardhat-kms/pull/156) [`1d7ca55`](https://github.com/aelmanaa/hardhat-kms/commit/1d7ca5574200f02211185356f870d84ac6a308d5) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Connections created with `hre.network.create({ network, override })` now share the signers of other connections to AWS, Google Cloud and Azure keys, so a key is looked up once per runtime. Before, each connection looked the key up again. Keys that differ in their identifier as written in the config, `region`, `profile`, `endpoint`, `address`, `timeoutMs`, name or display still get their own signers. Keys of third-party providers still get a new signer for each override connection.
  
  Issue: [#105](https://github.com/aelmanaa/hardhat-kms/issues/105)

- [#389](https://github.com/aelmanaa/hardhat-kms/pull/389) [`355ca87`](https://github.com/aelmanaa/hardhat-kms/commit/355ca87e8c1d15d58ea0a21ccf5a4536341ab0df) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A request that names a KMS account as 20 bytes, a `Buffer` or a `Uint8Array`, now fails before anything is signed or sent. `eth_signTransaction` and `eth_sendTransaction` refuse such a `from` with `core.tx.from-bytes`. `eth_sign`, `personal_sign` and `eth_signTypedData_v4` refuse such an address with `core.accounts.address-bytes`. Both errors name the account's hex address. A byte array that names another account, or that is not 20 bytes long, goes on to Hardhat unchanged.
  
  What should I do? Pass the address as a 0x-prefixed hex string, for example with viem's `bytesToHex`. viem, ethers and hardhat-ethers already send it that way.
  
  Issue: [#371](https://github.com/aelmanaa/hardhat-kms/issues/371)

- [#124](https://github.com/aelmanaa/hardhat-kms/pull/124) [`3dff6d1`](https://github.com/aelmanaa/hardhat-kms/commit/3dff6d1d765e1402a7bba05c59606e8cb4997ec4) Thanks [@aelmanaa](https://github.com/aelmanaa)! - An "unknown account" error now ends with the network's KMS addresses. When a transaction or signing request names an address that is neither a KMS account nor a local account, the error from Hardhat or the node lists the checksummed KMS addresses, at most 10. The error keeps its class, code and data, and names no key ids. Other errors pass through unchanged.
  
  Issue: [#119](https://github.com/aelmanaa/hardhat-kms/issues/119)

- [#355](https://github.com/aelmanaa/hardhat-kms/pull/355) [`c98366e`](https://github.com/aelmanaa/hardhat-kms/commit/c98366ea32e1dd5f275d907e683f1657764de266) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The plugin now answers `wallet_sendCalls` (EIP-5792) from a KMS account with JSON-RPC error `-32601` (method not found), and the request no longer reaches the node. viem's `sendCalls` sends this method. Before, an endpoint that answered `wallet_sendCalls` with a batch id made viem report calls as sent that the KMS key never signed. Now, with `experimental_fallback: true`, viem sends each call as its own transaction, and the KMS key signs each one. Without it, `sendCalls` throws viem's `TransactionExecutionError`, whose details carry the plugin's message (catalogue entry `core.tx.wallet-send-calls-refused`). A `wallet_sendCalls` without `from`, or from any other address, passes through unchanged.
  
  What should I do? If you call viem's `sendCalls` from a KMS account, pass `experimental_fallback: true`, or send each call with `sendTransaction`.
  
  Issue: [#352](https://github.com/aelmanaa/hardhat-kms/issues/352)

- [#351](https://github.com/aelmanaa/hardhat-kms/pull/351) [`8e333da`](https://github.com/aelmanaa/hardhat-kms/commit/8e333daa5b7f7ffe481eeb29a4b71a0595dd769e) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The plugin now answers `wallet_sendTransaction` from a KMS account with JSON-RPC error `-32601` (method not found), and the request no longer reaches the node. viem sends this method once after an `eth_sendTransaction` error such as `-32000`. viem now throws the `eth_sendTransaction` error instead. When that send got no answer, the error carries the transaction hash. Later sends on the same client still go through `eth_sendTransaction`, so the KMS key signs each one. Before, an endpoint that answered `wallet_sendTransaction` with a hash made viem report that hash as sent, and every later send on the client skipped the plugin. A `wallet_sendTransaction` from any other address passes through unchanged. The new error is `core.tx.wallet-send-refused`.
  
  What should I do? Nothing, if you send with viem or hardhat-viem. ethers and Ignition never send `wallet_sendTransaction`. If your own code calls `wallet_sendTransaction` for a KMS account, call `eth_sendTransaction` instead.
  
  Issue: [#350](https://github.com/aelmanaa/hardhat-kms/issues/350)
