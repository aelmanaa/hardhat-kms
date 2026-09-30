# Design review round 1 — toolchain & test strategy

[V] = verified by running; [B] = belief/docs. Experiments in the session scratchpad `tool-review/`.

## BLOCKER

1. **Native .ts tests fail on Node 22.13.0 [V]** (`ERR_UNKNOWN_FILE_EXTENSION`); work unflagged on 22.23.3 / 24.16. Hardhat CI tests the exact floors (22.13.0, 24.0.0, 26.0.0; macOS/Windows on the floor only). Fix: native stripping everywhere except the 22.13.0 leg (`node --import tsx --test`).
2. **Optional peer deps mislead errors.** `detect-plugin-npm-dependency-problems.ts` checks every `peerDependencies` entry and ignores `peerDependenciesMeta`; runs on any hook/task import failure → AWS-only users would see `PLUGIN_MISSING_DEPENDENCY @google-cloud/kms`. Fix: peer = `hardhat` only; cloud SDKs in devDependencies + documented per-provider install; runtime `import()` → `HardhatPluginError` with install command (+ optional semver check).
3. **tsconfig for native TS:** `.ts` relative specifiers + `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` (tsc 7 rewrites to `.js` in JS output; `.d.ts` keeps `./x.ts` but attw/publint are green) [V].

## SHOULD

4. **No TS6 alias needed [V]:** attw bundles its own TS, knip uses oxc-parser, tsgolint is a Go binary, tsx uses esbuild; TS 7.0.2 root export only `version`. Only TypeDoc (peer ts ≤6) / Stryker typescript-checker need it (`npm:@typescript/typescript6@6.0.2`, bin `tsc6`). ccip-tools-ts added it for TypeDoc (commit 0802dd4b).
5. `noEmitOnError: true` — TS7 `tsc -b` emitted with type errors [V]. TS7 supports isolatedDeclarations, erasableSyntaxOnly, composite, -b, verbatimModuleSyntax, exactOptionalPropertyTypes, declaration maps [V].
6. **JSDoc enforcement:** oxlint native jsdoc has no `require-jsdoc`; use `jsPlugins: eslint-plugin-jsdoc` with `enableFixer:false` (fixer inserted empty `/** */`) + `jsdoc/no-blank-blocks` [V].
7. commitlint redundant with changesets → one-line regex `commit-msg` check [V].
8. oxfmt pre-1.0 (0.71, 73 releases/12 mo) → pin exact; group oxfmt/oxlint/tsgolint in Dependabot.
9. **LocalStack [V]:** 2026.3.0 needs a token (bypass ended 2026-04-06 [B]); `4.14.0` (last 4.x) works tokenless — pin `localstack/localstack:4.14.0@sha256:3ebc37595918b8accb852f8048fef2aff047d465167edd655528065b07bc364a`; 40/40 verified, 21/40 high-S. Ubuntu only; random host port.
10. Coverage: native TS maps exactly with c8 12; tsx under-reports [V]. Coverage on Node 24 native; exclude types/type-extensions.
11. Test gaps: fast-check properties (DER high/low-S normalize+recover; random bytes never parse; JWK/SPKI zero-stripping round-trip); differential vs viem `signTransaction` / ethers `Wallet.signTransaction`; negatives (wrong-key adapter, pin mismatch, AbortSignal via injected clock, bounded GCP CRC retries, no retry after send, no credentials in error messages); Stryker 10 + tap-runner on crypto/signer nightly only [B].
12. Integration stability [B]: node:test isolates files; fresh `network.connect()` per test; `concurrency:false` within HRE files; `.gitattributes eol=lf`, quoted globs, `path.join` for Windows.

## NICE

13. `"engines":{"node":">=22.13.0"}`; skip `sideEffects`.
14. Supply chain: SHA-pinned actions, zizmor, least-privilege permissions, Dependabot github-actions; CodeQL default setup (repo settings); Scorecard optional.
15. changesets 3 (human-written entries) — don't also run release-please.

## Recommended toolchain

devDependencies: typescript 7.0.2, oxlint 1.86.0, oxlint-tsgolint 7.0.2003, oxfmt 0.71.0 (exact), eslint-plugin-jsdoc 65.0.0, c8 12.0.0, tsx 4.23.15 (floor leg), fast-check 4.10.2, @types/node ^22, hardhat 3.18.0, cloud SDKs, publint 0.3.24, @arethetypeswrong/cli 0.18.5, knip 6.38.0, lefthook 2.1.15, @changesets/cli 3.0.3, @changesets/changelog-github 1.0.1.
dependencies: @nomicfoundation/hardhat-errors, hardhat-utils, hardhat-zod-utils, zod ^3.23.8, micro-eth-signer ^0.19, @noble/curves. peerDependencies: hardhat ^3 only.
CI: lint; test matrix ubuntu × {22.13.0 (tsx), 24.0.0, 26.0.0} + macOS/Windows on 22.13.0; coverage (Node 24, ≥95%); package (publint, attw `--profile esm-only`, knip); localstack (ubuntu, digest-pinned); zizmor; release (changesets/action, Node 24 for npm ≥11 OIDC trusted publishing, `id-token: write`, no NPM_TOKEN); live (workflow_dispatch, protected environment).
Config snippets (package.json, tsconfig, .oxlintrc.json, lefthook.yml, dependabot.yml) are reproduced in docs/DESIGN.md §5.
