# hardhat-kms — design (v0, for review)

Goal: the best Hardhat 3 community plugin for signing with keys held in cloud KMS/HSMs — AWS KMS, GCP Cloud KMS, Azure Key Vault / Managed HSM — built so a new KMS/HSM is one small adapter. Inputs: `docs/research/01..03`.

## 1. User-facing behaviour

```ts
// hardhat.config.ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKms from "hardhat-kms";

export default defineConfig({
  plugins: [hardhatKms],
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      kmsAccounts: [
        { provider: "aws", keyId: configVariable("AWS_KMS_KEY_ARN"), region: "eu-west-1" },
        { provider: "gcp", keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1" },
        { provider: "azure", vaultUrl: "https://my-vault.vault.azure.net", keyName: "deployer", keyVersion: "0123abcd..." },
      ],
    },
  },
});
```

- Addresses appear in `eth_accounts` / `eth_requestAccounts` (after the network's own accounts, like hardhat-ledger), so `hre.viem.getWalletClients()`, `ethers.getSigners()`, Ignition and scripts work unchanged.
- Intercepted for KMS-owned addresses: `eth_sendTransaction`, `eth_signTransaction`, `eth_sign`, `personal_sign`, `eth_signTypedData_v4`. Everything else, and every non-KMS address, passes through untouched.
- Optional per-account `address` pins the expected address: `eth_accounts` is answered with no KMS call, and the first KMS use verifies the key really derives to it (defends against alias / key-version retargeting).
- Credentials come from each provider's default chain (`aws sso login` / `AWS_PROFILE`, `gcloud auth application-default login`, `az login` / managed identity). No secrets in config; identifiers can still be config variables (keystore/env).
- Task: `npx hardhat kms accounts [--network x]` lists each configured key, its provider, pinned version and derived address (and checks access).
- Works on http networks and on `edr-simulated` (fork testing with the real KMS address).

## 2. Architecture

```
src/
  index.ts                     definePlugin — imports only types/constants (guideline A2)
  type-extensions.ts           augments Http/Edr NetworkUserConfig + NetworkConfig
  internal/
    config/                    zod (v3) schema rooted at HardhatUserConfig, validate + resolve hooks (pure)
    hook-handlers/{config,network}.ts
    providers/
      types.ts                 KmsProvider + KmsKeyAdapter interfaces
      registry.ts              provider id -> { lazy module import } ; adding a provider = one entry
      aws/  gcp/  azure/       adapter.ts (SDK calls, creds, version pinning) + wire.ts (pure decoding)
    crypto/                    pure functions, no SDKs:
      public-key.ts            SPKI DER/PEM + JWK -> 65-byte uncompressed, curve assertion, padding
      signature.ts             DER/compact parse (noble strict), low-S, trial recovery, self-verify
      address.ts, crc32c.ts
    signer/kms-signer.ts       provider-agnostic: memoized pubkey/address (in-flight promise), timeout via AbortSignal,
                               signDigest -> {r, s, yParity} (normalized + verified), error wrapping
    rpc/
      handler.ts               per-connection dispatcher (the flow in research 02 §6)
      accounts.ts  messages.ts (EIP-191, EIP-712)  transactions.ts (build/sign/verify)
      fill-transaction.ts      from / fees / gas / nonce / chainId — port of Hardhat's built-in handlers (MIT, attributed)
    tasks/accounts.ts
    errors.ts                  HardhatPluginError helpers (never include secrets)
    debug.ts                   createDebug("hardhat:kms:<module>")
```

Provider contract (the only thing a new KMS/HSM implements):
```ts
interface KmsKeyAdapter {
  readonly description: string;                                   // human-readable, pinned id (ARN / version name / versioned kid)
  getPublicKey(signal: AbortSignal): Promise<Uint8Array>;         // 65-byte 0x04||x||y (use crypto/public-key helpers)
  signDigest(digest: Uint8Array, signal: AbortSignal): Promise<Uint8Array | { r: bigint; s: bigint }>; // DER, compact or r/s
  close?(): Promise<void>;
}
interface KmsProvider<C> { id: string; createKey(config: C, deps: ProviderDeps): Promise<KmsKeyAdapter> }
```
Everything cryptographic (normalization, recovery, verification, hashing, tx assembly) lives once in the core — DRY; adapters only talk to their SDK and decode wire formats.

## 3. Key decisions
| Topic | Decision | Why |
|---|---|---|
| Tx building | Mirror Hardhat's `LocalAccountsHandler#getSignedTransaction` field-for-field with `micro-eth-signer` `^0.19` (Hardhat core's version), `strict=false`; legacy / 2930 / 1559 / 7702 | unsigned bytes + digest identical to Hardhat; ledger's divergences avoided |
| Fill logic | Our hook runs before built-ins, so fill from/fees/gas/nonce/chainId ourselves, honouring `gas`, `gasPrice`, `gasMultiplier`; assert `tx.chainId === eth_chainId` | viem/ethers send incomplete txs; ledger's "caller must supply gas" is a usability bug |
| EIP-712 hash | `ox` `TypedData.getSignPayload`, cross-checked in tests against micro-eth-signer 0.19 `verifyTyped` and Hardhat's vectors | micro-eth-signer 0.19 doesn't export the digest; `ox` is small, maintained (wevm), used by ccip-tools-ts |
| Signature safety | strict DER/compact parse, low-S, trial recovery that throws (never guesses), post-sign `recoverSender() === from` / recover-to-address | the recurring bug in every existing implementation |
| Concurrency | per-address `AsyncMutex` across nonce → sign → `eth_sendRawTransaction` | KMS latency widens the nonce race |
| Key pinning | Azure: resolve current version once and pin (warn if unpinned in config); GCP: version name required; AWS: warn on aliases; optional `address` pin for all | rotation silently changes the address |
| GCP integrity | `digestCrc32c`, require `verifiedDigestCrc32c`, check `signatureCrc32c` (CRC32C table impl, not zlib crc32) and `name`, bounded retries | Google's documented contract |
| Timeouts/retries | per-call timeout (default 30 s, configurable), provider SDK retries for throttling only; GCP call options override the 600 s default; never retry after broadcast | CLI must not hang |
| SDK loading | Provider SDKs are optional peer dependencies, imported only when a key of that provider is first used; missing SDK → clear `HardhatPluginError` with the install command | users install only what they use; hook factories stay light |
| Errors | `HardhatPluginError("hardhat-kms", …)`; identifiers shown, secrets never | community-plugin convention |
| Testing seam | constructor injection: the network hook module builds handlers from a `deps` object (provider registry, clock); tests pass fakes — no monkey-patching | Hardhat guideline T4 |

Open questions for reviewers: (a) `ox` vs pinning micro-eth-signer 0.14's typed-data encoder; (b) should `eth_signTransaction` be supported (Hardhat core doesn't); (c) how to expose the testing seam for integration tests with a real HRE without shipping a "fake" provider publicly.

## 4. Tests (proof pyramid)
1. **Unit (pure crypto)**: public-key parsing (SPKI DER/PEM, JWK with stripped leading zeros, wrong curve), DER strictness, high-S, wrong-key recovery must throw, CRC32C vectors, address derivation vectors.
2. **Unit (adapters)**: fake SDK clients that sign with a local key and return exact wire formats (AWS DER + SPKI, GCP PEM + DER + CRC32C incl. corrupted cases, Azure JWK + r‖s); assert request params (`MessageType: DIGEST`, `ES256K`, versioned ids).
3. **Byte-equivalence**: deterministic fake backend (RFC6979 with Hardhat's test key) → raw txs / signatures byte-identical to Hardhat's own `local-accounts.ts` test vectors (legacy, 2930, 1559, 7702, eth_sign, personal_sign, EIP-712).
4. **Integration (real HRE, `edr-simulated`)**: plugin + fake provider through the testing seam; hardhat-viem and hardhat-ethers wallet flows: deploy a contract, send each tx type, `signMessage` / `signTypedData` verified **on chain** with `ecrecover`, concurrency (N parallel sends → consecutive nonces), mixed local + KMS accounts, config validation errors (correct paths).
5. **Emulated AWS**: LocalStack (pinned image) `ECC_SECG_P256K1` key through the real `@aws-sdk/client-kms` (exercises real DER + ~50% high-S).
6. **Live** (`test:live`, opt-in via env, never in PR CI): real AWS, GCP and Azure keys on Sepolia — deploy + all tx types + message/typed-data signatures verified on chain; tx hashes recorded in `docs/live-proof.md`.
Coverage: c8 with enforced thresholds (≥ 95% lines/branches on `crypto/`, `signer/`, `rpc/`).

## 5. Quality gates (2026 toolchain, latest versions)
| Gate | Tool | When |
|---|---|---|
| Format | `oxfmt` (with import sorting) | pre-commit (staged, auto-fix), CI `--check` |
| Lint | `oxlint` type-aware (`oxlint-tsgolint`), `denyWarnings`, plugins eslint/typescript/import/jsdoc/node/promise, `reportUnusedDisableDirectives: deny` | pre-commit (staged), CI |
| Types | TypeScript 7 native `tsc --noEmit`: `strict`, `isolatedDeclarations`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` | pre-commit, CI |
| Tests | Node built-in `node --test` (native type stripping) + `c8` thresholds | pre-push (unit), CI (matrix ubuntu/macOS/windows × Node 22/24/26) |
| Package | `publint`, `@arethetypeswrong/cli`, `knip` (unused deps/exports/files) | CI |
| Commits | `commitlint` (conventional commits) via `lefthook` `commit-msg` | local |
| Hooks | `lefthook` (pre-commit: format + lint + typecheck on staged; commit-msg; pre-push: unit tests) | local |
| Releases | `changesets` → CHANGELOG + version; npm publish with provenance via GitHub OIDC trusted publishing | CI on main |
| Deps | Dependabot: npm (weekly, grouped: tooling / hardhat / cloud SDKs / crypto; security updates immediately) + github-actions (weekly); ignore zod ≥4 and micro-eth-signer ≥0.20 until Hardhat core moves (documented) | GitHub |
| Supply chain | Actions pinned by commit SHA, `zizmor` workflow audit, least-privilege `permissions:`, OpenSSF Scorecard, CodeQL | CI |

## 6. Roadmap (post-v1)
- **Turnkey provider** (TODO): parity with Foundry's `--turnkey` (`TURNKEY_API_PRIVATE_KEY`, `TURNKEY_ORGANIZATION_ID`, `TURNKEY_ADDRESS`). Deferred because live testing needs a Turnkey account (organization + API key + wallet). The v1 provider contract must already allow it: API-based signers get the optional structured-payload capabilities (`signTransaction` / `signTypedData`) so their policy engines see the full request, while the core still re-verifies every signature.
- Further candidates once v1 ships: Fireblocks-style APIs, PKCS#11 HSMs (raw r‖s fits the contract as-is). Not HashiCorp Vault transit (no secp256k1).

## 7. Docs
README (why, install, per-provider setup incl. CLI commands to create a secp256k1 key and minimal IAM/RBAC permissions, configuration reference, usage with viem / ethers / Ignition, security model, troubleshooting, how it works), `docs/adding-a-provider.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md` (changesets), TSDoc on every exported symbol and every adapter/core function.
