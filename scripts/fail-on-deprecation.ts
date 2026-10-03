// Preloaded into every Node process on the Node 26 leg of the CI test job, with
// `NODE_OPTIONS=--import <absolute path of this file>`: a DeprecationWarning that ALLOWED_WARNINGS
// in scripts/deprecation-hook.ts does not list makes the process exit with code 1. Child processes
// inherit NODE_OPTIONS, so the processes `node --test` starts for each test file and the CLI tests'
// Hardhat processes are covered too.
//
// To run it locally: NODE_OPTIONS="--import $PWD/scripts/fail-on-deprecation.ts" pnpm test
import process from "node:process";

import { failOnDeprecation } from "./deprecation-hook.ts";

failOnDeprecation(process);
