# hardhat-kms

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
