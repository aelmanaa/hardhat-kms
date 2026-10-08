// The proof check of promote.yml: for a `live-run` of `sepolia:<commit>`, reads
// test/live/proof.json at that commit and checks it against tag v<version> (checkReleaseProof in
// helpers/release-proof.ts). Any other live-run value has no proof to check. Runs in the clone in
// the current directory, prints what it checked, and appends it to --summary when given
// (GITHUB_STEP_SUMMARY).
//
// Usage: node test/live/check-release-proof.ts <version> <sepolia:<commit>|fork|none>
//   [--summary FILE]
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { parseLiveRun } from "../../scripts/registry-release.ts";
import { checkReleaseProof } from "./helpers/release-proof.ts";

const usage =
  "usage: node test/live/check-release-proof.ts <version> <sepolia:<commit>|fork|none> [--summary FILE]";

try {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { summary: { type: "string" } },
  });
  const [version, liveRun] = positionals;
  if (version === undefined || liveRun === undefined || positionals.length !== 2) {
    throw new Error(usage);
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error(`version must be an exact X.Y.Z, not ${JSON.stringify(version)}`);
  }
  const parsed = parseLiveRun(liveRun);
  let line: string;
  if (parsed.kind === "sepolia") {
    const found = checkReleaseProof(process.cwd(), version, parsed.commit);
    const providers = found.proof.providers
      .map((provider) => `${provider.provider} ${provider.records.length} records`)
      .join(", ");
    line = `test/live/proof.json at ${found.proofCommit} (on origin/${found.branch}) tested commit ${found.proof.commit}, the commit of tag v${version} (${found.tagCommit}), on chain ${found.proof.chainId}: ${providers}, every live cell covered and every record as its case expects.`;
  } else {
    line = `live-run ${parsed.kind}: no Sepolia proof to check.`;
  }
  if (values.summary !== undefined) {
    appendFileSync(values.summary, `Sepolia proof: ${line}\n\n`);
  }
  process.stdout.write(`${line}\n`);
} catch (error) {
  process.stderr.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
