# @hardhat-kms/turnkey

## 1.3.0

### Minor Changes

- [#572](https://github.com/aelmanaa/hardhat-kms/pull/572) [`3892d18`](https://github.com/aelmanaa/hardhat-kms/commit/3892d181b937ff20e156ed014168e16db61be0a0) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Security change. `kms sign --no-hash` now asks at a terminal before it signs a raw digest, and signs only after `y` or `yes`. A raw digest can be the hash of an EIP-7702 authorization, and the plugin cannot tell. Without a terminal, the task signs only for a key with the new `allowRawDigests: true` field and with the new `--yes` flag. `--yes` skips the question only for such a key. A declined or unanswered question fails with `core.task.raw-digest-declined` and makes no sign request. `connection.kms.getAccount(address, { rawSign: true })` now fails with `core.account.raw-sign-not-allowed` unless the key sets `allowRawDigests: true`. Keys given with `--kms` cannot set it, so their raw digests need a terminal. Turnkey sends raw digests and EIP-7702 authorizations as the same `HASH_FUNCTION_NO_OP` request, so a Turnkey policy on authorizations binds only when that request is denied, as the Turnkey setup guide now shows.
  
  What should I do? Add `allowRawDigests: true` to each key in `kms.keys` or `kmsAccounts` that signs raw digests in CI or with `rawSign`, and pass `--yes` to `kms sign --no-hash` where no terminal is attached. Leave it off every other key.
  
  Issue: [#561](https://github.com/aelmanaa/hardhat-kms/issues/561)

### Patch Changes

- Updated dependencies [[`a2ec3d5`](https://github.com/aelmanaa/hardhat-kms/commit/a2ec3d50a46442ee91655961515f93dd87d19bc8), [`342cda7`](https://github.com/aelmanaa/hardhat-kms/commit/342cda7df0c047ad8c29c5014236d6320f349e78), [`3892d18`](https://github.com/aelmanaa/hardhat-kms/commit/3892d181b937ff20e156ed014168e16db61be0a0), [`cce6a8d`](https://github.com/aelmanaa/hardhat-kms/commit/cce6a8dc4dc6043fbf8dfb7e1398c24dbfb17243), [`3a7cf41`](https://github.com/aelmanaa/hardhat-kms/commit/3a7cf414aa7f08a858b8ee5aecc3b0c6ce510fff)]:
  - hardhat-kms@1.3.0

## 1.2.0

### Minor Changes

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

- [#539](https://github.com/aelmanaa/hardhat-kms/pull/539) [`465ac83`](https://github.com/aelmanaa/hardhat-kms/commit/465ac838524bd847325e836d903f4b5db5e836ba) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A 403 on a digest now says what the request sent: `(a digest, sent with HASH_FUNCTION_NO_OP and PAYLOAD_ENCODING_HEXADECIMAL: a policy that allows only SIGN_TRANSACTION, or only HASH_FUNCTION_KECCAK256, denies it)`. A digest is an EIP-7702 authorization, `kms sign --no-hash`, or a transaction of a key with `transactionSigning: "digest"`. Before, the `turnkey.service.forbidden` message gave no hint for them.
  
  Issue: [#536](https://github.com/aelmanaa/hardhat-kms/issues/536)

- [#550](https://github.com/aelmanaa/hardhat-kms/pull/550) [`1b68eec`](https://github.com/aelmanaa/hardhat-kms/commit/1b68eec706df0665dfb135ddf34543fa2a3a9fdb) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A Turnkey key whose `apiPrivateKey` or `organizationId` variable is not set now fails with Hardhat's own error, which names the variable, for example `HHE7: Configuration Variable "TURNKEY_API_PRIVATE_KEY" not found`. Before, `kms sign`, `kms accounts --check-sign` and a send failed with `the provider call failed (HardhatError)`, which did not say which variable was missing. The error names the variable, never a value. The signer passes on only this error, rebuilt from the variable's name; Hardhat's other errors still show as `the provider call failed (HardhatError)`, since some quote a value. AWS, Google Cloud and Azure keys read their variables when the adapter is created, so their errors do not change.
  
  What should I do? Nothing. If a Turnkey key fails with the HHE7 error, set the variable it names in the environment or in `hardhat-keystore`.
  
  Issue: [#544](https://github.com/aelmanaa/hardhat-kms/issues/544)
- Updated dependencies [[`3bed0ce`](https://github.com/aelmanaa/hardhat-kms/commit/3bed0ce8dbf90616398403549b9c61a60ea117d8), [`37cd6d5`](https://github.com/aelmanaa/hardhat-kms/commit/37cd6d557b8e6403d59709ba817751fb21229c1a), [`9af93d1`](https://github.com/aelmanaa/hardhat-kms/commit/9af93d152b9d8542c238b0dfa3177c036b6ec788), [`fab818f`](https://github.com/aelmanaa/hardhat-kms/commit/fab818fdc97795ba134aa491343cb087fc4f03d5), [`465ac83`](https://github.com/aelmanaa/hardhat-kms/commit/465ac838524bd847325e836d903f4b5db5e836ba), [`f735ed1`](https://github.com/aelmanaa/hardhat-kms/commit/f735ed128e40066f4bb0b1e0c8bb74f591306ba4), [`f952e64`](https://github.com/aelmanaa/hardhat-kms/commit/f952e64f38fd4d0aaaf936caadec2e8973a5ca61), [`c839a8a`](https://github.com/aelmanaa/hardhat-kms/commit/c839a8ac7e4ffa9787dbfb9707857cfe95cb9df0), [`93f9e40`](https://github.com/aelmanaa/hardhat-kms/commit/93f9e40f196efd4488279aef2e8ee1c39759f992), [`1b68eec`](https://github.com/aelmanaa/hardhat-kms/commit/1b68eec706df0665dfb135ddf34543fa2a3a9fdb)]:
  - hardhat-kms@1.2.0
