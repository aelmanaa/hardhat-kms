// The live rule of promote.yml: reads the `version`, `target` and `live-run` inputs and refuses a
// combination the rule forbids (checkLiveRule in scripts/registry-release.ts). Prints the rule line
// it applied, and appends it to --summary when given (GITHUB_STEP_SUMMARY).
//
// Usage: node scripts/check-live-rule.ts <version> <verify|latest> <sepolia:<commit>|fork|none>
//   [--summary FILE]
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { checkLiveRule, parseLiveRun } from "./registry-release.ts";

const usage =
  "usage: node scripts/check-live-rule.ts <version> <verify|latest> <sepolia:<commit>|fork|none> [--summary FILE]";

try {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { summary: { type: "string" } },
  });
  const [version, target, liveRun] = positionals;
  if (version === undefined || liveRun === undefined || positionals.length !== 3) {
    throw new Error(usage);
  }
  if (target !== "verify" && target !== "latest") {
    throw new Error(`target must be verify or latest, not ${String(target)}`);
  }
  const line = checkLiveRule(version, target, parseLiveRun(liveRun));
  if (values.summary !== undefined) {
    appendFileSync(values.summary, `Live rule: ${line}\n\n`);
  }
  process.stdout.write(`${line}\n`);
} catch (error) {
  process.stderr.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
