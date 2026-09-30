# Research 01 — Hardhat 3 plugin conventions

Source: `NomicFoundation/hardhat@738db95` (cloned at `~/projects/contrib-hardhat`). Paths relative to `packages/`.

## Plugin anatomy

- `HardhatPlugin` shape: `hardhat/src/types/plugins.ts:24-87` — `id`, `npmPackage`, `dependencies`, `conditionalDependencies`, `hookHandlers` (lazy `() => import(...)`, called at most once per HRE), `globalOptions`, `tasks`.
- Canonical `index.ts`: `hardhat-ledger/src/index.ts:1-18` using `definePlugin` (`hardhat/src/plugins.ts:11-25`).
- Engineering guideline A2 (`docs/engineering-guidelines.md:13-30`): `index.ts` may only import type-extensions/types/enums from `hardhat*`, `definePlugin`, constants; `export type * from "./type-extensions.js"`; `type-extensions.ts` must not export named types.
- Type extensions augment 4 interfaces in `"hardhat/types/config"`: `HttpNetworkUserConfig`, `EdrNetworkUserConfig` (optional user fields) and `HttpNetworkConfig`, `EdrNetworkConfig` (resolved). Secrets: `SensitiveString` (user) → `ResolvedConfigurationVariable` (resolved) — `network-manager/type-extensions/config.ts:79,85,212-235`.

## Config lifecycle

- Hooks: `validateUserConfig → {path, message}[]` (`types/hooks.ts:73-75,117-131`), `resolveUserConfig(userConfig, resolveConfigurationVariable, next)` (call `next` first), `validateResolvedConfig`.
- Validate with zod 3 + `@nomicfoundation/hardhat-zod-utils` (`sensitiveStringSchema`, `configurationVariableSchema`, `conditionalUnionType`, `unionType`, `validateUserConfigZodType` which requires a schema rooted at `HardhatUserConfig` for correct paths). Model: `hardhat-verify/src/internal/hook-handlers/config.ts:30-74`.
- DO NOT copy hardhat-ledger's per-network validation — it yields wrong error paths (`hardhat-ledger/test/config-validation.ts:99-103`).
- Config variables are lazy: `resolveConfigurationVariable` fetches nothing; `.get()` caches; env wins over keystore; per-HRE mutex (never resolve inside `fetchValue`). Call `.get()` only on first use, never in config hooks. Error messages never include values.
- `hre.network.create({override})` re-runs validation/resolution → hooks must be pure.

## Network hooks

- `newConnection`, `closeConnection`, `onRequest(ctx, conn, req, next)`; call `next` at most once (shared index; a second call skips built-ins).
- ORDER: community plugins' `onRequest` run BEFORE the built-in network-manager handler (plugins registered reversed, built-ins first). Built-in chain: chainId validator (http + configured chainId) → gasPrice → gas → sender → local accounts (http only). Probe: a plugin sees `eth_sendTransaction` with only `{from,to,value}`.
- Per-connection state: `WeakMap<NetworkConnection, Handler>` + `AsyncMutex` double-checked init; delete in `closeConnection` (`hardhat-ledger/src/internal/hook-handlers/network.ts:21-26,61-89,131-144`).
- Fast path: no accounts configured → `next`.
- Recursion: `provider.request` re-enters the chain from the top; pass internal methods through.
- Ledger intercepts `eth_sendTransaction`, `eth_sign`, `personal_sign`, `eth_signTypedData_v4`; rewrites send to `eth_sendRawTransaction` via `next`. `eth_accounts` = downstream result + own addresses (own only if downstream errors). Ledger does NOT handle `eth_requestAccounts` (core LocalAccountsHandler does).
- EDR vs HTTP: same wrapper; EDR only signs for its genesis accounts → external signer must send raw tx on EDR too; KMS address must be funded on EDR.

## Errors

- `HardhatError` descriptors are reserved for Nomic ranges. Community plugins throw `HardhatPluginError(pluginId, message, cause?)` from `hardhat/plugins`; CLI prints `Error in community plugin <id>: <message>`. `assertHardhatInvariant` for invariants. Short messages, quoted values, no secrets.

## Tests

- `node --import tsx/esm --test` + `@nomicfoundation/hardhat-node-test-reporter`; globs `test/*.ts`, `test/!(fixture-projects|helpers)/**/*.ts`; coverage `c8 --all`.
- Unit tests by dependency injection (no monkey-patching, guideline T4); mocks in `test/helpers/*`.
- Integration: real HRE via `createHardhatRuntimeEnvironment({plugins:[plugin], networks})`; config tests assert error codes (`assertRejectsWithHardhatError(..., CORE.GENERAL.INVALID_CONFIG, ...)`). Helpers in `hardhat-test-utils`.
- CI matrix: ubuntu/ubuntu-arm/macOS/Windows × Node 22.13/24/26.

## Packaging

- `"type":"module"`, `exports {".": "./dist/src/index.js", "./package.json"}`, `files [dist/src, src, CHANGELOG, LICENSE, README]`, `peerDependencies { hardhat: ^3 }`. No `engines` field in official packages.
- `tsc --build`; tsconfig extends `@tsconfig/node22` with `isolatedDeclarations`, `composite`, `moduleDetection: force`.
- Heavy libs: cache dynamic imports in module vars (GC3 #6). No official plugin uses optional peer deps; Hardhat checks ALL peer deps if a hook factory fails to load → keep hook factories free of SDK imports; load SDKs on first use and turn module-not-found into a `HardhatPluginError` with install instructions.

## Docs & UX

- README: Title → Installation (npm + `plugins: [...]`) → Configuring → Usage (viem + provider examples); verify adds "Advanced usage" and "How it works". Keyword `hardhat-plugin`.
- Prompts/status: `context.interruptions.displayMessage` bound with plugin id.
- Debug: `createDebug("hardhat:<plugin>:<sub>")` from `@nomicfoundation/hardhat-utils/debug`.
- Tasks: `task([...]).addFlag().setAction(() => import(...)).build()` (keystore `index.ts:19-126`).
- FS: use `hardhat-utils` fs helpers.
