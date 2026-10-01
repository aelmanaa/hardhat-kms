// Renders docs/live-proof.md from test/live/proof.json, which a Sepolia run of the live suite
// writes. Refuses a proof that lacks a transaction for any live cell of a provider it lists.
//
// Usage: pnpm run docs:live-proof
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseProof, proofProblems, renderProof } from "./helpers/proof.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const proof = parseProof(readFileSync(path.join(root, "test/live/proof.json"), "utf8"));
const problems = proofProblems(proof);
if (problems.length > 0) {
  process.stderr.write(
    `test/live/proof.json is incomplete:\n${problems.map((item) => `- ${item}\n`).join("")}`,
  );
  process.exit(1);
}
writeFileSync(path.join(root, "docs/live-proof.md"), renderProof(proof));
process.stdout.write("wrote docs/live-proof.md\n");
