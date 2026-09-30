# hardhat-kms — design v1

The best Hardhat 3 community plugin for signing with keys held in cloud KMS/HSMs — **AWS KMS, GCP Cloud KMS, Azure Key Vault / Managed HSM** — at least on par with Foundry's KMS support, and built so a new KMS/HSM is one adapter folder.

Inputs: `docs/research/01..03`. Reviews folded in: `docs/reviews/round1-{architecture,security,toolchain,foundry-parity}.md` (finding ids like `A-B1`, `S-B1`, `T-B1`, `P-3` are referenced below). v0 is in git history (`c713a63`).

---

## 1. User-facing behaviour

### 1.1 Configuration
```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKms from "hardhat-kms";

export default defineConfig({
  plugins: [hardhatKms],
  kms: {
    defaults: { aws: { region: "eu-west-1" }, timeoutMs: 30_000 },
    keys: {
      deployer: { provider: "aws", keyId: "alias/deployer", address: "0x1234…" },          // address pin: optional, recommended
      ops:      { provider: "azure", keyId: "https://ops.vault.azure.net/keys/ops/0123abcd" },
      treasury: { provider: "gcp", keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/3" },
    },
  },
  networks: {
    sepolia:  { type: "http", url: configVariable("SEPOLIA_RPC_URL"), chainId: 11155111, kmsAccounts: ["deployer", "ops"] },
    arbitrum: { type: "http", url: configVariable("ARB_RPC_URL"), chainId: 42161, kmsAccounts: ["deployer"] },
    fork:     { type: "edr-simulated", forking: { url: configVariable("SEPOLIA_RPC_URL") }, kmsAccounts: ["deployer"] },
  },
});
```
- `kms.keys` holds named keys, reused across networks (A-S1). A network's `kmsAccounts` lists key names or inline key objects.
- Key forms per provider, a superset of Foundry's (P-2):
  - **aws**: `keyId` = key id, key ARN, alias name or alias ARN. Optional `region`, `profile`, `endpoint`. `AWS_ENDPOINT_URL_KMS` is also honoured (for LocalStack).
  - **gcp**: either `keyVersionName`, or the components `projectId`, `location`, `keyRing`, `keyName`, `keyVersion`. The version is always required, never auto-selected.
  - **azure**: either `keyId` (full URL, versioned or not, including `*.managedhsm.azure.net`), or `vaultUrl` + `keyName` + optional `keyVersion`. An unversioned key is resolved once and pinned.
  - Common to all: optional `address` pin, and optional `timeoutMs`.
- Identifiers are not secrets (A-S2). Every identifier field accepts `string | ConfigurationVariable`. Values that came from a variable are displayed as `<VAR_NAME>` unless the user passes `--show-ids`.
- **Foundry migration** (P-1): the helper `import { kmsKeysFromFoundryEnv } from "hardhat-kms/foundry"` expands the Foundry variables into keys:
  - `AWS_KMS_KEY_ID(S)`
  - `GCP_PROJECT_ID`, `GCP_LOCATION`, `GCP_KEY_RING`, `GCP_KEY_NAME`, `GCP_KEY_VERSION`
  - `AZURE_KEY_VAULT_KEY_ID(S)`
  
  Lists are comma-split and trimmed, and blanks are dropped. A mapping table is in the README.
- Credentials always come from each provider's default chain; no secrets live in config.
  - **AWS**: the SDK default chain (env → SSO/ini/profile → process → web identity → IMDS/ECS).
  - **GCP**: Application Default Credentials.
  - **Azure**: the same order as our Foundry signer (P-6): service principal → workload identity → `az`/`azd` → managed identity (10 s timeout; `AZURE_CLIENT_ID` selects a user-assigned identity), built with `ChainedTokenCredential`.
- Providers can be added through the declaration-merged `KmsProviderUserConfigs` interface (A-S4).

### 1.2 RPC behaviour (network hook)
- **Accounts.** KMS addresses are appended to `eth_accounts` and `eth_requestAccounts`, after the network's own accounts. If the downstream call fails, only the KMS addresses are returned.
  - Addresses come from the `address` pin when present (no KMS call), otherwise from a public-key lookup (in parallel, cached per HRE).
  - Everything else passes through untouched, so viem, ethers, Ignition and scripts work unchanged.
- **Intercepted methods** (only when the address is a KMS account; anything else passes through):
  - `eth_sendTransaction`
  - `eth_signTransaction` (sign without sending, parity with `cast mktx`)
  - `eth_sign` and `personal_sign`: EIP-191 with the message prefix, the same semantics as Hardhat core. **Signing a bare digest is never exposed over RPC** (S-S3).
  - `eth_signTypedData_v4`
- **Transaction types:** legacy (EIP-155 only), EIP-2930, EIP-1559, EIP-7702.
  - For EIP-7702: an `authorizationList` entry given as an *unsigned* delegate address, with a KMS sender, is signed with the sender's key using nonce+1. That matches `cast send --auth` (P-5).
  - **EIP-4844 is unsupported.** Hardhat core doesn't support it either; this is documented (P-9).
- **Unknown `from`:** passed through. But if the sender is not a local account either, the error lists the loaded KMS addresses (P-8).

### 1.3 Tasks (`kms` namespace, an `emptyTask` like the keystore plugin)
| Task | Purpose | Foundry equivalent |
|---|---|---|
| `kms accounts [--network n] [--json] [--balances] [--check-sign] [--show-ids]` | Every configured key: provider, pinned id, address. Checks access, and prints ready-to-paste `address` pins. | `cast wallet list/address` (ours checks access) |
| `kms address <key>` / `kms public-key <key>` | Address, or the uncompressed public key | `cast wallet address`; public key: **Foundry has none** |
| `kms sign <key> <message> [--typed-data file] [--no-hash]` | EIP-191 / EIP-712 / raw 32-byte digest. `--no-hash` is only available here, as an explicit human action. | `cast wallet sign [--data] [--no-hash]` |
| `kms sign-auth <key> <delegate> --chain <id> [--nonce n] [--self-broadcast] [--force]` | EIP-7702 authorization. Chain 0 requires `--force`; `--self-broadcast` uses nonce+1. | `cast wallet sign-auth` |
| `kms sign-tx <key> --network n <tx.json>` | Filled, signed, not broadcast | `cast mktx` |
| `kms verify <address> <message> <signature>` | Local verification | `cast wallet verify` |

### 1.4 Explicitly better than Foundry (listed in the README)
- GCP CRC32C integrity checks (Foundry has none).
- Post-sign verification of every signature (Foundry's Turnkey signer has none).
- Per-call timeouts on every provider.
- Multiple keys for every provider (Foundry allows only one GCP key and one Turnkey key).
- An account listing that checks access.
- A `public-key` command.
- A chain-id guard on typed data.
- Idempotent sends.

---

## 2. Architecture

```
src/
  index.ts                  definePlugin: types, constants, lazy hook/task imports only (Hardhat guideline A2)
  type-extensions.ts        augments HardhatUserConfig/HardhatConfig (kms) + Http/Edr Network(User)Config (kmsAccounts); no named exports
  types.ts                  public provider-author types (exported via the "hardhat-kms/types" subpath) (A-S10)
  foundry.ts                kmsKeysFromFoundryEnv() (exported via the "hardhat-kms/foundry" subpath)
  internal/
    config/                 zod v3 schema rooted at HardhatUserConfig; conditionalUnionType on `provider`; superRefine for named-key refs
                            (path ["networks", n, "kmsAccounts", i]); pure resolve (A-S1)
    hook-handlers/
      config.ts             validate/resolve (imports provider *descriptors* only)
      network.ts            onRequest / closeConnection
      kms.ts                default handler of the plugin-owned `kms` hook category (A-S4)
    providers/
      registry.ts           provider id -> descriptor; adding a provider = one folder + one line here
      aws/ gcp/ azure/      descriptor.ts (zod schema, resolve, sdk {pkg, range}, display id)
                            adapter.ts (lazy: SDK client, credentials, version pinning)
                            wire.ts (pure decoding: SPKI/PEM/JWK, DER/compact, CRC32C)
    crypto/                 pure, no SDKs: public-key.ts, signature.ts, address.ts, crc32c.ts, eip712.ts (vendored, §3)
    signer/
      key-cache.ts          per-HRE cache: (provider, pinned id) -> adapter + public key promise (A-B2)
      kms-signer.ts         signDigest -> {r, s, yParity}: parse -> range -> low-S -> trial recovery -> verify (S-S1)
    rpc/
      dispatcher.ts         the flow in §2.2
      accounts.ts  messages.ts  transactions.ts
      transaction-filler.ts port of Hardhat's built-in fill logic, pinned to an upstream commit (A-S3)
      send-guard.ts         process-global lock + nonce high-water + idempotency cache (S-B1, S-B2)
    tasks/                  accounts, address, public-key, sign, sign-auth, sign-tx, verify
    errors.ts               allow-listed error builder (S-S5)
    debug.ts                createDebug("hardhat:kms:hook-handlers:…" etc.)
```

### 2.1 Provider contract (`hardhat-kms/types`)
```ts
interface KmsProviderDescriptor<UserCfg, ResolvedCfg> {
  id: string;                                  // "aws" | "gcp" | "azure" | third-party ids
  userSchema: ZodType<UserCfg>;                // validated inside the root schema
  resolve(user: UserCfg, resolveVar: ResolveConfigurationVariable): ResolvedCfg;   // pure
  displayId(cfg: ResolvedCfg): string;         // safe to print; honours <VAR_NAME> masking
  sdk?: { packageName: string; range: string };// checked at load time -> install instructions
  load(): Promise<{ createKey(cfg: ResolvedCfg, deps: ProviderDeps): Promise<KmsKeyAdapter> }>;
}
interface KmsKeyAdapter {
  describe(): { provider: string; pinnedId: string; displayId: string };
  getPublicKey?(signal: AbortSignal): Promise<Uint8Array>;     // optional only for address-pinned API signers (Turnkey)
  signDigest(digest: Uint8Array, signal: AbortSignal): Promise<SignatureOutput>;
  signTransaction?(unsigned: Uint8Array, digest: Uint8Array, signal: AbortSignal): Promise<SignatureOutput>;   // policy-engine capability
  signTypedData?(typedData: TypedData, digest: Uint8Array, signal: AbortSignal): Promise<SignatureOutput>;    // policy-engine capability
  close?(): Promise<void>;
}
type SignatureOutput =
  | { format: "der" | "compact"; bytes: Uint8Array }
  | { r: bigint; s: bigint; yParity?: 0 | 1 };                 // yParity is a hint only: the core always re-derives and verifies it
interface ProviderDeps { displayMessage(msg: string): Promise<void>; debug: Debugger; now(): number }
```
- Third-party providers and tests plug in through the `kms` hook category, `createKeyAdapter(ctx, accountConfig, next)`. Tests register fakes with `hre.hooks.registerHandlers("kms", …)`; no public fake provider is shipped (A-S4).

### 2.2 Request flow and re-entrancy rules (A-B1)
1. **Default pass-through.** Only `eth_accounts`, `eth_requestAccounts` and the 5 signing methods are ever inspected. Everything else goes straight to `next`, so no allow-list is needed.
2. **`next` is called at most once per request.** Every internal RPC goes through `connection.provider.request`, which re-enters the chain and is passed through by rule 1.
3. **Per-HRE initialisation guards only the construction of plain objects.** No I/O happens under that mutex.
4. **Send guard.** `eth_sendTransaction` for KMS address `a` on chain `c` takes the process-global lock `c:a` (S-B2). Inside the lock the code may only:
   - issue read calls (fill);
   - make the KMS signature;
   - make exactly one `next(eth_sendRawTransaction)`.
   
   `eth_signTransaction` fills under the same lock but never advances the nonce high-water mark.
5. **Nonce:** `max(pending, highWater[c:a] + 1)`, and the high-water mark advances only after a successful broadcast. A nonce supplied by the caller (Ignition) is always honoured.
6. **Idempotency (S-B1).** Each send is recorded under (chainId, from, hash of the normalized request) with a 120 s TTL. A retried identical request re-submits the **same raw bytes** (same hash), treats "already known" as success, and returns the same hash.
   - Errors raised *after* broadcasting carry the local tx hash and a non-retryable JSON-RPC code (-32000), so viem does not re-send.
7. **Chain id (S-B3, A-S8).** Before the first KMS signature of any kind on a connection, `eth_chainId` is read. It must equal `networkConfig.chainId` if one is set; our hook bypasses Hardhat's `ChainIdValidator`.
   - Transactions always get an explicit `chainId`, and `tx.chainId` must equal the chain id.
   - Typed data whose `domain.chainId` differs from the chain id is rejected, unless `kms.allowCrossChainTypedData` is set (S-S3).

### 2.3 Lifetimes (A-B2)
- Adapters, SDK clients and public-key promises are cached **per HRE** (in the hook-factory closure), keyed by (provider, pinned id). They are shared by every connection and every test file.
- Clients are closed or unref'd when idle and on `closeConnection`, so `hardhat run` always exits. A test covers this for GCP's gRPC client.

---

## 3. Key decisions
| Topic | Decision | Source |
|---|---|---|
| Transaction building | Mirror `LocalAccountsHandler#getSignedTransaction` field for field, with micro-eth-signer `^0.19` (the version Hardhat 3.18 depends on), `strict=false`. The signed tx is rebuilt from the verified r/s/yParity; `recoverSender().address === from` is asserted. | research 02, S-S1 |
| Fill logic | Ported behind a `TransactionFiller` interface, pinned to a Hardhat commit. A differential test compares against Hardhat's own fill (same request, key as a local account vs through KMS: same fields and unsigned bytes), and a CI drift watch tracks the upstream files' blob hashes. Upstream issue proposing an exported filler / post-fill sign stage. | A-S3 |
| EIP-712 digest | **Vendor micro-eth-signer 0.19 `core/typed-data.js`** (MIT, 327 lines): the exact code Hardhat core uses, and just as strict. A test re-checks it against the package's `verifyTyped`. `ox` rejected: ~30 MB of transitive dependencies (zod 4, post-quantum, bip39…) and it silently accepts undeclared fields. | S-S4 (overrides A-S5) |
| Signature pipeline | Strict noble parse → range check → low-S → trial recovery against the cached public key (throws on no match; x-reduced ids rejected) → final check (`recoverSender`, `eip191Signer.verify`, `verifyTyped`). Every noble `verify` call passes `prehash:false`. If trial recovery fails: one fresh signature attempt, then throw. | S-S1, S-N3 |
| Key identity | The public key is cached only after it matches the `address` pin, and no signature is released before that check.<br>AWS: sign with the **ARN returned by GetPublicKey** (never the alias), and assert KeySpec/KeyUsage/SigningAlgorithms.<br>GCP: check `name` and `algorithm`; a disabled or destroyed version gives a clear error.<br>Azure: sign with the versioned id; check enabled/keyOps/nbf/exp and that the point is on the curve. | S-S2 |
| GCP integrity | Send `digestCrc32c`; require `verifiedDigestCrc32c`; check `signatureCrc32c` with a table-based CRC32C implementation. Bounded retries (≤3). | research 03 |
| Timeouts / retries | One AbortSignal timeout covers each whole call, including SDK retries (default 30 s).<br>GCP: gax `timeout`/`retry` call options (override the 600 s default).<br>Signing is side-effect free, so retries on throttling or CRC mismatch are allowed (≤3, honouring Retry-After). Never re-enter fill→sign after a broadcast. | S-S6 |
| SDK dependencies | **The only peer dependency is `hardhat`** (Hardhat's checker ignores `peerDependenciesMeta`, T-B2). Users install their provider's SDK, as documented. It is loaded at first use with a semver check; a missing or incompatible SDK raises a `HardhatPluginError` containing the exact `npm i` command. The cloud SDKs are devDependencies. | T-B2 |
| Errors | `HardhatPluginError("hardhat-kms", …)` built from an allow-list: provider, operation, display id, SDK error name/code, HTTP status, request id. Raw SDK errors are never attached as `cause`; secrets are never included. | S-S5 |
| Debug | `debug` output may contain digests, addresses and display ids only. | S-S5 |
| EDR | Optional `kms.simulatedBalance`, which calls `hardhat_setBalance` for KMS addresses on `edr-simulated` networks. Warn when `kmsAccounts` is set on the `default` network. | A-NICE, A-S1 |

---

## 4. Tests (proof pyramid)
1. **Unit (pure crypto)**
   - Vectors for SPKI DER/PEM, JWK with stripped zeros, wrong curve, and DER strictness.
   - fast-check properties: high-S and low-S DER both normalise and recover to the address; parsing random bytes never succeeds silently; JWK/SPKI round-trip (T-11).
   - CRC32C vectors.
   - Vendored EIP-712 checked against the package's `verifyTyped`.
2. **Unit (adapters)**
   - Fake SDK clients, injected, sign with a local key and return the exact wire formats: AWS SPKI + DER; GCP PEM + DER + CRC (including corrupted CRCs); Azure JWK + r‖s.
   - Assert the request parameters: `MessageType: DIGEST`, the ARN taken from GetPublicKey, `ES256K` with the versioned id, the GCP call options.
3. **Byte equivalence**
   - A deterministic fake backend (RFC6979 with Hardhat's test key) must produce raw txs and signatures byte-identical to Hardhat's `local-accounts.ts` vectors: legacy, 2930, 1559, 7702, eth_sign, personal_sign, 712.
   - Differential checks against viem `signTransaction` and ethers `Wallet.signTransaction` (T-11).
4. **Integration** (real HRE on `edr-simulated`, fake adapter registered through the `kms` hook)
   - hardhat-viem and hardhat-ethers flows: deploy, every tx type, `signMessage`/`signTypedData` verified **on chain** with `ecrecover`.
   - N parallel sends plus reads: consecutive nonces, no deadlock.
   - Retry/idempotency with viem on an http network: no double broadcast.
   - Mixed local and KMS accounts.
   - Chain-id guards.
   - Config errors reported at the exact path.
   - Every task.
   - `hardhat run` exits.
   - Error messages never contain the injected fake secrets.
5. **Emulated AWS**
   - LocalStack `4.14.0`, pinned by digest, with the real `@aws-sdk/client-kms` against an `ECC_SECG_P256K1` key. About 50% of signatures come back high-S, which exercises normalization. Ubuntu CI only.
6. **Live** (`test:live`, triggered manually, protected environment)
   - Real AWS, GCP and Azure keys on Sepolia: deploy, every tx type, and message/typed-data signatures verified on chain.
   - Tx hashes are recorded in `docs/live-proof.md`.
7. **Mutation testing**
   - Stryker (tap-runner) on `crypto/` and `signer/`, nightly or manual.

Coverage: c8 on native TypeScript (Node 24), with thresholds of ≥95% lines and branches for `crypto/`, `signer/` and `rpc/`.

---

## 5. Quality gates (2026 toolchain, latest versions — verified in `round1-toolchain.md`)
| Gate | Tool / setting |
|---|---|
| Format | `oxfmt` 0.71.0 (pinned exactly; import sorting). Pre-commit fixes staged files; CI runs `--check`. |
| Lint | `oxlint` 1.86.0, type-aware with `oxlint-tsgolint` 7.0.2003.<br>Options: `denyWarnings`, `reportUnusedDisableDirectives: deny`.<br>Plugins: eslint, typescript, import, jsdoc, node, promise, oxc, unicorn.<br>`jsPlugins: eslint-plugin-jsdoc` 65.0.0 with `require-jsdoc` (publicOnly, `enableFixer:false`) + `jsdoc/no-blank-blocks`.<br>`node/no-process-env` is an error (every env read is explicit).<br>Type-aware safety rules: `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, `strict-boolean-expressions`, `no-unsafe-*`, `only-throw-error`, `no-deprecated`. |
| Types | TypeScript **7.0.2** native `tsc -b` (no TS6 alias needed: no TypeDoc).<br>Settings: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUncheckedSideEffectImports`, `isolatedDeclarations`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `rewriteRelativeImportExtensions`, `noEmitOnError`.<br>`tsconfig.build.json` compiles `src` only. |
| Tests | `node --test` with native type stripping.<br>The Node 22.13.0 leg uses `--import tsx` (T-B1).<br>`c8` 12 thresholds; `fast-check` 4.10.2. |
| Package | `publint` 0.3.24, `@arethetypeswrong/cli` 0.18.5 (`--profile esm-only`), `knip` 6.38.0. `engines.node >=22.13.0`. `publishConfig.provenance`. |
| Git hooks | `lefthook` 2.1.15.<br>pre-commit (parallel): oxfmt and oxlint `--fix` on staged files (re-staged), `tsc -b --noEmit`.<br>commit-msg: one-line conventional-commit regex (commitlint dropped as redundant with changesets, T-7).<br>pre-push: unit tests. |
| Releases | `@changesets/cli` 3.0.3 + `@changesets/changelog-github`.<br>Publish via npm **trusted publishing (OIDC)** on Node 24 (npm ≥ 11); no NPM_TOKEN; provenance. |
| Dependencies | Dependabot, weekly.<br>npm: groups `tooling` / `hardhat` / `cloud-sdks` / `crypto`; `versioning-strategy: increase-if-necessary`; cooldown 7 days (30 for majors; security updates are immediate); ignore `zod >=4` and `micro-eth-signer >=0.20` until Hardhat moves.<br>github-actions: weekly, cooldown 7 days.<br>Lockfile committed; CI runs `npm ci --ignore-scripts`. |
| CI | All jobs: `permissions: contents: read`; actions pinned by SHA; `zizmor`.<br>Jobs: lint · test matrix (ubuntu × Node 22.13.0 via tsx, 24.0.0, 26.0.0; macOS and Windows on 22.13.0) · coverage · package · localstack · live (manual dispatch) · release.<br>CodeQL default setup. Upstream-drift watch for the ported fill logic. |
| Repo | `.gitattributes` (`eol=lf`), `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE` (MIT), `CODEOWNERS`. |

---

## 6. Roadmap (post-v1)
- **v1.1**: `connection.kms.getAccount(addr)`, a viem-compatible `LocalAccount` with `signAuthorization` for library use (A-S9).
- **Turnkey provider** (TODO: needs a Turnkey account). It is an address-pinned adapter with no public-key call, returning `{r, s, v}` that the core re-normalizes and verifies. It can use structured `signTransaction`/`signTypedData` so Turnkey policies see the full request. `TURNKEY_API_PRIVATE_KEY` must be a config variable and never displayed. Adoption research is pending (see chat).
- Other candidates: Fireblocks-style APIs; PKCS#11 HSMs (raw r‖s fits the contract). Not HashiCorp Vault transit, which has no secp256k1.
- Upstream: propose to Hardhat an exported transaction filler or a post-fill signing stage, then delete our port.

## 7. Docs
**README:**
- why, and why better than Foundry / existing plugins;
- install per provider;
- per-provider key creation with CLI commands and minimal IAM/RBAC policies, including the AWS conditions `kms:SigningAlgorithm` and `kms:MessageType`;
- configuration reference;
- Foundry migration table;
- usage with viem, ethers and Ignition, and the tasks;
- **security model**: what it protects and what it doesn't; controls; warning that deleting a key loses funds forever;
- troubleshooting (a per-provider error table);
- how it works.

**Other docs:** `docs/adding-a-provider.md`, `CONTRIBUTING.md`, `SECURITY.md`, changesets `CHANGELOG.md`, and TSDoc on every export and every core/adapter function (lint-enforced).
