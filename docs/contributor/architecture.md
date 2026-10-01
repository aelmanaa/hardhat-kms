# Architecture

Audience: Contributors and reviewers who want to understand how the code fits together.

Status: M1 implements the signing core (`crypto/`, `signer/`, the vendored EIP-712 encoder). M2 adds `config/`, the built-in providers' descriptors and key formats, the registry and the `kms` hook (`providers/`). M3 adds the AWS adapter, which lives in its own package, `packages/hardhat-kms-aws` ([#91](https://github.com/aelmanaa/hardhat-kms/issues/91)). M4 adds the network hook, the RPC dispatcher for accounts, messages and typed data, and the per-runtime signer cache ([#19](https://github.com/aelmanaa/hardhat-kms/issues/19)). M5 adds the transaction filler ([#23](https://github.com/aelmanaa/hardhat-kms/issues/23)), which nothing calls until sending lands ([#24](https://github.com/aelmanaa/hardhat-kms/issues/24)). The other modules are planned; the code map gives each one's milestone.

## Module map

Each arrow points from a module to a module it may import. Blue modules are implemented. All modules are in `packages/hardhat-kms/src/` except the provider packages, which reach the core only through `hardhat-kms/types` and `hardhat-kms/provider-utils`.

```mermaid
flowchart TD
  index["index.ts<br/>plugin definition"] --> hooks["hook-handlers/<br/>config, hre, network"]
  index --> tasks["tasks/"]
  hooks --> config["config/<br/>schema and resolution"]
  hooks --> registry["providers/registry.ts<br/>providers/create-adapter.ts"]
  hooks --> rpc["rpc/<br/>dispatcher: accounts, messages<br/>(transactions in M5)"]
  hooks --> signer
  rpc --> signer["signer/<br/>KmsSigner, signer cache, timeouts"]
  signer --> registry
  tasks --> signer
  registry --> descriptors["providers/aws, gcp, azure<br/>descriptor, key format"]
  signer --> crypto["crypto/<br/>keys, signatures, digests"]
  packages["provider packages<br/>hardhat-kms-aws: kms handler, adapter"] --> utils["provider-utils.ts<br/>helpers for provider plugins"]
  utils --> crypto
  utils --> descriptors
  crypto --> vendor["vendor/micro-eth-signer<br/>EIP-712 encoder"]
  classDef done fill:#0847F7,color:#fff,stroke:#0847F7
  class index,hooks,rpc,crypto,signer,vendor,config,registry,descriptors,packages,utils done
```

The rules behind the arrows:

- `crypto/` is pure: no cloud SDK, no Hardhat runtime, no I/O. Everything in it is testable with vectors and property tests.
- `signer/` owns every check on the signature itself: parsing, low-S, parity recovery and verification. `KmsSigner` receives an adapter and never looks one up; the signer cache (`signer/key-cache.ts`) creates adapters through `providers/create-adapter.ts`.
- Adapters translate between the provider's wire format and `SignatureOutput`, and run the provider-specific identity checks listed in [Key identity and pinning](signing-pipeline.md#key-identity-and-pinning). They never decide whether a signature belongs to the key.
- The core depends on no cloud SDK. Each provider package depends on its own SDK and imports it only when it creates an adapter (see [SDK loading](#sdk-loading)), so loading a config never loads a cloud SDK.

## Packages

The repository is a pnpm workspace ([decision 0010](decisions/0010-pnpm-workspaces.md)). Following [decision 0009](decisions/0009-one-package-per-provider.md), each cloud provider has its own package around an SDK-free core:

| Package                                                  | Holds                                                                                                   | Status                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/hardhat-kms`                                   | The core: config and key formats, signing checks, the `kms` hook, `--kms`, `hardhat-kms/provider-utils` | Implemented                                                            |
| `packages/hardhat-kms-aws`                               | The AWS plugin and adapter, depending on `@aws-sdk/client-kms`                                          | Implemented ([#91](https://github.com/aelmanaa/hardhat-kms/issues/91)) |
| `packages/hardhat-kms-gcp`, `packages/hardhat-kms-azure` | The Google Cloud and Azure adapters                                                                     | Planned (M6)                                                           |

## Code map

| Concept                                     | Where                                                                                                                                                     | Milestone |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Plugin definition                           | `packages/hardhat-kms/src/index.ts`                                                                                                                       | M0        |
| Public keys, signatures, digests            | `packages/hardhat-kms/src/internal/crypto/`                                                                                                               | M1        |
| Signer and adapter interface                | `packages/hardhat-kms/src/internal/signer/kms-signer.ts`, `packages/hardhat-kms/src/internal/signer/types.ts`                                             | M1        |
| Per-call timeout                            | `packages/hardhat-kms/src/internal/signer/timeout.ts`                                                                                                     | M1        |
| Error builder                               | `packages/hardhat-kms/src/internal/errors.ts`                                                                                                             | M1        |
| Vendored EIP-712 encoder                    | `packages/hardhat-kms/src/internal/vendor/micro-eth-signer/`                                                                                              | M1        |
| Config schema and resolution                | `packages/hardhat-kms/src/internal/config/`                                                                                                               | M2        |
| Provider descriptors and registry           | `packages/hardhat-kms/src/internal/providers/{registry,types}.ts`, `packages/hardhat-kms/src/internal/providers/*/descriptor.ts`                          | M2        |
| `kms` hook for provider plugins             | `packages/hardhat-kms/src/internal/providers/create-adapter.ts`, `KmsHooks` in `packages/hardhat-kms/src/types.ts`                                        | M2        |
| Helpers for provider plugins                | `packages/hardhat-kms/src/provider-utils.ts` (`hardhat-kms/provider-utils`)                                                                               | M3        |
| `--kms` option (Foundry's variables)        | `packages/hardhat-kms/src/internal/config/env-keys.ts`, `packages/hardhat-kms/src/internal/hook-handlers/hre.ts`                                          | M2, M4    |
| AWS plugin, `kms` hook handler and adapter  | `packages/hardhat-kms-aws/src/index.ts`, `packages/hardhat-kms-aws/src/internal/hook-handlers/kms.ts`, `packages/hardhat-kms-aws/src/internal/adapter.ts` | M3        |
| GCP and Azure adapters                      | `packages/hardhat-kms-gcp/`, `packages/hardhat-kms-azure/` (planned)                                                                                      | M6        |
| Network hook                                | `packages/hardhat-kms/src/internal/hook-handlers/network.ts`                                                                                              | M4        |
| Signer cache                                | `packages/hardhat-kms/src/internal/signer/key-cache.ts`                                                                                                   | M4        |
| RPC dispatcher and methods                  | `packages/hardhat-kms/src/internal/rpc/dispatcher.ts` (accounts, messages, typed data); transactions planned                                              | M4, M5    |
| Transaction filler (port of Hardhat 3.18.0) | `packages/hardhat-kms/src/internal/rpc/transaction-filler.ts`                                                                                             | M5        |
| Tasks                                       | `packages/hardhat-kms/src/internal/tasks/`                                                                                                                | M7        |

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

An `eth_sendTransaction` from a KMS account is filled, signed and broadcast by the hook while it holds a per-sender lock. This flow is planned for M5.

```mermaid
sequenceDiagram
  participant C as Client
  participant H as Network hook
  participant F as Transaction filler
  participant S as KmsSigner
  participant N as Hardhat handlers and node
  C->>H: eth_sendTransaction(tx)
  H->>H: take lock chainId:from
  H->>F: fill nonce, gas, fees, chainId
  F->>N: reads through connection.provider (pass through the hook)
  H->>S: sign the unsigned transaction's digest
  S-->>H: verified signature
  H->>H: rebuild signed tx, check sender == from
  H->>N: next(eth_sendRawTransaction), exactly once
  N-->>H: hash
  H->>H: release lock
  H-->>C: hash
```

The rules that keep this safe are in [Request flow and re-entrancy rules](#request-flow-and-re-entrancy-rules) and in [Transactions](transactions.md).

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
                            (path ["networks", n, "kmsAccounts", i]); pure resolve
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
      key-cache.ts          SignerCache: per-runtime signers by resolved key config; idle close after the last connection
      kms-signer.ts         signDigest -> {r, s, yParity}: parse -> range -> low-S -> trial recovery -> verify
    rpc/
      dispatcher.ts         request flow (see "Request flow and re-entrancy rules"); ConnectionAccounts;
                            accounts, eth_sign, personal_sign, eth_signTypedData_v4
      transactions.ts       (M5)
      transaction-filler.ts port of Hardhat 3.18.0's fill logic; builds the unsigned transaction and its signing hash
      send-guard.ts         process-global lock + nonce high-water + idempotency cache
    tasks/                  accounts, address, public-key, sign, sign-auth, sign-tx, verify
    vendor/micro-eth-signer/  vendored EIP-712 hashing (MIT, see "Vendored EIP-712")
    errors.ts               allow-listed error builder
    debug.ts                kmsDebug: hardhat:kms:config, providers, signer, rpc; plain values only
```

The plugin object sets `npmPackage: "hardhat-kms"`. The config hook handler imports provider descriptors only, and no descriptor imports an SDK.

Each provider package has the same small layout. For AWS:

```
packages/hardhat-kms-aws/src/
  index.ts                  definePlugin: id and npmPackage "hardhat-kms-aws", depends on hardhat-kms,
                            lazy `kms` hook handler import; references "hardhat-kms/types" for the config types
  internal/
    hook-handlers/kms.ts    claims `aws` keys, passes other keys to next; imports the adapter and the SDK on first use
    adapter.ts              createAwsKeyAdapter(key, sdk): GetPublicKey, Sign, key spec checks, ARN pinning
```

The Google Cloud and Azure packages (M6) will follow it, with a pure `wire.ts` for their formats (PEM, JWK, compact signatures, CRC32C).

## Request flow and re-entrancy rules

The dispatcher follows these rules. They keep the hook from deadlocking on its own internal calls and make each request's side effects easy to reason about.

1. Pass-through is the default. Only `eth_accounts`, `eth_requestAccounts` and the five signing methods are inspected. Everything else goes straight to `next`, so no allow-list of other methods is needed.
2. `next` is called at most once per request. Every internal RPC call (for example the reads during fill) goes through `connection.provider.request`, which re-enters the hook chain and is passed through by rule 1.
3. Per-runtime and per-connection state (`SignerCache`, `ConnectionAccounts`) is memoised as promises, with no lock. A failed promise is dropped, so the next request retries.
4. `eth_sendTransaction` for KMS address `a` on chain `c` takes the process-global lock `c:a`. Inside the lock the code may issue read calls (fill), make any number of KMS signature attempts (retries), and make exactly one `next(eth_sendRawTransaction)`.
5. `eth_signTransaction` takes no lock and never touches the nonce high-water mark, because it never broadcasts.

## Other signing plugins

Hardhat runs dynamically registered handlers first, then plugins in reverse order of the `plugins` array, and its built-in handlers last. Another plugin that intercepts `eth_accounts` or `eth_sendTransaction`, such as `@nomicfoundation/hardhat-ledger`, therefore runs before or after hardhat-kms depending on where each appears in `plugins`. hardhat-kms only acts on addresses it owns and passes everything else on, so both plugins can coexist. No test loads hardhat-kms together with hardhat-ledger yet.

## Lifetimes and caching

The network hook's factory runs once per runtime. Its closure holds a `SignerCache` (`packages/hardhat-kms/src/internal/signer/key-cache.ts`), so every connection of the runtime shares the same signers, and an address is looked up once. The cache is keyed by the resolved key config object, by identity. It does not deduplicate by provider and canonical key id: two key entries that name the same KMS key, such as a named key and an inline key, get two signers. On one network, the dispatcher then refuses them as the same account. A connection created with an `override` resolves the config again, so it gets new key objects and new signers ([#105](https://github.com/aelmanaa/hardhat-kms/issues/105)). A signer that fails to open is not cached.

Each connection with KMS keys gets a `ConnectionAccounts` (`packages/hardhat-kms/src/internal/rpc/dispatcher.ts`), which maps its addresses to keys. Its lookups run in parallel on first use, and a failed lookup is not cached.

The cache counts connections that have KMS keys. Five seconds after the last of them closes, an `unref`'d idle timer closes the signers, and with them the adapters and SDK clients; the next use creates them again. A connection that opens before the timer fires cancels it, and a connection closed twice is counted once. While a request is still signing, the idle close waits and tries again, so the request keeps its SDK client. Because the timer is `unref`'d and nothing else holds the event loop, a script that signs and never closes its connection still exits. `packages/hardhat-kms-aws/test/integration/network.test.ts` checks this with `packages/hardhat-kms-aws/test/fixtures/sign-and-exit.ts`. GCP will use `{ fallback: true }` (REST) by default, so no gRPC channel keeps `hardhat run` alive.

Status messages from adapters go to Hardhat's `interruptions.displayMessage` with the title `hardhat-kms`.

## Timeouts and retries

One AbortSignal timeout covers each whole KMS call, including the SDK's own retries. The default is 30 s (`kms.defaults.timeoutMs`, overridable per key). For GCP the plugin passes gax `timeout` and `retry` call options, which override the SDK's 600 s default.

Signing has no side effects, so the plugin retries throttling errors and GCP CRC mismatches, at most three times and honouring `Retry-After`.

## SDK loading

Each provider package lists its cloud SDK in `dependencies`: `hardhat-kms-aws` depends on `@aws-sdk/client-kms` `^3.1143.0`. Installing the package installs the SDK. The core depends on no cloud SDK, and `packages/hardhat-kms/test/unit/plugin.test.ts` fails if its `package.json` lists one.

A provider package imports its SDK only when it creates an adapter: its plugin definition registers the `kms` hook handler as a lazy import, and the handler loads the SDK on first use. The handler, `packages/hardhat-kms-aws/src/internal/hook-handlers/kms.ts`, passes keys of other providers to `next`. For an `aws` key it imports `adapter.ts` and `@aws-sdk/client-kms` with dynamic `import()`, then calls `createAwsKeyAdapter(key, sdk)`. The adapter receives the SDK as an argument typed `AwsKmsSdk`, so unit tests pass a fake.

The core's only peer dependency is `hardhat`. A provider package has two: `hardhat` and `hardhat-kms`, so a project has a single copy of the core. The core and the provider packages are released together at the same version, as a changesets `fixed` group, and a provider package's `hardhat-kms` peer is that exact version. Hardhat's peer-dependency checker ignores `peerDependenciesMeta`, so a provider package cannot be an optional peer of the core. Users install the provider packages they need, as the [configuration reference](../user/reference/configuration.md#provider-packages) documents.

The SDK range is a caret range that starts at a version the tests run. CI tests the version in `pnpm-lock.yaml`, and the SDK floors workflow tests the lowest version the range allows (see [Testing](testing.md)).

`packages/hardhat-kms-aws/test/integration/sdk-loading.test.ts` runs `packages/hardhat-kms-aws/test/fixtures/load-config.ts` in a child process. The fixture loads `hardhat-kms-aws` and resolves a config with a key for every built-in provider. `packages/hardhat-kms-aws/test/helpers/import-recorder.mjs` records the file URL of every module the process loads: through `module.registerHooks` where Node has it, which also sees `require`, and otherwise through asynchronous hooks plus the CommonJS module cache at exit. The test fails if any file under `@aws-sdk/`, `@smithy/` or `@aws-crypto/` is among them. A positive control also creates the AWS key's adapter, with both hook kinds, and must record `@aws-sdk/client-kms`.
