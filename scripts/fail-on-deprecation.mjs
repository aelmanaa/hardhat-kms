// Preloaded on the Node 26 leg of the CI test job with
// `NODE_OPTIONS=--import <absolute path of this file>`: a DeprecationWarning that ALLOWED_WARNINGS
// in scripts/deprecation-hook.ts does not list makes the process exit with code 1. Every Node
// process that inherits NODE_OPTIONS loads it: pnpm, the processes `node --test` starts for each
// test file, and the Hardhat CLI processes of the CLI tests (test/helpers/hardhat-cli.ts drops
// only `--import tsx`). Worker threads do not: see docs/contributor/tooling.md.
//
// This file is JavaScript on purpose. tsx's `register()`, which Hardhat calls to load a TypeScript
// config, falls back to the deprecated `module.register()` (DEP0205) when NODE_OPTIONS imports a
// TypeScript file (`hasTypeScriptPreloadedImport` in tsx's src/esm/api/register.ts), so a `.ts`
// preload would cause the very warning it reports. Node 26 strips the types of the module it imports.
//
// To run it locally on Node 26: NODE_OPTIONS="--import $PWD/scripts/fail-on-deprecation.mjs" pnpm test
import process from "node:process";

import { failOnDeprecation } from "./deprecation-hook.ts";

failOnDeprecation(process);
