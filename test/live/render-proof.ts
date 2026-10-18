// Renders docs/live-proof.md from test/live/proof.json, which a Sepolia run of the live suite
// writes. Refuses a proof that lacks a transaction for any live cell of a provider it lists. The
// Turnkey line takes the date and commit of test/live/turnkey-smoke.json, which a passing run of
// `pnpm run test:live:turnkey` writes; without that file it says no run has passed yet.
//
// Usage: pnpm run docs:live-proof
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseProof, proofProblems, renderProof } from "./helpers/proof.ts";
import { parseTurnkeySmoke, TURNKEY_SMOKE_FILE } from "./helpers/turnkey-smoke.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const proof = parseProof(readFileSync(path.join(root, "test/live/proof.json"), "utf8"));
const problems = proofProblems(proof);
if (problems.length > 0) {
  process.stderr.write(
    `test/live/proof.json is incomplete:\n${problems.map((item) => `- ${item}\n`).join("")}`,
  );
  process.exit(1);
}
const smokeFile = path.join(root, TURNKEY_SMOKE_FILE);
const turnkey = existsSync(smokeFile)
  ? parseTurnkeySmoke(readFileSync(smokeFile, "utf8"))
  : undefined;
writeFileSync(path.join(root, "docs/live-proof.md"), renderProof(proof, turnkey));
process.stdout.write("wrote docs/live-proof.md\n");
