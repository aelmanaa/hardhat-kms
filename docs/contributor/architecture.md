# Architecture

Audience: Contributors and reviewers who want to understand how the code fits together.

Status: M1 implements the signing core (`crypto/`, `signer/`, the vendored EIP-712 encoder). M2 adds `config/`, the built-in providers' descriptors and key formats, the registry and the `kms` hook (`providers/`). M3 adds the AWS adapter, which lives in its own package, `packages/hardhat-kms-aws` ([#91](https://github.com/aelmanaa/hardhat-kms/issues/91)). M4 adds the network hook, the RPC dispatcher for accounts, messages and typed data, and the per-runtime signer cache ([#19](https://github.com/aelmanaa/hardhat-kms/issues/19)). M5 adds the transaction filler ([#23](https://github.com/aelmanaa/hardhat-kms/issues/23)), signing and sending transactions ([#24](https://github.com/aelmanaa/hardhat-kms/issues/24)), and the send guard ([#25](https://github.com/aelmanaa/hardhat-kms/issues/25)). M6 adds the Google Cloud adapter in `packages/hardhat-kms-gcp` ([#29](https://github.com/aelmanaa/hardhat-kms/issues/29)) and the Azure adapter in `packages/hardhat-kms-azure` ([#30](https://github.com/aelmanaa/hardhat-kms/issues/30)). M7 adds the `kms` task namespace. Its tasks are `kms accounts` ([#32](https://github.com/aelmanaa/hardhat-kms/issues/32)), `kms address` and `kms public-key` ([#33](https://github.com/aelmanaa/hardhat-kms/issues/33)), `kms sign` ([#34](https://github.com/aelmanaa/hardhat-kms/issues/34)), `kms sign-auth` ([#35](https://github.com/aelmanaa/hardhat-kms/issues/35)), `kms sign-tx` ([#36](https://github.com/aelmanaa/hardhat-kms/issues/36)) and `kms verify` ([#37](https://github.com/aelmanaa/hardhat-kms/issues/37)). The 1.0 milestone adds the library account, `connection.kms.getAccount` ([#51](https://github.com/aelmanaa/hardhat-kms/issues/51)). The code map gives each module's milestone.

## Module map

Each arrow points from a module to a module it may import. All modules are in `packages/hardhat-kms/src/` except the provider packages, which reach the core only through `hardhat-kms/types` and `hardhat-kms/provider-utils`.

```mermaid
flowchart TD
  index["index.ts<br/>plugin definition"] --> hooks["hook-handlers/<br/>config, hre, network"]
  index --> tasks["tasks/"]
  tasks --> history["history/<br/>kms history: time range, reader hook chain,<br/>report, masking"]
  history --> registry
  history --> descriptors
  hooks --> config["config/<br/>schema and resolution"]
  hooks --> registry["providers/registry.ts<br/>providers/create-adapter.ts"]
  hooks --> rpc["rpc/<br/>dispatcher: accounts, messages,<br/>transactions"]
  hooks --> signer
  hooks --> viem["viem/<br/>library account (getAccount)"]
  viem --> rpc
  viem --> signer
  rpc --> signer["signer/<br/>KmsSigner, signer cache, timeouts"]
  signer --> registry
  tasks --> signer
  tasks --> hooks
  registry --> descriptors["providers/aws, gcp, azure<br/>descriptor, key format"]
  signer --> crypto["crypto/<br/>keys, signatures, digests"]
  packages["provider packages<br/>@hardhat-kms/aws, @hardhat-kms/gcp, @hardhat-kms/azure:<br/>kms hook handlers, adapter, history reader"] --> utils["provider-utils.ts<br/>helpers for provider plugins"]
  utils --> crypto
  utils --> descriptors
  crypto --> vendor["vendor/micro-eth-signer<br/>EIP-712 encoder"]
```

The rules behind the arrows:

- `crypto/` is pure: no cloud SDK, no Hardhat runtime, no I/O. Everything in it is testable with vectors and property tests.
- `signer/` owns every check on the signature itself: parsing, low-S, parity recovery and verification. `KmsSigner` receives an adapter and never looks one up; the signer cache (`signer/key-cache.ts`) creates adapters through `providers/create-adapter.ts`.
- Adapters translate between the provider's wire format and `SignatureOutput`, and run the provider-specific identity checks listed in [Key identity and pinning](signing-pipeline.md#key-identity-and-pinning). They never decide whether a signature belongs to the key.
- The core depends on no cloud SDK. Each provider package depends on its own SDK and imports it only when it creates an adapter (see [SDK loading](#sdk-loading)), so loading a config never loads a cloud SDK.

## Packages

The repository is a pnpm workspace ([decision 0010](decisions/0010-pnpm-workspaces.md)). Following [decision 0009](decisions/0009-one-package-per-provider.md), each cloud provider has its own package around an SDK-free core:

| Package                      | Holds                                                                                                                                                                          | Status                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `packages/hardhat-kms`       | The core: config and key formats, signing checks, the `kms` hook, `--kms`, `hardhat-kms/provider-utils`                                                                        | Implemented                                                            |
| `packages/hardhat-kms-aws`   | The AWS plugin, adapter and CloudTrail history reader, depending on `@aws-sdk/client-kms`, `@aws-sdk/client-cloudtrail` and `@aws-sdk/client-sts`                              | Implemented ([#91](https://github.com/aelmanaa/hardhat-kms/issues/91)) |
| `packages/hardhat-kms-azure` | The Azure Key Vault plugin, credential chain, adapter and Log Analytics history reader, depending on `@azure/keyvault-keys`, `@azure/identity` and `@azure/core-rest-pipeline` | Implemented ([#30](https://github.com/aelmanaa/hardhat-kms/issues/30)) |
| `packages/hardhat-kms-gcp`   | The Google Cloud plugin, adapter and Cloud Logging history reader, depending on `@google-cloud/kms`, `google-gax` and `google-auth-library`                                    | Implemented ([#29](https://github.com/aelmanaa/hardhat-kms/issues/29)) |

## Code map

| Concept                                                                       | Where                                                                                                                                                             | Milestone |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Plugin definition                                                             | `packages/hardhat-kms/src/index.ts`                                                                                                                               | M0        |
| Public keys, signatures, digests                                              | `packages/hardhat-kms/src/internal/crypto/`                                                                                                                       | M1        |
| Signer and adapter interface                                                  | `packages/hardhat-kms/src/internal/signer/kms-signer.ts`, `packages/hardhat-kms/src/internal/signer/types.ts`                                                     | M1        |
| Per-call timeout                                                              | `packages/hardhat-kms/src/internal/signer/timeout.ts`                                                                                                             | M1        |
| Error builder                                                                 | `packages/hardhat-kms/src/internal/errors.ts`                                                                                                                     | M1        |
| Error catalogue                                                               | `packages/*/src/internal/error-catalog.ts`, `scripts/generate-errors-doc.ts`                                                                                      | M8        |
| Vendored EIP-712 encoder                                                      | `packages/hardhat-kms/src/internal/vendor/micro-eth-signer/`                                                                                                      | M1        |
| Config schema and resolution                                                  | `packages/hardhat-kms/src/internal/config/`                                                                                                                       | M2        |
| Provider descriptors and registry                                             | `packages/hardhat-kms/src/internal/providers/{registry,types}.ts`, `packages/hardhat-kms/src/internal/providers/*/descriptor.ts`                                  | M2        |
| `kms` hook for provider plugins                                               | `packages/hardhat-kms/src/internal/providers/create-adapter.ts`, `KmsHooks` in `packages/hardhat-kms/src/types.ts`                                                | M2        |
| Helpers for provider plugins                                                  | `packages/hardhat-kms/src/provider-utils.ts` (`hardhat-kms/provider-utils`)                                                                                       | M3        |
| `--kms` option (Foundry's variables)                                          | `packages/hardhat-kms/src/internal/config/env-keys.ts`, `packages/hardhat-kms/src/internal/hook-handlers/hre.ts`                                                  | M2, M4    |
| AWS plugin, `kms` hook handler, client settings and adapter                   | `packages/hardhat-kms-aws/src/index.ts`, `packages/hardhat-kms-aws/src/internal/{hook-handlers/kms,client-settings,adapter}.ts`                                   | M3        |
| Azure plugin, credential chain and adapter                                    | `packages/hardhat-kms-azure/src/index.ts`, `packages/hardhat-kms-azure/src/internal/{hook-handlers/kms,credential,adapter}.ts`                                    | M6        |
| GCP plugin, `kms` hook handler and adapter                                    | `packages/hardhat-kms-gcp/src/internal/hook-handlers/kms.ts`, `packages/hardhat-kms-gcp/src/internal/adapter.ts`, `packages/hardhat-kms-gcp/src/internal/wire.ts` | M6        |
| Network hook                                                                  | `packages/hardhat-kms/src/internal/hook-handlers/network.ts`                                                                                                      | M4        |
| Signer cache                                                                  | `packages/hardhat-kms/src/internal/signer/{key-cache,signer-identity}.ts`                                                                                         | M4, 1.0   |
| RPC dispatcher and methods                                                    | `packages/hardhat-kms/src/internal/rpc/dispatcher.ts` (accounts, messages, typed data, transactions)                                                              | M4, M5    |
| Transaction filler (port of Hardhat 3.18.0)                                   | `packages/hardhat-kms/src/internal/rpc/transaction-filler.ts`                                                                                                     | M5        |
| Transaction signing, EIP-7702 lint                                            | `packages/hardhat-kms/src/internal/rpc/transactions.ts`                                                                                                           | M5        |
| Send lock, nonce high-water mark, retries                                     | `packages/hardhat-kms/src/internal/rpc/send-guard.ts`, `sendTransaction` in `packages/hardhat-kms/src/internal/rpc/dispatcher.ts`                                 | M5        |
| Library account (`connection.kms.getAccount`)                                 | `packages/hardhat-kms/src/internal/viem/{account,inputs,types}.ts`, `connection.kms` set in `packages/hardhat-kms/src/internal/hook-handlers/network.ts`          | 1.0       |
| User warnings                                                                 | `packages/hardhat-kms/src/internal/warnings.ts`                                                                                                                   | M5        |
| `kms` namespace and task definitions                                          | `packages/hardhat-kms/src/index.ts`                                                                                                                               | M7        |
| Key lookup and signers for tasks                                              | `packages/hardhat-kms/src/internal/tasks/keys.ts`                                                                                                                 | M7        |
| `kms address`, `kms public-key`                                               | `packages/hardhat-kms/src/internal/tasks/{address,public-key}.ts`                                                                                                 | M7        |
| `kms sign`                                                                    | `packages/hardhat-kms/src/internal/tasks/sign.ts`                                                                                                                 | M7        |
| `kms verify`                                                                  | `packages/hardhat-kms/src/internal/tasks/verify.ts`                                                                                                               | M7        |
| Message and typed-data arguments of tasks                                     | `packages/hardhat-kms/src/internal/tasks/inputs.ts`, shared by `kms sign` and `kms verify`                                                                        | M7        |
| Typed-data parsing and chain check                                            | `packages/hardhat-kms/src/internal/rpc/typed-data.ts`, shared by `eth_signTypedData_v4`, `kms sign --data` and `kms verify --data`                                | M4, M7    |
| `kms accounts`                                                                | `packages/hardhat-kms/src/internal/tasks/accounts.ts`, `--balances` and `--check-sign` helpers in `account-checks.ts`                                             | M7, 1.0   |
| `kms sign-tx`                                                                 | `packages/hardhat-kms/src/internal/tasks/sign-tx.ts`                                                                                                              | M7        |
| `kms sign-auth`                                                               | `packages/hardhat-kms/src/internal/tasks/sign-auth.ts`                                                                                                            | M7        |
| `kms history`: range, reader hook chain, result checks, notes, masking, table | `packages/hardhat-kms/src/internal/tasks/history.ts`, `packages/hardhat-kms/src/internal/history/{time,read,report,mask,errors,types}.ts`                         | 1.0       |
| History readers: CloudTrail, Cloud Logging, Log Analytics                     | `packages/hardhat-kms-{aws,gcp,azure}/src/internal/history.ts`; AWS `history-api.ts`, GCP `logging-client.ts`, Azure `log-analytics.ts`                           | 1.0       |

## Signing a message

A `personal_sign` request for a KMS account reaches the provider only after the signer knows the key's address. The signer checks the returned signature twice before the hook answers. The hook half is `packages/hardhat-kms/src/internal/rpc/dispatcher.ts` (M4); the `KmsSigner` half is from M1.

```mermaid
sequenceDiagram
  participant C as Client (viem, ethers)
  participant H as Network hook
  participant S as KmsSigner
  participant A as Provider adapter
  participant K as Cloud KMS
  C->>H: personal_sign(message, address)
  H->>H: address is a KMS account?
  H->>S: signPersonalMessage(message)
  S->>A: getPublicKey (first use only)
  A->>K: get public key
  S->>S: derive address, check address pin (first use only)
  S->>A: signMessage(message, digest), else signDigest(EIP-191 digest)
  A->>K: sign digest
  K-->>A: DER or r || s
  A-->>S: SignatureOutput
  S->>S: parse, range check, low-S, recover parity, verify
  S->>S: EIP-191 verification against the address
  S-->>H: 0x r || s || v
  H-->>C: signature
```

## Sending a transaction

An `eth_sendTransaction` from a KMS account is filled, signed and broadcast by the hook, under the send lock for its chain and address. The signer is held for the fill and the signature only, not for the broadcast. A retry of a request whose broadcast failed skips the fill and the signature and sends the same bytes again (see [Retries after broadcast](transactions.md#retries-after-broadcast)).

```mermaid
sequenceDiagram
  participant C as Client
  participant H as Network hook
  participant F as Transaction filler
  participant S as KmsSigner
  participant N as Hardhat handlers and node
  C->>H: eth_sendTransaction(tx)
  H->>N: eth_chainId (once per connection)
  H->>H: take lock chainId:from
  H->>N: eth_getTransactionByHash for an earlier send with no answer, if any
  H->>F: fill nonce, gas, fees, chainId
  F->>N: reads through connection.provider (pass through the hook)
  H->>H: nonce = max(pending, high-water + 1, highest reservation + 1)
  H->>S: sign the unsigned transaction's digest
  S-->>H: verified signature
  H->>H: rebuild signed tx, check sender == from
  H->>N: next(eth_sendRawTransaction), exactly once
  N-->>H: hash
  H->>H: raise the high-water mark, release lock
  H-->>C: hash
```

The chain id comes first because the lock is keyed by it (`packages/hardhat-kms/src/internal/rpc/dispatcher.ts:628-636`). Inside the lock, a send without a caller's nonce first asks the node about the account's uncertain transaction (`dispatcher.ts:658-660`), then takes its nonce from `ConnectionSends.nonceFor`: the node's pending count, raised past the high-water mark and past every nonce reserved for a library account's client on the connection (`dispatcher.ts:669`, `packages/hardhat-kms/src/internal/rpc/send-guard.ts:579-592`). On `edr-simulated` networks the high-water mark is off; reservations still count.

The rules that keep this safe are in [Request flow and re-entrancy rules](#request-flow-and-re-entrancy-rules) and in [Transactions](transactions.md).

## Library accounts

`connection.kms.getAccount(address)` returns a viem `LocalAccount` for one of the connection's KMS accounts ([Library accounts](../user/reference/library-accounts.md)). The network hook sets `connection.kms` on every connection, as hardhat-viem sets `connection.viem`. `packages/hardhat-kms/src/internal/viem/account.ts` builds the account; `inputs.ts` reads what viem passes and refuses what the account does not sign; `types.ts` holds the public types, which are written without viem's so that a project without viem typechecks.

The account is a second path into the same signers. It finds the key through the connection's `ConnectionAccounts` and signs through the signer cache's `signWith`, so the idle close and the signature checks are the RPC path's. It reuses the RPC path's pieces: `checkTypedDataChain` for typed data, `assembleSignedTransaction` for the recovery check of a signed transaction, and `authorizationDigest` for EIP-7702. It does not reuse the filler or the retry cache: viem fills and sends a local account's transactions itself. The account carries a viem `nonceManager`: for each send without a nonce, viem asks it for one, and the connection chooses it under the account's send lock as a plugin send would. With a client that sends through the connection, the send keeps the lock until its `eth_sendRawTransaction`, which the dispatcher recognises by its sender and nonce, goes out, or until viem resets it after a failure. A client with its own transport only reserves its nonce, and a warning says its broadcast is not ordered ([Library accounts: nonces and raw transactions](transactions.md#library-accounts-nonces-and-raw-transactions)). The network hook's `closeConnection` adds the connection to a `WeakSet`, and the account checks it right before each KMS call (and `getAccount` also before its key lookup), so a connection closed even during a call refuses before the KMS is asked.

```mermaid
sequenceDiagram
  participant V as viem
  participant A as Library account
  participant N as Node, through connection.provider
  participant S as KmsSigner
  V->>A: signTransaction(tx, { serializer })
  A->>A: read the fields, refuse type 3, other types, no chainId
  A->>N: eth_chainId
  A->>A: refuse another chain
  A->>A: serialize with micro-eth-signer, and with viem's or the chain's serializer
  A->>A: refuse when the unsigned bytes differ
  A->>S: sign keccak256(unsigned bytes)
  S-->>A: verified signature
  A->>A: rebuild signed tx, check sender == account
  A-->>V: signed transaction
  V->>N: eth_sendRawTransaction (as the send that holds the lock, otherwise unchanged)
```

Every refusal comes before the KMS call. The unit tests in `packages/hardhat-kms/test/unit/viem/account.test.ts` count the fake adapter's calls around each refusal, and compare every method's output with viem's `privateKeyToAccount` on the same key. `signAuthorization` returns no `v`, so its comparison leaves out viem's `v`.

viem is an optional peer dependency (`peerDependenciesMeta`). `account.ts` loads it with a dynamic `import("viem")` in `getAccount`, and no other module imports it, so the hook and task modules that Hardhat loads never need it. `packages/hardhat-kms/test/integration/no-viem.test.ts` runs every task, a send and a signature in a process where viem cannot be resolved, and checks that only `getAccount` asks for it. The account keeps no signer, key config or key material: it is a frozen object of strings and closures. `sign({ hash })` exists only with `rawSign: true` ([decision 0014](decisions/0014-library-account-raw-sign.md)).

## Goals

hardhat-kms is an MIT-licensed Hardhat 3 plugin that signs transactions and messages with secp256k1 keys held in cloud KMS and HSM services. Version 1 supports three providers:

- AWS KMS
- GCP Cloud KMS
- Azure Key Vault and Azure Managed HSM

The design has three goals:

1. Existing tooling works unchanged. viem, ethers, Ignition and plain scripts see KMS keys as ordinary accounts, because the plugin works at the JSON-RPC layer through a network hook.
2. Parity with Foundry's KMS support, or better. Every Foundry key form and command has an equivalent, and the plugin adds checks Foundry does not have.
3. A new KMS or HSM is one provider plugin: a package with a `kms` hook handler and an adapter.

Private key material never leaves the KMS. The plugin sends a 32-byte digest (or, for policy-aware providers, the structured request) and gets a signature back. Every signature is then verified locally before anything uses it.

## Module layout

```
packages/hardhat-kms/src/
  index.ts                  definePlugin: types, constants, lazy hook/task imports only (Hardhat plugin guideline)
  type-extensions.ts        augments HardhatUserConfig/HardhatConfig (kms) + Http/Edr Network(User)Config (kmsAccounts); no named exports
  types.ts                  public provider-author types (exported via the "hardhat-kms/types" subpath)
  provider-utils.ts         helpers for provider plugins (the "hardhat-kms/provider-utils" subpath, @experimental)
  internal/
    config/                 zod v3 schema rooted at HardhatUserConfig; conditionalUnionType on `provider`; superRefine for named-key refs
                            (path ["networks", n, "kmsAccounts", i]); pure resolve; key-identity.ts: when two keys are one KMS key
    hook-handlers/
      config.ts             validate/resolve (imports provider *descriptors* only)
      hre.ts                reads --kms when the runtime is created; keeps the keys per runtime
      network.ts            newConnection (default-network warning) / onRequest / closeConnection
    providers/
      registry.ts           provider id -> descriptor; a built-in provider = one folder + its types + one entry here
      create-adapter.ts     runs the `kms` hook chain; a key no handler claims fails; checks the adapter
      aws/ gcp/ azure/      descriptor.ts (zod schema, resolve incl. displayId, name, adapter package or tracking issue)
                            config.ts, key-id.ts (pure: key formats and parsing)
    crypto/                 pure, no SDKs: public-key.ts, signature.ts, address.ts, crc32c.ts
    signer/
      key-cache.ts          SignerCache: per-runtime signers by signer identity; idle close after the last connection
      signer-identity.ts    what makes two copies of a first-party key share a signer (never printed)
      kms-signer.ts         signDigest -> {r, s, yParity}: parse -> range -> low-S -> trial recovery -> verify
    rpc/
      dispatcher.ts         request flow (see "Request flow and re-entrancy rules"); ConnectionAccounts;
                            accounts, eth_sign, personal_sign, eth_signTypedData_v4
      typed-data.ts         readTypedData, checkTypedDataChain: shared with kms sign --data
      transactions.ts       fill, sign, rebuild and check a KMS account's transaction; EIP-7702 authorization lint
      transaction-filler.ts port of Hardhat 3.18.0's fill logic; builds the unsigned transaction and its signing hash
      send-guard.ts         process-global send lock; per connection: nonce high-water marks, retry entries,
                            uncertain transactions; SendOutcomeUnknownError
    tasks/                  keys.ts: key lookup by name, signers closed after each run, printLine;
                            inputs.ts: message and --data arguments; one action module per task:
                            accounts, address, history, public-key, sign, sign-auth, sign-tx, verify
    history/                kms history: time range, the readSignHistory hook chain, result checks,
                            report and masking; provider packages supply the readers
    vendor/micro-eth-signer/  vendored EIP-712 hashing (MIT, see "Vendored EIP-712")
    errors.ts               allow-listed error builder; catalogError, catalogMessage, internalError
    error-catalog.ts        every error the core builds: id, message template, cause, fix
    warnings.ts             the one console.warn: warnings for the user
    debug.ts                coreDebug (hardhat:kms:account, config, history, providers, rpc, signer) and kmsDebug for provider packages; plain values only
```

The plugin object sets `npmPackage: "hardhat-kms"`. The config hook handler imports provider descriptors only, and no descriptor imports an SDK.

Each provider package has the same small layout. For AWS:

```
packages/hardhat-kms-aws/src/
  index.ts                  definePlugin: id and npmPackage "@hardhat-kms/aws", depends on hardhat-kms,
                            lazy `kms` hook handler import; references "hardhat-kms/types" for the config types
  internal/
    hook-handlers/kms.ts    claims `aws` keys, passes other keys to next; imports the adapter and the SDK on first use;
                            reads sign history for `kms history`
    client-settings.ts      the region and profile of the SDK clients; reads configuration variables
    adapter.ts              createAwsKeyAdapter(key, sdk, userAgent): GetPublicKey, Sign, key spec checks, ARN pinning
    history.ts              reads CloudTrail Sign events into the history report
    history-api.ts          the CloudTrail, STS and KMS clients of one history read
```

`packages/hardhat-kms-azure` follows it, with one more module, `internal/credential.ts`, which builds the credential chain that all Azure keys of a runtime share ([Cloud access and credentials](#cloud-access-and-credentials)). Its history reader is `history.ts`, with the Log Analytics query in `log-analytics.ts`. Its handler loads `@azure/keyvault-keys`, `@azure/identity`, the credential module and the adapter together, once per runtime. Key Vault's formats need no module of their own: the public key is a JWK, which `publicKeyFromJwk` in `hardhat-kms/provider-utils` reads, and signatures are 64 bytes `r || s`, which the core parses. `packages/hardhat-kms-gcp` follows it too, with a pure `wire.ts` that reads the CRC32C checksums and the gRPC status codes of Google Cloud's responses, and a history reader in `history.ts` and `logging-client.ts`.

## Request flow and re-entrancy rules

The dispatcher follows these rules. They keep the hook from deadlocking on its own internal calls and make each request's side effects easy to reason about.

1. Pass-through is the default. Only `eth_accounts`, `eth_requestAccounts`, the five signing methods and, for a KMS account whose address the connection has looked up or whose library send holds the lock, `eth_sendRawTransaction` and `eth_sendRawTransactionSync` are inspected. A raw transaction goes on unchanged, in turn with the account's sends (rule 4), and its answer comes back unchanged. Everything else goes straight to `next`, so no allow-list of other methods is needed. A signing method that passes through comes back as the rest of the chain answered it, with one exception: an "unknown account" error gets the KMS addresses appended (`passThrough` and `isUnknownAccount` in `packages/hardhat-kms/src/internal/rpc/dispatcher.ts`). The thrown error's `message` and `stack`, and a `HardhatError`'s `formattedMessage` (the text Hardhat's CLI prints), are changed in place, so its class, `code`, `data` and Hardhat error number stay. If one of those writes fails, as on a frozen error, the others are undone and the error is rethrown as it came. An error that already carries the list is left alone, and an error answer is copied with the new message.
2. `next` is called at most once per request. Every internal RPC call (for example the reads during fill) goes through `connection.provider.request`, which re-enters the hook chain and is passed through by rule 1.
3. Per-runtime and per-connection state (`SignerCache`, `ConnectionAccounts`) is memoised as promises, with no lock. A failed promise is dropped, so the next request retries.
4. `eth_sendTransaction` for KMS address `a` on chain `c` takes the process-global lock `c:a`. Inside the lock the code may issue read calls (fill), make any number of KMS signature attempts (retries), and make exactly one `next(eth_sendRawTransaction)`. A library account's send takes the same lock when its viem `nonceManager` chooses the nonce, and, with a client that sends through the connection, keeps it until its `eth_sendRawTransaction` or `eth_sendRawTransactionSync` goes out (one `next`) or viem resets it. Any other raw transaction from a KMS account takes the lock around its one `next`.
5. `eth_signTransaction` takes no lock and never touches the nonce high-water mark, because it never broadcasts.

## Other signing plugins

Hardhat runs dynamically registered handlers first, then plugins in reverse order of the `plugins` array, and its built-in handlers last. Another plugin that intercepts `eth_accounts` or `eth_sendTransaction`, such as `@nomicfoundation/hardhat-ledger`, therefore runs before or after hardhat-kms depending on where each appears in `plugins`. A provider package such as `@hardhat-kms/aws` depends on hardhat-kms, so Hardhat places hardhat-kms just before it.

hardhat-kms only acts on addresses it owns and passes everything else on. hardhat-ledger also passes requests for other addresses on, but only after it has validated their params: `LedgerHandler.handle` runs `validateParams` on `personal_sign`, `eth_sign`, `eth_signTypedData_v4` and `eth_sendTransaction` before it checks who owns the address. `packages/hardhat-kms/test/integration/ledger.test.ts` checks both orders. The order has three effects:

- `eth_accounts`: each plugin appends its addresses to the list the rest of the chain returns, so the plugin whose hook runs first lists its addresses last. With `plugins: [hardhatKms, hardhatLedger]`, a network lists its own accounts, then the KMS addresses, then the Ledger addresses; the other order swaps the last two groups. Code that picks an account by index, such as Ignition's `m.getAccount(index)`, sees the difference.
- `eth_requestAccounts`: hardhat-ledger passes it on unchanged, and hardhat-kms answers it by asking the rest of the chain for `eth_accounts`. The Ledger addresses are listed only when hardhat-ledger comes first in `plugins`, so that its hook runs after hardhat-kms's.
- Transactions without `from`: Hardhat sets the default sender in its built-in handlers, after both plugins. When hardhat-ledger's hook runs first, its schema requires `from`, so it rejects the transaction with a `ZodError` before hardhat-kms sees it, as it does when loaded alone. When hardhat-kms's hook runs first, hardhat-kms sets the default sender (see [Sender resolution](transactions.md#sender-resolution)), and the transaction goes on with `from` set.

The user documentation therefore recommends listing hardhat-ledger first ([Other signing plugins](../user/reference/configuration.md#other-signing-plugins)).

## Tasks

The plugin definition declares `emptyTask("kms")` and one `task(["kms", <name>])` per task, each with `setAction(() => import(...))`, as hardhat-keystore does. Defining the tasks loads no action module and no SDK. The SDK-loading tests in the provider packages check both, and that running `kms address`, `kms public-key`, `kms sign-tx` and `kms verify --key` on another provider's key, or `kms accounts` on the other providers' keys, loads no SDK.

Every task that takes a key uses `packages/hardhat-kms/src/internal/tasks/keys.ts`:

- `taskKeys(hre)` lists the keys a task can name, each once: `kms.keys`, then the inline keys of each network's `kmsAccounts`, then the `--kms` keys from `commandLineKeys(hre)`. Each `TaskKey` has the key's `name`, its `source` (`"kms.keys"`, `"kmsAccounts"` or `"--kms"`) and the resolved `key`.
- `findTaskKey(hre, name)` returns the key with that name. An unknown name fails with the known names, and suggests one that differs only in case. A name that more than one key has, such as a `kms.keys` key and a `--kms` key, fails with their sources.
- `withTaskSigners(hre, use)` gives `use` a `signerFor(key)` function backed by a new `SignerCache`, and closes every signer in a `finally`. A task run therefore never shares the network hook's signers, and the process exits once the task returns. The cache's display function writes adapters' status messages to standard error with `printNote`; the network hook's cache keeps Hardhat's `interruptions.displayMessage`, which prints to standard output. `withNamedSigner(hre, name, use)` combines it with `findTaskKey` for single-key tasks.
- `printLine(line)` writes the result to standard output, and `printNote(line)` writes a note to standard error, prefixed with `[hardhat-kms]`.

`kms address` uses `KmsSigner.confirmedAddress()`, which, unlike `getAddress()`, asks an address-only adapter even when the key has a pin, and says when the address is an unchecked pin. An action module's default export is a `NewTaskActionFunction`. It prints its result with `printLine` and also returns it, so `hre.tasks.getTask(["kms", "address"]).run({ key })` gives the value to scripts and tests. Errors are `HardhatPluginError`s from the [error catalogue](#errors), which the CLI prints and turns into exit code 1. The key's argument is the positional argument `key`, described by `KEY_ARGUMENT_DESCRIPTION` in `index.ts`. The user-facing rules are in the [tasks reference](../user/reference/tasks.md).

`kms sign` checks its input before it opens a signer. Typed data goes through `readTypedData` and `checkTypedDataChain` in `rpc/typed-data.ts`, the functions `eth_signTypedData_v4` uses, and the chain to compare with is `--chain`, else the `chainId` in the `--network` config. Only a network config without `chainId` makes the task open a connection to read `eth_chainId`; creating it runs the network hook, which can call the KMS, since Hardhat funds an `edr-simulated` network's accounts then. After signing, the task recovers the address from the printed `r || s || v` and refuses a signature that does not recover to the key. That catches a substituted or wrong signer output. It is no independent check of the digest: the task computes the digest with the signer's own code.

`kms sign-auth` also checks its flags, the delegate, `--chain` and `--nonce` before it opens a signer, and refuses chain 0 without `--force` before any KMS call. It opens a connection only when the command line and the `--network` config leave something to read: `eth_getTransactionCount` with `pending` for the authority's nonce, or `eth_chainId` when the config sets no `chainId`. The connection opens once, on first use, and closes in a `finally`. The task signs `authorizationDigest` from `crypto/digests.ts` with `signDigest` and builds the JSON tuple. It then reads the tuple back, computes the digest again from its fields, and refuses it unless the authority recovered from it is the key's address and `s` is low. That covers the step from signature to printed output as well as a substituted signature. It is no independent check of the digest: the task computes the digest with the same `authorizationDigest` it signs. Before the KMS call, the task writes a summary line to standard error (authority, chain and its source, nonce, delegate), and with an open connection it warns when `eth_getCode` finds no code at the delegate.
`kms sign` and `kms verify` read their message the same way, through `tasks/inputs.ts`: `readMessage` decodes `0x` hex or UTF-8, and `readTypedDataArgument` reads `--data` JSON, from the file with `--from-file`, through `readTypedData`. `kms verify` checks every input before it contacts the KMS, then parses the signature with `parseRpcSignature` in `crypto/signature.ts`, which reads `v` and folds a high-S signature to low S as alloy does, and recovers the address with `recoverAddress`. With `--key`, it gets the key's address with `confirmedAddress()`, as `kms address` does; with `--address`, it opens no signer. A mismatch returns Hardhat's `errorResult`, which the CLI turns into exit code 1 without printing an error.

`kms accounts` takes no key. It lists `taskKeys(hre)`, or, with `--network`, that network's `kmsAccounts` followed by `commandLineKeys(hre)`, and resolves every key with `confirmedAddress()` inside one `withTaskSigners`, at most `ACCOUNTS_CONCURRENCY` (8) keys at a time. Without `--network`, keys with the same `keyIdentity()` and the same pin are listed once, and the row keeps every merged entry's name and source, so each config entry gets its pin line. With `--network`, the same function finds a `--kms` key that repeats a network entry, for a note. `keyIdentity()` lives in `packages/hardhat-kms/src/internal/config/key-identity.ts` and is the same function the dispatcher uses to refuse a `--kms` key that repeats a config key. A key's failure is caught and kept in its entry, so one key cannot hide the others. The task returns a Hardhat `Result` from `hardhat/utils/result`; the CLI sets exit code 1 for a failed one without printing an error. The report's types, `AccountsReport` and `AccountEntry`, are exported from `hardhat-kms/types`, and the report carries `version: 1`.

`kms sign-tx` signs with the code that signs `eth_signTransaction`. It opens a connection to the `--network` network with `hre.network.create`, builds a `ConnectionChain` with `createConnectionChain` and a filler with `createTransactionFiller`, as the network hook does for each connection, and calls `signTransaction` with the task's signer. Its fill reads go through `connection.provider` and the hook chain, so the key does not need to be one of the network's accounts. The task's own checks come before the KMS signs: `--network` is set, the file is one JSON object, every field is an `eth_sendTransaction` field or `type`, quantities are `0x` hex, mixed-case addresses carry a valid EIP-55 checksum, and `from`, when set, is the key's address. A requested `type` is compared with the built transaction through `signTransaction`'s `checkUnsigned` option, before the KMS signs. The task closes its connection and prints the raw transaction to standard output, as `cast mktx` does, and the hash to standard error with `printNote`; it has no code path that sends either. `KNOWN_FIELDS` comes from a `Record<keyof RpcTransactionRequest, true>`, so the compiler keeps it equal to Hardhat's request type, and a test pins it to the runtime schema's keys.

## Lifetimes and caching

The network hook's factory runs once per runtime. Its closure holds a `SignerCache` (`packages/hardhat-kms/src/internal/signer/key-cache.ts`), so every connection of the runtime shares the same signers, and an address is looked up once. A connection created with an `override` resolves the config again and gets new key objects, so the cache does not key AWS, Google Cloud and Azure keys by object. It keys them by a signer identity (`packages/hardhat-kms/src/internal/signer/signer-identity.ts`): the provider, the identifier as written in the config, for AWS the `region`, `profile` and `endpoint` (even for an ARN, since the profile selects the credentials), and the key's `name`, `displayId`, `address` pin and `timeoutMs`. Google Cloud and Azure keys have no other connection settings: their credentials and endpoints come from the environment, and an Azure key URL names its vault. Copies of a key therefore share one signer, and keys that differ in any of these settings get their own.

The identity never reads a configuration variable. It uses each identifier's comparison form (`identifierComparisonForm` in `packages/hardhat-kms/src/internal/config/identifiers.ts`), built from the raw config when the config resolves: a literal gives its value, a configuration variable its name, `format` and `default`, and a joined identifier (Google Cloud or Azure components) its parts' forms, joined as the value is. A variable's `default` can be a secret, so the form is kept in a WeakMap rather than on the identifier, where printing a resolved config would show it, and it is never printed or logged. An identifier that config resolution did not build has no form, and its key is cached by object. The cache computes the identity and stores the signer's promise with no `await` in between, so the idle close always sees it. The adapter stays the first to read the value, after the provider plugin's version check and its "install the package" error, so a keystore password prompt comes after those errors, as before. The signer reads a variable once, when it is created; two variables that hold the same value get two signers. Keys of third-party providers are cached by object, since the core cannot tell which of their settings matter. Because the name is part of the identity, two key entries that name the same KMS key, such as a named key and an inline key, get two signers, and errors name the right key. On one network, the dispatcher then refuses them as the same account. A signer that fails to open is not cached.

Each connection with KMS keys gets a `ConnectionAccounts` (`packages/hardhat-kms/src/internal/rpc/dispatcher.ts`), which maps its addresses to keys. Its lookups run in parallel on first use, and a failed lookup is not cached. A connection also gets one `ConnectionChain`, on its first KMS transaction one `TransactionFiller`, and on its first KMS send one `ConnectionSends` (its nonce high-water marks and retry entries), each held in a WeakMap keyed by the connection. Closing the connection drops the filler and the send state, and cancels the retry entries' timers. The send lock is process-global, keyed by chain id and address, and holds no state once its queue is empty.

The cache counts connections that have KMS keys, for the whole cache rather than per signer. A signer shared by a plain and an override connection therefore stays open while either is open. Five seconds after the last of them closes, an `unref`'d idle timer closes every signer once, and with them the adapters and SDK clients; the next use creates them again. A connection that opens before the timer fires cancels it, and a connection closed twice is counted once. While a request is still signing, the idle close waits and tries again, so the request keeps its SDK client. A running request also starts the timer, even before its signer is cached. Because the timer is `unref`'d and nothing else holds the event loop, a script that signs and never closes its connection still exits. `packages/hardhat-kms-aws/test/integration/network.test.ts` checks this with `packages/hardhat-kms-aws/test/fixtures/sign-and-exit.ts`. The GCP adapter creates its client with `{ fallback: true }` (REST), so no gRPC channel keeps `hardhat run` alive; `packages/hardhat-kms-gcp/test/integration/network.test.ts` runs the same exit check with `packages/hardhat-kms-gcp/test/fixtures/sign-and-exit.ts`.

Status messages from adapters go to Hardhat's `interruptions.displayMessage` with the title `hardhat-kms`.

## Cloud access and credentials

The core never sees a credential. It builds a signer for a key through the signer cache, which runs the `kms` hook chain (`createKeyAdapter`), and the provider package that claims the key builds the SDK client. On AWS and Google Cloud the client gets no credential options, so the cloud's SDK walks its own default chain. On Azure the package builds the chain itself. The user-facing rules, with the variables each source reads, are in the [configuration reference](../user/reference/configuration.md#credentials) and [How the plugin reaches your cloud](../user/explanation/cloud-access.md).

What all three providers share:

- The signer cache keys signers by signer identity, so a new client is built only for a new identity (`packages/hardhat-kms/src/internal/signer/key-cache.ts:79-94`). An AWS identity holds the key's `region`, `profile` and `endpoint`; a Google Cloud or Azure identity holds none of those, since the environment picks their credentials (`packages/hardhat-kms/src/internal/signer/signer-identity.ts:53-74`).
- A new signer gets its adapter from the hook chain (`key-cache.ts:149`, `packages/hardhat-kms/src/internal/providers/create-adapter.ts:123-132`), and each provider's handler checks its version against the core's before it loads its SDK.
- Five seconds after the last connection with KMS keys closes, the idle close closes every signer and with it every adapter (`key-cache.ts:13`, `key-cache.ts:104-145`, `packages/hardhat-kms/src/internal/signer/kms-signer.ts:236-237`). The next request builds the client and looks up credentials again.
- `kms history` runs the `readSignHistory` hook chain (`packages/hardhat-kms/src/internal/history/read.ts:111-127`). Its readers build their own clients for each read and never share the signers' clients.

SDK lines below are from the versions in `pnpm-lock.yaml`: `@aws-sdk/client-kms` 3.1143.0, `@aws-sdk/core` 3.978.1, `@aws-sdk/credential-provider-node` 3.972.84, `google-gax` 6.10.0, `google-auth-library` 11.1.0 and `@azure/identity` 4.13.3. Paths are relative to each package's directory in `node_modules`.

### AWS

```mermaid
flowchart TD
  subgraph build["Client: one KMSClient per signer identity"]
    key["AWS key config<br/>keyId, region, profile, endpoint"] --> identity["Signer identity<br/>keyId, region, profile, endpoint"]
    identity --> cached{"Signer cached for<br/>this identity?"}
    cached -->|no| handler["kms hook handler<br/>loads the adapter and @aws-sdk/client-kms"]
    handler --> settings["awsClientSettings<br/>region: key ARN, else region,<br/>else kms.defaults.aws.region<br/>profile; an empty variable is unset"]
    settings --> client["new KMSClient<br/>customUserAgent, region, profile, endpoint"]
    client -.->|idle close| destroy["client.destroy()"]
  end
  client --> profile
  subgraph chain["Credential chain: the SDK's default provider, first source that returns credentials"]
    profile{"Profile set?<br/>key profile, else AWS_PROFILE"}
    profile -->|no| env["1. Environment keys<br/>AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY"]
    profile -->|"yes: environment keys skipped"| ini
    env -->|not set| ini["2. Shared config files, selected profile or default<br/>keys, SSO, aws login, assume role, credential_process"]
    ini -->|no credentials| proc["3. The profile's credential_process"]
    proc -->|no credentials| web["4. Web identity token<br/>AWS_WEB_IDENTITY_TOKEN_FILE and AWS_ROLE_ARN"]
    web -->|not set| container{"AWS_CONTAINER_CREDENTIALS_<br/>RELATIVE_URI or FULL_URI set?"}
    container -->|yes| ecs["5. Container credentials<br/>ECS task role, EKS Pod Identity"]
    container -->|no| imds["5. EC2 instance role through IMDS<br/>unless AWS_EC2_METADATA_DISABLED"]
  end
```

Where each step is:

- Key config to signer identity: the identity holds the comparison forms of `region` and `profile` and the `endpoint` (`packages/hardhat-kms/src/internal/signer/signer-identity.ts:61-74`). Two keys that differ in any of them get two signers, and so two clients.
- Signer cache to handler: `packages/hardhat-kms-aws/src/internal/hook-handlers/kms.ts:48-63` claims `aws` keys, checks the version and imports `adapter.ts` and `@aws-sdk/client-kms`.
- The region order: a literal key ARN's region, then the key's `region`, then `kms.defaults.aws.region` (`packages/hardhat-kms/src/internal/providers/aws/config.ts:98-107`). `awsClientSettings` reads the values when the adapter is built: the region of a key ARN read from a variable wins, and an empty variable leaves the setting to the SDK (`packages/hardhat-kms-aws/src/internal/client-settings.ts:11-14`, `client-settings.ts:26-36`). With no region set, the SDK takes `AWS_REGION`, then the profile's region.
- Settings to client: `packages/hardhat-kms-aws/src/internal/adapter.ts:175-184`. The client gets no `credentials`, so it uses its default provider (`@aws-sdk/client-kms` `dist-cjs/index.js:2175`), and the client config, `profile` included, is the provider's input (`@aws-sdk/core` `dist-cjs/submodules/httpAuthSchemes/index.js:292-305`).
- Idle close to `destroy()`: `adapter.ts:148-149`.
- The chain: `@aws-sdk/credential-provider-node` `dist-cjs/index.js:96-160`. Source 1 runs only without a profile: with the key's `profile` or `AWS_PROFILE` set it steps aside, and prints the "Multiple credential sources detected" warning once when environment keys are also set (`index.js:97-125`). The second provider of the chain reads SSO fields passed in code, which the plugin never passes, so it always steps aside (`index.js:126-134`). Then come the shared config files (`index.js:135-139`), `credential_process` (`index.js:140-144`), the web identity token file (`index.js:145-149`), and the remote provider (`index.js:150-153`): container credentials when either container variable is set, else IMDS unless `AWS_EC2_METADATA_DISABLED` is set to anything but `false` (`index.js:5-19`).
- A source that fails without marking its error as "try the next one" stops the chain (`index.js:78-93`).
- Each client keeps the credentials it found and looks them up again five minutes before they expire (`index.js:21-77`, `index.js:162`).

`kms history` builds a CloudTrail client, and an STS and a KMS client when it needs them, with the same `awsClientSettings` and user agent; only the KMS client gets the key's `endpoint` (`packages/hardhat-kms-aws/src/internal/history-api.ts:94-97`, `history-api.ts:119`, `history-api.ts:125-128`). The handler destroys them after the read (`hook-handlers/kms.ts:78-92`, `history-api.ts:133-138`).

### Google Cloud

```mermaid
flowchart TD
  subgraph build["Client: one per signer, built on its first call"]
    key["Google Cloud key config<br/>key version name or its parts"] --> identity["Signer identity<br/>key version name; no credential setting"]
    identity --> cached{"Signer cached for<br/>this identity?"}
    cached -->|no| handler["kms hook handler<br/>loads the adapter, @google-cloud/kms and google-gax"]
    handler --> adapter["createGcpKeyAdapter<br/>keeps a client factory, builds no client"]
    adapter --> kmsCall["A KMS call"]
    cached -->|yes| kmsCall
    kmsCall --> make["client ??= new KeyManagementServiceClient<br/>fallback: true, REST"]
    make --> init["client.initialize()<br/>google-gax builds a GoogleAuth"]
    init -->|fails| drop["Close and drop the client<br/>the next call builds a new one"]
    make -.->|idle close| close["client.close()"]
  end
  init --> envFile
  subgraph adc["Application Default Credentials: google-auth-library"]
    envFile{"GOOGLE_APPLICATION_CREDENTIALS set?"}
    envFile -->|yes| one["1. That JSON file<br/>unreadable: the run fails, no fallback"]
    envFile -->|no| wellKnown{"application_default_credentials.json<br/>in CLOUDSDK_CONFIG, else ~/.config/gcloud?"}
    wellKnown -->|yes| two["2. The gcloud ADC file"]
    wellKnown -->|no| gce{"On Google Cloud?"}
    gce -->|yes| three["3. The metadata server"]
    gce -->|no| none["gcp.connect.no-credentials"]
  end
```

Where each step is:

- Key config to signer identity: the identity holds the key version name and the key's common settings, and no setting that selects a credential (`packages/hardhat-kms/src/internal/signer/signer-identity.ts:53-56`). Every Google Cloud key of a run therefore uses the same ADC identity.
- Signer cache to handler: `packages/hardhat-kms-gcp/src/internal/hook-handlers/kms.ts:94-105` claims `gcp` keys and loads the SDK with the `google-gax` this package depends on (`hook-handlers/kms.ts:40-43`).
- The adapter keeps a factory and builds no client (`packages/hardhat-kms-gcp/src/internal/adapter.ts:403-413`). Each call builds the client if there is none, then awaits `initialize()` before it calls the SDK (`adapter.ts:313-316`, `adapter.ts:366-369`). The client runs over REST (`fallback: true`), so no gRPC channel keeps `hardhat run` alive (`adapter.ts:409-411`).
- The client gets no credential options, so `google-gax` builds a `GoogleAuth` from them (`google-gax` `build/src/fallback.js:141-153`).
- A failed `initialize()` closes and drops the client, so the next call looks the credentials up again instead of failing with a cached error (`adapter.ts:370-381`). The error is mapped to `gcp.connect.no-credentials` or `gcp.connect.credentials-file` (`adapter.ts:345-348`, `packages/hardhat-kms-gcp/src/internal/wire.ts:128-143`).
- Idle close to `client.close()`: `adapter.ts:256-258`.
- The ADC order: `google-auth-library` `build/src/auth/googleauth.js:245-286`. Source 1 is the file named by `GOOGLE_APPLICATION_CREDENTIALS`; a file that cannot be read throws, with no fallback (`googleauth.js:257-267`, `googleauth.js:315-330`). Source 2 is `application_default_credentials.json` in `CLOUDSDK_CONFIG`, else `%APPDATA%\gcloud` on Windows or `~/.config/gcloud` (`googleauth.js:269-279`, `googleauth.js:336-365`). Source 3 is the metadata server (`googleauth.js:281-284`). Then it throws (`googleauth.js:285`). `GOOGLE_CLOUD_QUOTA_PROJECT` sets the quota project of whichever source wins (`googleauth.js:287-290`).

`kms history` builds a new `GoogleAuth` with the Cloud Logging read scope for each read, so it finds the same ADC identity as the KMS client (`hook-handlers/kms.ts:52-58`, `hook-handlers/kms.ts:88-92`).

### Azure

```mermaid
flowchart TD
  subgraph build["Clients: one credential per runtime, Key Vault clients per signer"]
    first["First Azure key of the runtime"] --> load["kms hook handler: load once<br/>@azure/keyvault-keys, @azure/identity"]
    load --> chainBuilt["createAzureCredential(process.env)"]
    chainBuilt -->|"throws: tenant id, username and password"| reset["Error; the next Azure key tries again"]
    chainBuilt --> shared["SharedTokenCredential<br/>one token per scope and tenant"]
    shared --> keyClient["Per signer: KeyClient(vault URL, credential)<br/>then a CryptographyClient for the pinned version"]
    keyClient -.->|idle close| dropped["Clients dropped; the credential and its tokens stay"]
  end
  shared --> sp
  subgraph chain["Credential chain: first source that returns a token"]
    sp{"AZURE_TENANT_ID and AZURE_CLIENT_ID,<br/>with a secret or a certificate path?"}
    sp -->|yes| one["1. Service principal<br/>ClientSecretCredential, else ClientCertificateCredential<br/>any failure stops the chain"]
    sp -->|no| wi{"Tenant, client id and<br/>AZURE_FEDERATED_TOKEN_FILE set?"}
    wi -->|yes| two["2. WorkloadIdentityCredential"]
    wi -->|no| cli["3. AzureCliCredential, then<br/>AzureDeveloperCliCredential"]
    two -->|unavailable| cli
    cli -->|unavailable| mi{"Managed identity allowed here?<br/>not Cloud Shell or Service Fabric<br/>with AZURE_CLIENT_ID set"}
    mi -->|yes| four["4. ManagedIdentityCredential<br/>user-assigned with AZURE_CLIENT_ID<br/>10 s per token, 3 s per request"]
    mi -->|no| none["azure.credential.none"]
    four -->|unavailable| none
  end
```

Where each step is:

- The handler builds the adapter factory, and with it the credential, on the first Azure key, and keeps it for the runtime; a failed load is dropped so that the next key tries again (`packages/hardhat-kms-azure/src/internal/hook-handlers/kms.ts:57-67`, `hook-handlers/kms.ts:123-141`). The handler passes `process.env` (`hook-handlers/kms.ts:51-54`).
- `createAzureCredential` puts each source in the chain only when it applies, then wraps the chain in `SharedTokenCredential`, so all keys share one token per scope and tenant, and `az login` users see one `az` process per run (`packages/hardhat-kms-azure/src/internal/credential.ts:443-484`, `credential.ts:288-336`).
- Building the chain throws `azure.credential.tenant-id` for a tenant id with a character a tenant id cannot have, and `azure.credential.username-password` when the environment would sign a user in with a password (`credential.ts:218-224`, `credential.ts:277-280`).
- Signer identity: like Google Cloud, it holds the key URL and no credential setting (`packages/hardhat-kms/src/internal/signer/signer-identity.ts:57-60`).
- Per signer, the adapter builds a `KeyClient` for the key's vault with the shared credential, then a `CryptographyClient` for the version it pins (`packages/hardhat-kms-azure/src/internal/adapter.ts:175`, `adapter.ts:212-217`, `adapter.ts:389-392`). The adapter has no `close`; the idle close drops the clients, and the credential and its tokens stay with the handler.
- Source 1: the plugin picks the service principal itself. A secret wins over a certificate path, `AZURE_ADDITIONALLY_ALLOWED_TENANTS` and `AZURE_CLIENT_SEND_CERTIFICATE_CHAIN` become options, and an empty variable counts as unset (`credential.ts:185-188`, `credential.ts:248-282`). `FailureStopsChain` turns any failure of it into an `AuthenticationError`, which stops the chain, so a service principal that is refused never falls through to `az login` (`credential.ts:158-178`, `credential.ts:238`).
- Source 2: `WorkloadIdentityCredential` joins the chain only when its constructor finds its three variables (`credential.ts:454-458`; `@azure/identity` `dist/commonjs/credentials/workloadIdentityCredential.js:50-70`).
- Source 3: `AzureCliCredential`, then `AzureDeveloperCliCredential`, always in the chain (`credential.ts:459`).
- Source 4: `ManagedIdentityCredential`, with `AZURE_CLIENT_ID` as its client id when set (`credential.ts:460-472`). Its constructor refuses a client id in Cloud Shell and Service Fabric, and the plugin then leaves it out (`credential.ts:386-398`; `@azure/identity` `dist/commonjs/credentials/managedIdentityCredential/index.js:106-137`). `TimeoutCredential` gives it 10 s for a token and its HTTP client 3 s per request (`credential.ts:16`, `credential.ts:23`, `credential.ts:371-379`, `credential.ts:461-464`, `credential.ts:473-481`).
- The chain goes to the next source only on `CredentialUnavailableError` or `AuthenticationRequiredError`; any other error stops it (`@azure/identity` `dist/commonjs/credentials/chainedTokenCredential.js:79-98`). With no token at all, the adapter reports `azure.credential.none`, and for a source that was refused `azure.credential.failed` (`adapter.ts:89-92`, `adapter.ts:318-322`).

`kms history` builds a new chain with the same function for each read, and sends its Log Analytics query to `api.loganalytics.azure.com` with a token for the `api.loganalytics.io` scope (`hook-handlers/kms.ts:77-85`, `packages/hardhat-kms-azure/src/internal/log-analytics.ts:20-26`, `log-analytics.ts:56-60`).

## Errors

Every error that first-party code builds has an entry in its package's error catalogue, `src/internal/error-catalog.ts`: a stable id (`<package>.<area>.<name>`), a kind, a group, a message template with `{name}` placeholders, a cause and a fix. The catalogue is an `as const` object, so each template keeps its literal type, and `TemplateParams<Template>` in `packages/hardhat-kms/src/internal/errors.ts` turns its placeholders into required parameters: a missing or misspelt value does not compile. A `{` that does not start a `{name}` placeholder, as in `{name, type}`, is literal text, for the type and for `fillTemplate` alike.

Code builds errors with three helpers from `errors.ts`, which `hardhat-kms/provider-utils` also exports:

- `catalogError(entry, params, details)` for an `error` entry: a `HardhatPluginError` with `kmsError`'s prefix (provider, operation, key).
- `catalogMessage(entry, params)` for text: a `reason` that another error includes (the messages of `InvalidSignatureError`, `InvalidPublicKeyError`, `InvalidAddressError` and `InvalidTypedDataError`, and the problems an identifier check returns), a `validation` message for the zod schemas, or an `error` entry that has a class of its own (`SendOutcomeUnknownError`).
- `internalError(entry, params)` for an `internal` entry: a plain `Error` for a state that only a bug or a broken install reaches, such as a config resolved without validation or a `package.json` without a version. These throws keep the `Error` class they always had, and each has its own entry, whose fix is to report it.

A placeholder holds a value: a name, a number, an address or a list. Where the wording around a value changes, the catalogue has one entry per wording, such as `core.task.unknown-key` and `core.task.unknown-key-suggested`. Messages do not print the id yet; the ids appear in the catalogue and in the [errors reference](../user/reference/errors.md).

`kmsError(message, details)` stays for third-party providers. To add an error, add its entry, build it with one of the helpers and run `pnpm run docs:errors`, which writes the reference. `pnpm run docs:check` fails when the reference is out of date, and when first-party source builds an error outside the helpers (see [Documentation](documentation.md#checks)).

## Timeouts and retries

One AbortSignal timeout covers each whole KMS call, including the SDK's own retries. The default is 30 s (`kms.defaults.timeoutMs`, overridable per key). For GCP the adapter passes the key's timeout as gax's `timeout` call option, the deadline of each request, with `retry: null`, which turns the SDK's retries off. google-gax enforces that deadline over REST only from 6.5.0, and `@google-cloud/kms` 6.2.1 accepts any 6.x, so `@hardhat-kms/gcp` depends on `google-gax` `^6.5.0` itself and passes it to the client's constructor; the client then runs on that copy even if `@google-cloud/kms` resolves an older one. The client's methods return plain promises, so a request already sent cannot be cancelled: after the AbortSignal fires, the request in flight ends at its deadline, and the adapter starts no other.

Signing has no side effects, so calls can be repeated. The AWS SDK retries transient errors itself within that timeout. The GCP adapter has its own loop instead: it repeats a call whose CRC32C check fails, whose digest Cloud KMS refuses for its checksum, or that fails with UNAVAILABLE (after 100, 200 and 400 ms), at most three times (`MAX_RETRIES` in `packages/hardhat-kms-gcp/src/internal/adapter.ts`), and stops once the AbortSignal fires. Its pauses use timers that are not `unref`'d: a signature in progress waits on them, so an `unref`'d pause would let Node exit in the middle of `hardhat run`. Only idle and cleanup timers, such as the signer cache's idle close and the retry entries' expiry, and the core's per-call deadline, which races a request that holds its own socket, are `unref`'d.

## SDK loading

Each provider package lists its cloud SDK in `dependencies`: `@hardhat-kms/aws` depends on `@aws-sdk/client-kms` `^3.1143.0` and, for `kms history`, `@aws-sdk/client-cloudtrail` and `@aws-sdk/client-sts` at the same range, `@hardhat-kms/gcp` on `@google-cloud/kms` `^6.2.1`, `google-gax` `^6.5.0` and, for the Cloud Logging reads of `kms history`, `google-auth-library` `^11.0.0` (the range google-gax 6.5.0 asks for, so it adds no second copy), and `@hardhat-kms/azure` on `@azure/keyvault-keys` `^4.10.2`, `@azure/identity` `^4.13.3` and, for the credential chain's HTTP client and the Log Analytics query, `@azure/core-rest-pipeline` `^1.25.0`. Installing the package installs the SDK. The core depends on no cloud SDK, and `packages/hardhat-kms/test/unit/plugin.test.ts` fails if its `package.json` lists one.

A provider package imports its SDK only when it creates an adapter: its plugin definition registers the `kms` hook handler as a lazy import, and the handler loads the SDK on first use. The handler, `packages/hardhat-kms-aws/src/internal/hook-handlers/kms.ts`, passes keys of other providers to `next`. For an `aws` key it imports `adapter.ts` and `@aws-sdk/client-kms` with dynamic `import()`, then calls `createAwsKeyAdapter(key, sdk)`. The adapter receives the SDK as an argument typed `AwsKmsSdk`, so unit tests pass a fake.

The core has two peer dependencies: `hardhat`, and `viem`, which is optional and loaded only by `connection.kms.getAccount` ([Library accounts](#library-accounts)). A provider package has two: `hardhat` and `hardhat-kms`, so a project has a single copy of the core. The core and the provider packages are released together at the same version, as a changesets `fixed` group, and a provider package's `hardhat-kms` peer is that exact version. Hardhat's peer-dependency checker ignores `peerDependenciesMeta`, so a provider package cannot be an optional peer of the core. Users install the provider packages they need, as the [configuration reference](../user/reference/configuration.md#provider-packages) documents.

The SDK range is a caret range that starts at a version the tests run. CI tests the version in `pnpm-lock.yaml`, and the SDK floors workflow tests the lowest version the range allows (see [Testing](testing.md)).

`packages/hardhat-kms-aws/test/integration/sdk-loading.test.ts` runs `packages/hardhat-kms-aws/test/fixtures/load-config.ts` in a child process. The fixture loads `@hardhat-kms/aws` and resolves a config with a key for every built-in provider. `packages/hardhat-kms-aws/test/helpers/import-recorder.mjs` records the file URL of every module the process loads: through `module.registerHooks` where Node has it, which also sees `require`, and otherwise through asynchronous hooks plus the CommonJS module cache at exit. The test fails if any file under `@aws-sdk/`, `@smithy/` or `@aws-crypto/` is among them. A positive control also creates the AWS key's adapter, with both hook kinds, and must record `@aws-sdk/client-kms`. `packages/hardhat-kms-gcp/test/integration/sdk-loading.test.ts` does the same for `@google-cloud/`, `google-gax`, `google-auth-library`, `gaxios`, `@grpc/` and `protobufjs`, and for the history reader's own modules, also when `kms history` runs on another provider's key.
