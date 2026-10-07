// Loads Hardhat config files the way `npx hardhat` does, for the snippet checks of
// `scripts/doc-snippets.ts`: Hardhat's `importUserConfig` imports the file, then
// `createHardhatRuntimeEnvironment` runs every plugin's config validation and resolution. Nothing
// connects to a network or calls a KMS: configuration variables are resolved lazily, and no task
// runs.
//
// Usage: node scripts/load-config-snippets.ts <results.json> <config.ts>...
// Writes a JSON array to <results.json> with one entry per config, in order: `null` when the config
// loads, or the error message. A file, not stdout, so a config that prints cannot corrupt it.
//
// It runs in its own process, so each check starts with a fresh module cache and the environment
// that `doc-snippets.ts` prepared, with a placeholder for every configuration variable.
import { writeFileSync } from "node:fs";
import path from "node:path";

import { createHardhatRuntimeEnvironment, importUserConfig } from "hardhat/hre";

const [resultsFile, ...files] = process.argv.slice(2);
if (resultsFile === undefined) {
  throw new Error("usage: node scripts/load-config-snippets.ts <results.json> <config.ts>...");
}
const results: (string | null)[] = [];
for (const file of files) {
  try {
    const config = await importUserConfig(file);
    await createHardhatRuntimeEnvironment(config, { config: file }, path.dirname(file));
    results.push(null);
  } catch (error) {
    results.push(error instanceof Error ? error.message : String(error));
  }
}
writeFileSync(resultsFile, JSON.stringify(results));
