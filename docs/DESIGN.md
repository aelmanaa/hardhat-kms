# hardhat-kms design

Audience: contributors and reviewers of hardhat-kms who know TypeScript and Hardhat 3 plugins and want to understand how the plugin works and why. Assumes basic familiarity with EVM transactions and cloud KMS.

Applies to hardhat-kms 1.x on Hardhat 3 (peer dependency `hardhat` `^3.18.0`).

## Goals

hardhat-kms is an MIT-licensed Hardhat 3 plugin that signs transactions and messages with secp256k1 keys held in cloud KMS and HSM services. Version 1 supports three providers:

- AWS KMS
- GCP Cloud KMS
- Azure Key Vault and Azure Managed HSM

The design has three goals:

1. Existing tooling works unchanged. viem, ethers, Ignition and plain scripts see KMS keys as ordinary accounts, because the plugin works at the JSON-RPC layer through a network hook.
2. Parity with Foundry's KMS support, or better. Every Foundry key form and command has an equivalent, and the plugin adds checks Foundry does not have.
3. A new KMS or HSM is one adapter folder plus one line in a registry.

Private key material never leaves the KMS. The plugin sends a 32-byte digest (or, for policy-aware providers, the structured request) and gets a signature back. Every signature is then verified locally before anything uses it.

## User-facing behaviour

### Configuration

Keys are declared once under `kms.keys` and referenced by name from any network:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKms from "hardhat-kms";

export default defineConfig({
  plugins: [hardhatKms],
  kms: {
    defaults: { aws: { region: "eu-west-1" }, timeoutMs: 30_000 },
    keys: {
      deployer: { provider: "aws", keyId: "alias/deployer", address: "0x1234…" }, // address pin: optional, recommended
      ops: { provider: "azure", keyId: "https://ops.vault.azure.net/keys/ops/0123abcd" },
      treasury: {
        provider: "gcp",
        keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/3",
      },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["deployer", "ops"],
    },
    arbitrum: {
      type: "http",
      url: configVariable("ARB_RPC_URL"),
      chainId: 42161,
      kmsAccounts: ["deployer"],
    },
    fork: {
      type: "edr-simulated",
      forking: { url: configVariable("SEPOLIA_RPC_URL") },
      kmsAccounts: ["deployer"],
    },
  },
});
```

A network's `kmsAccounts` lists key names or inline key objects. The full set of plugin config fields:

| Field                          | Meaning                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `kms.keys`                     | Named keys, reused across networks.                                                                                               |
| `kms.defaults.aws.region`      | Default AWS region (see the region precedence below).                                                                             |
| `kms.defaults.timeoutMs`       | Default per-call timeout. Default 30 s.                                                                                           |
| `kms.allowCrossChainTypedData` | Allow typed data whose `domain.chainId` differs from the connection's chain. Default `false`.                                     |
| `kms.simulatedBalance`         | A bigint in wei. On `edr-simulated` networks only, the plugin calls `hardhat_setBalance` for each KMS address on `newConnection`. |
| `networks.<name>.kmsAccounts`  | Key names or inline key objects for that network, on http and `edr-simulated` networks.                                           |
| `address` (per key)            | Optional address pin. Recommended: it avoids a KMS call to learn the address and guards against key substitution.                 |
| `timeoutMs` (per key)          | Overrides the default timeout for that key.                                                                                       |
| `approvalTimeoutMs`            | Timeout for providers with asynchronous approval flows, set alongside `timeoutMs`.                                                |

The plugin warns when `kmsAccounts` is set on the `default` network.

### Key forms per provider

The accepted key forms are a superset of Foundry's.

| Provider | Key forms                                                                                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws`    | `keyId` as a key id, key ARN, alias name or alias ARN. Optional `region`, `profile`, `endpoint`.                                                                                                                 |
| `gcp`    | Either `keyVersionName`, or the components `projectId`, `location`, `keyRing`, `keyName`, `keyVersion`. The version is always required and never auto-selected.                                                  |
| `azure`  | Either `keyId` (the full URL, versioned or not, including `*.managedhsm.azure.net`), or `vaultUrl` + `keyName` + optional `keyVersion`. An unversioned key is resolved once and the resulting version is pinned. |

AWS resolves the region in this order: the region inside an ARN, then `key.region`, then `defaults.aws.region`, then the SDK's own chain. A configured region that conflicts with the ARN's region is an error. `AWS_ENDPOINT_URL_KMS` (useful for LocalStack) is left to the AWS SDK, which honours it.

Identifiers are not secrets. Every identifier field still accepts `string | ConfigurationVariable`. A value that came from a variable is displayed as `<VAR_NAME>` unless the user passes `--show-ids`.

Third-party providers extend the config types through the declaration-merged `KmsProviderUserConfigs` interface (see [Provider contract](#provider-contract)).

### Credentials

No secrets live in the Hardhat config. Each provider takes credentials from its SDK's default chain:

- AWS uses the SDK default chain: environment, then SSO/ini/profile, then process, then web identity, then IMDS/ECS.
- GCP uses Application Default Credentials.
- Azure builds the chain below, which follows the order used by Foundry's Azure Key Vault signer (service principal, workload identity, `az`/`azd`, managed identity).

```ts
new ChainedTokenCredential(
  EnvironmentCredential,
  WorkloadIdentityCredential,
  AzureCliCredential,
  AzureDeveloperCliCredential,
  ManagedIdentityCredential({ clientId: AZURE_CLIENT_ID }),
);
```

`AZURE_CLIENT_ID` selects a user-assigned managed identity. The managed identity `getToken` call has a 10 s timeout.

### Foundry migration helper

Users coming from Foundry can keep their environment variables. The helper expands them into `kms.keys` entries:

```ts
import { kmsKeysFromFoundryEnv } from "hardhat-kms/foundry";
```

It reads these variables:

- `AWS_KMS_KEY_ID(S)`
- `GCP_PROJECT_ID`, `GCP_LOCATION`, `GCP_KEY_RING`, `GCP_KEY_NAME`, `GCP_KEY_VERSION`
- `AZURE_KEY_VAULT_KEY_ID(S)`

Lists are comma-split and trimmed, and blank entries are dropped. For single-value variables the helper emits `configVariable()`, so masking and lazy resolution work as they do for hand-written config. Only the comma-list expansion reads `process.env` directly; it is the one exception to the `node/no-process-env` lint rule. The README has the full mapping table.

### RPC behaviour

The plugin installs a network hook. It behaves as follows:

- `eth_accounts` and `eth_requestAccounts` return the network's own accounts followed by the KMS addresses. If the downstream call fails, only the KMS addresses are returned.
- A KMS address comes from the `address` pin when one is set, with no KMS call. Otherwise it comes from a public-key lookup, run in parallel across keys and cached per HRE.
- Five signing methods are intercepted, but only when the address is a KMS account: `eth_sendTransaction`, `eth_signTransaction`, `eth_sign`, `personal_sign` and `eth_signTypedData_v4`.
- `eth_sign` and `personal_sign` use EIP-191 with the message prefix, the same semantics as Hardhat core. Their data must be strict hex.
- `eth_signTransaction` fills and signs without broadcasting, like `cast mktx` and viem's json-rpc `signTransaction`. It is on by default.
- No RPC method signs a bare digest.
- Every other method passes through untouched.

When `from` is not a KMS address, the request passes through. If the sender turns out not to be a local account either, the resulting error lists the loaded KMS addresses.

### Supported transaction types

| Type            | Status                                                  |
| --------------- | ------------------------------------------------------- |
| Legacy          | Supported, EIP-155 only.                                |
| EIP-2930        | Supported.                                              |
| EIP-1559        | Supported.                                              |
| EIP-7702        | Supported with a pre-signed `authorizationList`.        |
| EIP-4844 (blob) | Not supported. Hardhat core does not support it either. |

For EIP-7702 the RPC path does not sign unsigned authorization entries. No client emits that format, and Hardhat's schema requires signed tuples. A user who wants the KMS key to sign an authorization runs `kms sign-auth` (with `--self-broadcast` when the same key also sends the transaction) and puts the resulting signed tuple in a normal `authorizationList`. The planned `getAccount().signAuthorization` covers the library case.

When a KMS sender's transaction carries pre-signed tuples, the plugin lints them: each signature must be low-S and its authority must recover. A tuple that fails either check produces a warning, not an error.

### Tasks

All tasks live in the `kms` namespace, which is an `emptyTask` in the same style as the keystore plugin.

| Task                                                                                   | Purpose                                                                                                            | Foundry equivalent                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `kms accounts [--network n] [--json] [--show-ids]`                                     | Every configured key with provider, pinned id and address. Checks access and prints ready-to-paste `address` pins. | `cast wallet list/address` (no access check)            |
| `kms address <key>` / `kms public-key <key>`                                           | The address, or the uncompressed public key.                                                                       | `cast wallet address`; no equivalent for the public key |
| `kms sign <key> <message> [--typed-data file] [--no-hash]`                             | EIP-191, EIP-712, or a raw 32-byte digest. `--no-hash` exists only here, as an explicit human action.              | `cast wallet sign [--data] [--no-hash]`                 |
| `kms sign-auth <key> <delegate> --chain <id> [--nonce n] [--self-broadcast] [--force]` | EIP-7702 authorization. Chain 0 requires `--force`; `--self-broadcast` uses nonce+1.                               | `cast wallet sign-auth`                                 |
| `kms sign-tx <key> --network n <tx.json>`                                              | Filled and signed, not broadcast.                                                                                  | `cast mktx`                                             |
| `kms verify <address> <message> <signature>`                                           | Local signature verification.                                                                                      | `cast wallet verify`                                    |

Some task details matter for review:

- `kms accounts` without `--network` lists every network, deduplicated by key. It never silently skips a provider: a failure is shown next to the key it affects.
- `kms sign --typed-data` without `--network` has no connection to compare chain ids against, so it requires `--chain` or `--allow-cross-chain`.
- An address-pin mismatch prints both addresses and a hint about key rotation or a repointed alias.
- `displayMessage` output appears only on the first resolution of a key or for KMS calls that take longer than 2 s.

`kms accounts --balances` and `--check-sign` are planned for v1.1.

### Differences from Foundry

The README lists these so users can compare:

- GCP CRC32C integrity checks. Foundry has none.
- Post-sign verification of every signature. Foundry's Turnkey signer has none.
- Per-call timeouts on every provider.
- Multiple keys for every provider. Foundry allows one GCP key and one Turnkey key.
- An account listing that checks access.
- A `public-key` command.
- A chain-id guard on typed data.
- Protection against double broadcast when a client retries a send.

## Architecture

### Module layout

```
src/
  index.ts                  definePlugin: types, constants, lazy hook/task imports only (Hardhat plugin guideline)
  type-extensions.ts        augments HardhatUserConfig/HardhatConfig (kms) + Http/Edr Network(User)Config (kmsAccounts); no named exports
  types.ts                  public provider-author types (exported via the "hardhat-kms/types" subpath)
  foundry.ts                kmsKeysFromFoundryEnv() (exported via the "hardhat-kms/foundry" subpath)
  internal/
    config/                 zod v3 schema rooted at HardhatUserConfig; conditionalUnionType on `provider`; superRefine for named-key refs
                            (path ["networks", n, "kmsAccounts", i]); pure resolve
    hook-handlers/
      config.ts             validate/resolve (imports provider *descriptors* only)
      network.ts            onRequest / closeConnection
      kms.ts                default handler of the plugin-owned `kms` hook category
    providers/
      registry.ts           provider id -> descriptor; adding a provider = one folder + one line here
      aws/ gcp/ azure/      descriptor.ts (zod schema, resolve, sdk {packageName, range}, display id)
                            adapter.ts (lazy: SDK client, credentials, version pinning)
                            wire.ts (pure decoding: SPKI/PEM/JWK, DER/compact, CRC32C)
    crypto/                 pure, no SDKs: public-key.ts, signature.ts, address.ts, crc32c.ts
    signer/
      key-cache.ts          per-HRE cache: (provider, canonical configured id) -> adapter + public key promise
      kms-signer.ts         signDigest -> {r, s, yParity}: parse -> range -> low-S -> trial recovery -> verify
    rpc/
      dispatcher.ts         request flow (see "Request flow and re-entrancy rules")
      accounts.ts  messages.ts  transactions.ts
      transaction-filler.ts port of Hardhat's built-in fill logic, pinned to an upstream commit
      send-guard.ts         process-global lock + nonce high-water + idempotency cache
    tasks/                  accounts, address, public-key, sign, sign-auth, sign-tx, verify
    vendor/micro-eth-signer/  vendored EIP-712 hashing (MIT, see "Vendored EIP-712")
    errors.ts               allow-listed error builder
    debug.ts                createDebug("hardhat:kms:hook-handlers:…" etc.)
```

The plugin object sets `npmPackage: "hardhat-kms"`. The config hook handler imports provider descriptors only, so loading a config never loads a cloud SDK.

### Provider contract

The contract is exported from `hardhat-kms/types`. It is frozen before 1.0 so that Turnkey and Fireblocks adapters can be added later without breaking changes. A provider is a descriptor plus a lazily loaded key adapter:

```ts
interface KmsProviderDescriptor<UserCfg, ResolvedCfg> {
  id: string; // "aws" | "gcp" | "azure" | third-party ids
  userSchema: ZodType<UserCfg>; // validated inside the root schema
  resolve(user: UserCfg, resolveVar: ResolveConfigurationVariable): ResolvedCfg; // pure
  displayId(cfg: ResolvedCfg): string; // safe to print; honours <VAR_NAME> masking
  sdk?: { packageName: string; range: string }; // checked at load time -> install instructions
  load(): Promise<{ createKey(cfg: ResolvedCfg, deps: ProviderDeps): Promise<KmsKeyAdapter> }>;
}
interface SignContext {
  signal: AbortSignal;
  displayMessage(m: string): Promise<void>;
  requestId: string;
  idempotencyKey?: string;
  chainId?: bigint;
}
interface KmsKeyAdapter {
  describe(): { provider: string; pinnedId: string; displayId: string };
  getPublicKey?(ctx: SignContext): Promise<Uint8Array>;
  getAddress?(ctx: SignContext): Promise<Address>; // API/vault signers without a public-key call
  signDigest?(req: { digest: Uint8Array }, ctx: SignContext): Promise<SignatureOutput>;
  signMessage?(
    req: { message: Uint8Array; digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput>;
  signTypedData?(
    req: { typedData: TypedData; digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput>;
  signTransaction?(
    req: { unsigned: Uint8Array; digest: Uint8Array; tx: FilledTx },
    ctx: SignContext,
  ): Promise<SignatureOutput>;
  sendTransaction?(req: { tx: FilledTx }, ctx: SignContext): Promise<{ hash: Hex }>; // remote broadcaster (Fireblocks)
  close?(): Promise<void>;
}
type SignatureOutput =
  { format: "der" | "compact"; bytes: Uint8Array } | { r: bigint; s: bigint; yParity?: 0 | 1 }; // yParity is a hint only: the core always re-derives and verifies it
interface ProviderDeps {
  displayMessage(msg: string): Promise<void>;
  debug: Debugger;
  now(): number;
}
```

The core enforces these rules on adapters:

- An adapter implements at least one of `getPublicKey` and `getAddress`, and at least one signing method.
- The core prefers the structured methods (`signMessage`, `signTypedData`, `signTransaction`) and falls back to `signDigest`. Structured methods exist so that providers with a policy engine see the full request, not only a digest. Whichever method signs, the core verifies the recovered signer against the account address.
- An adapter without `getPublicKey` (a Turnkey-style API signer) requires an `address` pin in config. Trial recovery then compares against the pinned address instead of a public key.
- A missing capability produces a "provider X cannot do Y" error.
- An adapter with `sendTransaction` broadcasts on its own. For those adapters the core skips the nonce high-water mark, rejects `eth_signTransaction` and EDR or fork networks with clear errors, passes the idempotency key (Fireblocks' `externalTxId`), and checks `from` against the receipt.

Built-in providers are validated inside the root zod schema with `conditionalUnionType` on `provider`. The root schema accepts any other `provider` id as an opaque object. At runtime, the `kms` hook handler that claims that id validates it; an id that no handler claims produces a clear error. Third-party providers and tests plug in through the plugin-owned `kms` hook category with `createKeyAdapter(ctx, accountConfig, next)`. Tests register fakes with `hre.hooks.registerHandlers("kms", …)`; the package ships no public fake provider. The `kms` hook types are marked `@experimental`.

### Request flow and re-entrancy rules

The dispatcher follows these rules. They keep the hook from deadlocking on its own internal calls and make each request's side effects easy to reason about.

1. Pass-through is the default. Only `eth_accounts`, `eth_requestAccounts` and the five signing methods are inspected. Everything else goes straight to `next`, so no allow-list of other methods is needed.
2. `next` is called at most once per request. Every internal RPC call (for example the reads during fill) goes through `connection.provider.request`, which re-enters the hook chain and is passed through by rule 1.
3. Per-HRE initialisation holds a mutex only while it builds plain objects. No I/O happens under that mutex.
4. `eth_sendTransaction` for KMS address `a` on chain `c` takes the process-global lock `c:a`. Inside the lock the code may issue read calls (fill), make any number of KMS signature attempts (retries), and make exactly one `next(eth_sendRawTransaction)`.
5. `eth_signTransaction` takes no lock and never touches the nonce high-water mark, because it never broadcasts.

### Other signing plugins

Hardhat runs dynamically registered handlers first, then plugins in reverse order of the `plugins` array, and its built-in handlers last. Another plugin that intercepts `eth_accounts` or `eth_sendTransaction`, such as `@nomicfoundation/hardhat-ledger`, therefore runs before or after hardhat-kms depending on where each appears in `plugins`. hardhat-kms only acts on addresses it owns and passes everything else on, so both plugins can coexist; an integration test in M4 loads hardhat-kms together with hardhat-ledger to keep it that way.

### Transaction filling

The plugin's hook runs before Hardhat's built-in handlers, so it has to fill transactions itself. `rpc/transaction-filler.ts` is a port of Hardhat's built-in fill logic, kept behind a `TransactionFiller` interface and pinned to a Hardhat commit. Building the signed transaction mirrors `LocalAccountsHandler#getSignedTransaction` field for field, using micro-eth-signer `^0.19` (the version Hardhat 3.18 depends on) with `strict=false`. The signed transaction is rebuilt from the verified r, s and yParity, and the code asserts `recoverSender().address === from`.

A differential test guards the port against drift. It sends the same request once with the key as a local account and once through KMS, and requires the same fields and the same unsigned bytes. The test runs against the Hardhat floor (the `^3.18.0` peer) and against `latest`, so a Dependabot bump of Hardhat that changes fill behaviour fails CI.

The long-term plan is to delete the port once Hardhat exports a filler or a post-fill signing stage (see [Roadmap](#roadmap)).

### Nonces and the send lock

The nonce for a KMS send is `max(pending, highWater + 1)`. The high-water mark is keyed by (connection, from):

- After a send, `hw = max(hw, usedNonce)`.
- A nonce supplied by the caller (Ignition does this) is always honoured, and sets `hw = max(hw, nonce)`.
- On `edr-simulated` networks the high-water mark is disabled, because the in-process pending count is authoritative there.

The lock stays process-global on `chainId:from`, so parallel sends from one process get consecutive nonces.

Separate processes are not coordinated. Two `hardhat run` invocations sending from the same KMS key at the same time can collide on a nonce, and the docs say so.

### Retries after broadcast

A send cannot be repeated blindly, because the transaction may already be on its way. The plugin handles failures after `next(eth_sendRawTransaction)` like this:

- Every failure after the broadcast call returns JSON-RPC error code -32000, which viem does not retry. The error carries the local transaction hash so the caller can look it up.
- A narrow cache covers clients that retry anyway. An entry is created only in that post-broadcast failure path, keyed by (connection, chainId, from, canonical JSON of the caller's params). It lives for 120 s and is consumed on the first hit. A retried identical request that hits it re-submits the same raw bytes (same hash), treats "already known" as success, and returns the same hash.
- Successful sends are never recorded. A deliberate duplicate send is therefore never dropped.
- The code never re-enters fill and sign after a broadcast.

A hardhat-viem test over HTTP injects a timeout on the broadcast and proves there is no double broadcast.

### Chain-id checks

Each `NetworkConnection` has one memoized promise (held in a WeakMap) that reads `eth_chainId`. The plugin resolves it before the first KMS signature of any kind on that connection, and also before the address-pin check. If the network config sets `chainId`, the two must be equal. The check fails closed, and because a failure is never cached, the next request simply tries again.

Hardhat adds its `ChainIdValidator` only to http networks that set a `chainId`, and it validates once per connection, on the first request the built-in handlers see. The fill reads of a transaction pass through it; message and typed-data signing never reach the built-in handlers. This check covers every case.

Two further rules apply:

- Transactions always carry an explicit `chainId`, and `tx.chainId` must equal the connection's chain id.
- Typed data whose `domain.chainId` differs from the connection's chain id is rejected unless `kms.allowCrossChainTypedData` is set.

### Lifetimes and caching

Adapters, SDK clients and public-key promises are cached per HRE, inside the hook-factory closure. Every connection and every test file shares them. The cache key is (provider, canonical configured id after `.get()`), with a secondary index by the resolved ARN or key version.

SDK clients are refcounted by connections. When the count reaches zero, an idle timer (`unref`'d, about 5 s) closes them, and they are re-created lazily on next use. They are never closed from `closeConnection`. GCP uses `{ fallback: true }` (REST) by default, so no gRPC channel keeps `hardhat run` alive. A test checks that `hardhat run` exits.

### Timeouts and retries

One AbortSignal timeout covers each whole KMS call, including the SDK's own retries. The default is 30 s (`kms.defaults.timeoutMs`, overridable per key). For GCP the plugin passes gax `timeout` and `retry` call options, which override the SDK's 600 s default.

Signing has no side effects, so the plugin retries throttling errors and GCP CRC mismatches, at most three times and honouring `Retry-After`.

### SDK loading

The only peer dependency is `hardhat`. Hardhat's peer-dependency checker ignores `peerDependenciesMeta`, so optional peers would not work. Users install the SDK for their provider, as the README documents. The cloud SDKs are devDependencies of the plugin itself.

An SDK is loaded on first use:

1. The plugin resolves the package with `createRequire(<project root>/package.json).resolve(pkg)`. This works with npm, pnpm and Yarn PnP because the user installs the SDK in their own project.
2. It finds the installed version by walking up from the resolved path.
3. It checks the version against the descriptor's `sdk: { packageName, range }` with `semver`, which is a runtime dependency.

A missing or incompatible SDK raises a `HardhatPluginError` containing the exact `npm i` command to fix it.

### Vendored EIP-712

EIP-712 hashing comes from micro-eth-signer 0.19, vendored: `core/typed-data` plus `advanced/abi-mapper`, about 500 lines. micro-eth-signer 0.19 does not export typed-data hashing, and this is the exact code Hardhat core uses, with the same strictness. A test re-checks the vendored code against the package's `verifyTyped`.

`ox` was considered and rejected. It brings about 30 MB of transitive dependencies (zod 4, post-quantum, bip39 and more) and silently accepts undeclared fields.

The vendored code lives in `src/internal/vendor/micro-eth-signer/` with SPDX MIT headers and a `THIRD_PARTY_NOTICES.md`. It is excluded from oxfmt and the jsdoc lint. `micro-packed`, already a dependency of micro-eth-signer, is declared explicitly.

## Security

### Signature pipeline

Every signature, from any adapter, goes through the same pipeline in `signer/kms-signer.ts` before it is used:

1. Strict parse with noble (DER or compact).
2. Range check on r and s.
3. Low-S normalization.
4. Trial recovery against the cached public key, or against the pinned address for adapters without `getPublicKey`. No match throws. Recovery ids that need an x-reduced point are rejected.
5. A final check with the matching verifier: `recoverSender` for transactions, `eip191Signer.verify` for messages, `verifyTyped` for typed data.

Every noble `verify` call passes `prehash:false`. If trial recovery fails, the signer makes one fresh signature attempt and then throws. The `yParity` an adapter returns is a hint only; the core always re-derives and verifies it.

### Key identity and pinning

The plugin caches a public key only after it matches the `address` pin, and it releases no signature before that check. Each provider adds its own identity checks:

| Provider | Checks                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS      | Signs with the ARN returned by `GetPublicKey`, never with the alias. Asserts KeySpec, KeyUsage and SigningAlgorithms. Requests use `MessageType: DIGEST`. |
| GCP      | Checks `name` and `algorithm`. A disabled or destroyed version gives a clear error.                                                                       |
| Azure    | Signs with the versioned id using `ES256K`. Checks enabled, keyOps, nbf and exp, and that the public point is on the curve.                               |

Signing with the ARN instead of the alias means a repointed alias cannot switch keys between the address lookup and the signature. Azure pins the version of an unversioned key for the same reason.

GCP responses get an integrity check. The plugin sends `digestCrc32c`, requires `verifiedDigestCrc32c` in the response, and checks `signatureCrc32c` with a table-based CRC32C implementation. A mismatch is retried at most three times.

### Errors, logs and secrets

Errors are `HardhatPluginError("hardhat-kms", …)` built from an allow-list of fields: provider, operation, display id, SDK error name or code, HTTP status and request id. Raw SDK errors are never attached as `cause`, and secrets are never included.

`debug` output may contain digests, addresses and display ids only.

`ResolvedConfigurationVariable` carries no name, so descriptors capture `ConfigurationVariable.name` at resolve time and produce `{ value, maskedAs: "<NAME>" }`. Ids derived from a masked value (an ARN, a pinned version) inherit the mask.

### Threat model summary

| Risk                                                                       | Control                                                                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A script or dependency asks the key to sign an arbitrary 32-byte digest    | No RPC method signs a bare digest. `--no-hash` exists only in the `kms sign` task.                                 |
| A signature intended for one chain is used on another                      | Chain-id check per connection, explicit `chainId` on every transaction, and the typed-data `domain.chainId` check. |
| The configured key changes underneath the user (rotation, repointed alias) | Address pin, AWS signing with the ARN from `GetPublicKey`, pinned GCP and Azure versions.                          |
| An adapter or KMS returns a malformed signature, or one from the wrong key | The signature pipeline: nothing is released unless it recovers to the account address.                             |
| Corruption of the digest or signature between the plugin and GCP           | CRC32C in both directions.                                                                                         |
| Credentials or identifiers leak through errors and logs                    | No secrets in config, allow-listed errors, restricted `debug` output, `<VAR_NAME>` masking.                        |
| A client retry broadcasts a transaction twice                              | Error code -32000 plus the local hash after broadcast, and the post-broadcast retry cache.                         |

The README's security model documents what the plugin does not protect against:

- Nonce collisions between separate processes using the same key.
- Access to the key itself, which the provider's IAM or RBAC controls. The README gives minimal policies, including the AWS conditions `kms:SigningAlgorithm` and `kms:MessageType`.
- Key deletion. Deleting a KMS key loses the funds at its address forever.

## Testing strategy

Tests form a pyramid. The lower layers are fast and pure; the upper layers exercise real SDKs and real chains.

1. Unit tests for pure crypto:
   - Vectors for SPKI DER/PEM, JWK with stripped zeros, the wrong curve, and DER strictness.
   - fast-check properties: high-S and low-S DER both normalise and recover to the address; parsing random bytes never succeeds silently; JWK and SPKI encodings convert back and forth without loss.
   - CRC32C vectors.
   - The vendored EIP-712 code checked against the package's `verifyTyped`.
2. Unit tests for the signer and adapters:
   - Injected fake SDK clients sign with a local key and return the exact wire formats: AWS SPKI + DER; GCP PEM + DER + CRC (including corrupted CRCs); Azure JWK + r‖s.
   - Assertions on request parameters: `MessageType: DIGEST`, the ARN taken from `GetPublicKey`, `ES256K` with the versioned id, the GCP call options.
   - A fake adapter that returns a signature from the wrong key, and an address-pin mismatch.
   - An AbortSignal timeout, driven by an injected clock.
   - Bounded GCP CRC retries, and the Azure managed identity timeout.
3. Byte equivalence:
   - A deterministic fake backend (RFC6979 with Hardhat's test key) must produce raw transactions and signatures byte-identical to Hardhat's `local-accounts.ts` vectors: legacy, 2930, 1559, 7702, eth_sign, personal_sign, 712.
   - Differential checks against viem `signTransaction` and ethers `Wallet.signTransaction`.
   - The differential fill test described under [Transaction filling](#transaction-filling), run against the Hardhat floor and `latest`.
4. Integration tests on a real HRE with `edr-simulated` and a fake adapter registered through the `kms` hook:
   - hardhat-viem and hardhat-ethers flows: deploy, every transaction type, and `signMessage`/`signTypedData` verified on chain with `ecrecover`.
   - N parallel sends plus reads: consecutive nonces and no deadlock.
   - Retry behaviour with viem on an http network: no double broadcast, and no retry after send.
   - Mixed local and KMS accounts.
   - Chain-id guards.
   - Config errors reported at the exact path.
   - Every task.
   - `hardhat run` exits.
   - Error messages never contain the injected fake secrets.
5. Emulated AWS: LocalStack `4.14.0`, pinned by digest and bound to a random host port, with the real `@aws-sdk/client-kms` against an `ECC_SECG_P256K1` key. About half of its signatures come back high-S, which exercises normalization. This layer runs on Ubuntu CI only.
6. Live tests (`test:live`, triggered manually in a protected environment) use real AWS, GCP and Azure keys on Sepolia, reached through GitHub OIDC. They deploy, send every transaction type, and verify message and typed-data signatures on chain. Transaction hashes are recorded in `docs/live-proof.md`.
7. Mutation testing runs Stryker (tap-runner) on `crypto/` and `signer/`. It becomes a nightly job after milestone M9.

Test code follows a few conventions:

- Each test opens a fresh connection with `hre.network.create()` (`connect()` is deprecated since Hardhat 3.18; `getOrCreate()` reuses cached connections, so per-connection state must tolerate reuse).
- HRE test files run with `concurrency:false`.
- Test globs are quoted in scripts, so the shell does not expand them.
- Helpers live in the repo's own `test/helpers`, because `hardhat-test-utils` is private.

Coverage uses c8 on native TypeScript (Node 24), with a global threshold of 95% for lines, branches, functions and statements across `src/`. Provider adapters are tested with fake SDK clients, so they are held to the same bar. `types.ts` and `type-extensions.ts` are excluded.

## Quality gates and tooling

| Gate         | Tool / setting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format       | `oxfmt` 0.71.0 (pinned exactly; import sorting). Pre-commit fixes staged files; CI runs `--check`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Lint         | `oxlint` 1.86.0, type-aware with `oxlint-tsgolint` 7.0.2003.<br>Options: `denyWarnings`, `reportUnusedDisableDirectives: deny`.<br>Plugins: eslint, typescript, import, jsdoc, node, promise, oxc, unicorn.<br>`jsPlugins: eslint-plugin-jsdoc` 65.0.0 with `require-jsdoc` (publicOnly, `enableFixer:false`) + `jsdoc/no-blank-blocks`.<br>`node/no-process-env` is an error (every env read is explicit).<br>Type-aware safety rules: `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, `strict-boolean-expressions`, `no-unsafe-*`, `only-throw-error`, `no-deprecated`.                                                 |
| Types        | TypeScript 7.0.2 native `tsc -b` (no TS6 alias needed, since there is no TypeDoc).<br>Settings: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUncheckedSideEffectImports`, `isolatedDeclarations`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `rewriteRelativeImportExtensions`, `noEmitOnError`.<br>`tsconfig.build.json` compiles `src` only.<br>A consumer typecheck of the packed tarball runs on TypeScript 5.9, 6.0 and 7.0.                                                                                                                                      |
| Tests        | `node --test` with native type stripping.<br>The Node 22.13.0 leg uses `--import tsx`.<br>`c8` 12 thresholds; `fast-check` 4.10.2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Package      | `publint` 0.3.24, `@arethetypeswrong/cli` 0.18.5 (`--profile esm-only`), `knip` 6.38.0. `engines.node >=22.13.0`. `publishConfig.provenance`. Peer dependency `hardhat` `^3.18.0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Git hooks    | `lefthook` 2.1.15.<br>pre-commit (parallel): oxfmt and oxlint `--fix` on staged files (re-staged), `tsc -b --noEmit`.<br>commit-msg: one-line conventional-commit regex (no commitlint, which would duplicate changesets).<br>pre-push: a plain git hook (installed by `scripts/install-git-hooks.ts`, not by lefthook) refuses direct pushes to `main`, then runs the unit tests.                                                                                                                                                                                                                                                                      |
| Releases     | `@changesets/cli` 3.0.3 + `@changesets/changelog-github`.<br>Publish via npm trusted publishing (OIDC) on Node 24 (npm ≥ 11); no NPM_TOKEN; provenance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Dependencies | Dependabot, weekly.<br>npm: groups `tooling` / `hardhat` / `cloud-sdks` / `crypto`; `versioning-strategy: increase-if-necessary`; cooldown 7 days (30 for majors; security updates are immediate); ignore `zod >=4` and `micro-eth-signer >=0.20` until Hardhat moves.<br>github-actions: weekly, cooldown 7 days.<br>Lockfile committed; CI runs `npm ci --ignore-scripts`.                                                                                                                                                                                                                                                                            |
| CI           | All jobs: `permissions: contents: read`; actions pinned by SHA; `zizmor`.<br>Jobs: lint, test matrix (ubuntu with Node 22.13.0 via tsx, 24.0.0 and 26.0.0; macOS and Windows on 22.13.0), coverage, package, localstack, live (manual dispatch), release.<br>An SDK job tests each cloud SDK at its floor version and at latest.<br>The differential fill test runs against the Hardhat floor and `latest`.<br>CodeQL default setup once the repository is public.<br>Landing order: lint, tests, coverage, package, consumer typecheck and zizmor exist from M0; localstack comes with M3, the SDK job with M3 and M6, live with M9, release with M10. |
| Repo         | `.gitattributes` (`eol=lf`), `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE` (MIT), `CODEOWNERS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Documentation plan

The README covers:

- why the plugin exists and how it compares with Foundry and existing plugins;
- installation per provider;
- key creation per provider, with CLI commands and minimal IAM/RBAC policies, including the AWS conditions `kms:SigningAlgorithm` and `kms:MessageType`;
- a configuration reference;
- the Foundry migration table;
- usage with viem, ethers and Ignition, and the tasks;
- the security model: what it protects and what it doesn't, the controls, and a warning that deleting a key loses funds forever;
- troubleshooting, with an error table per provider;
- how it works.

Other docs are `docs/adding-a-provider.md`, `CONTRIBUTING.md`, `SECURITY.md`, the changesets `CHANGELOG.md`, and TSDoc on every export and every core and adapter function, enforced by lint.

## Roadmap

| Release        | Scope                                                                                                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1.1           | `connection.kms.getAccount(addr)`, a viem-compatible `LocalAccount` with `signAuthorization` for library use. An Alchemy Wallet APIs recipe in the docs. `kms accounts --balances` and `--check-sign`.                                                                                                                    |
| v1.1 or v1.2   | Turnkey provider: an address-pinned adapter with no public-key call. It returns `{r, s, v}`, which the core re-normalizes and verifies. It can use the structured `signTransaction`/`signTypedData` so Turnkey policies see the full request. `TURNKEY_API_PRIVATE_KEY` must be a config variable and is never displayed. |
| v1.3           | Fireblocks provider, with `broadcast` and `raw` modes.                                                                                                                                                                                                                                                                    |
| v2 (on demand) | An Alchemy or smart-account send mode.                                                                                                                                                                                                                                                                                    |

Other candidates are PKCS#11 HSMs, whose raw r‖s output fits the contract. HashiCorp Vault transit is not a candidate, because it has no secp256k1 support.

Upstream, the project proposes that Hardhat export its transaction filler or add a post-fill signing stage. If Hardhat accepts, the ported fill logic goes away. The issue is filed during milestone M5, once the port exists and the proposal can point at working code.

## Milestones

The critical path runs M0, M1, M2, M3, M4, M5, M9, M10. M6 can start after M3 and run in parallel. The live-test infrastructure for M9 (OIDC, keys, Sepolia funding) is set up during M3 to M5.

| Milestone | Scope                                                                                                                  | Exit criteria                                                                                                                                                                   | Effort |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M0        | Scaffolding, M0 gates, CI, Dependabot, docs skeleton, empty plugin, consumer typecheck                                 | Gates green; the plugin loads in an HRE from `createHardhatRuntimeEnvironment`; consumer `tsc` passes on TS 5.9, 6.0 and 7.0                                                    | M      |
| M1        | `crypto/`, `signer/`, vendored EIP-712                                                                                 | Vectors, fast-check properties, at least 95% coverage, EIP-712 equivalence                                                                                                      | M      |
| M2        | Config, named keys, masking, Foundry helper, descriptors and registry, `kms` hook, errors, debug                       | Config errors at the exact path; descriptors import no SDK; the hook seam works                                                                                                 | M      |
| M3        | AWS adapter and LocalStack                                                                                             | Fake-client unit tests (DIGEST, ARN from `GetPublicKey`, key spec); LocalStack green, including high-S                                                                          | M      |
| M4        | RPC accounts, messages, typed data, chain-id guard, dispatcher                                                         | Message byte equivalence; on-chain `ecrecover` on EDR                                                                                                                           | M      |
| M5        | Transactions: filler, `eth_sendTransaction`/`eth_signTransaction`, send guard, error discipline, all transaction types | Raw transaction byte equivalence; differential fill test on the Hardhat floor and latest; parallel nonces; no double broadcast on viem retry; viem, ethers and Ignition deploys | L      |
| M6        | GCP and Azure adapters                                                                                                 | Fake clients including corrupted CRC; `hardhat run` exits; Azure managed identity timeout                                                                                       | L      |
| M7        | Tasks                                                                                                                  | An integration test per task; `--no-hash` only in `kms sign`; chain 0 needs `--force`                                                                                           | M      |
| M8        | Docs                                                                                                                   | jsdoc lint passes; a walkthrough of the docs works end to end                                                                                                                   | M      |
| M9        | Live Sepolia tests (AWS, GCP, Azure) via GitHub OIDC                                                                   | All transaction types and signatures verified on chain; `docs/live-proof.md` written                                                                                            | M      |
| M10       | Release: changesets, trusted publishing, release candidate, then 1.0.0                                                 | Dry-run publish; the release candidate installs cleanly                                                                                                                         | S      |
