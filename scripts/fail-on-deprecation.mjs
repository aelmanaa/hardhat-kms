// Preloaded on the Node 26 leg of the CI test job with
// `NODE_OPTIONS=--import <absolute path of this file>`: a DeprecationWarning that ALLOWED_WARNINGS
// in scripts/deprecation-hook.ts does not list makes the process fail. Every Node process that
// inherits NODE_OPTIONS loads it: pnpm, the processes `node --test` starts for each test file, the
// fixture processes those tests start, and the Hardhat CLI processes of the CLI tests (`hardhatEnv`
// in packages/hardhat-kms/test/helpers/hardhat-cli.ts drops only `--import tsx`). Worker threads
// do not: see docs/contributor/tooling.md.
//
// This file is JavaScript on purpose. Hardhat's CLI calls tsx's `register()` on every run, and tsx
// falls back to the deprecated `module.register()` (DEP0205) when NODE_OPTIONS imports a TypeScript
// file (`hasTypeScriptPreloadedImport` in tsx's src/esm/api/register.ts), so a `.ts` preload would
// cause the very warning it reports. tsx looks only at the files NODE_OPTIONS names, so this file
// can still import deprecation-hook.ts, whose types Node 26 strips.
//
// To run it locally on Node 26: NODE_OPTIONS="--import $PWD/scripts/fail-on-deprecation.mjs" pnpm test
import process from "node:process";

import { failOnDeprecation } from "./deprecation-hook.ts";

failOnDeprecation(process);
