// The first step of pages.yml: picks the release tag the docs site root is built from, `vX.Y.Z`
// for the version on npm `latest` of hardhat-kms (decision 0024). The value from the registry only
// chooses which existing tag is built; anything but a stable `X.Y.Z` is refused, so a prerelease,
// a placeholder or npm's error never reaches the checkout, and nothing deploys. The workflow then
// checks that the tag exists before it checks it out.
//
// Usage: node scripts/site-release-tag.ts --output=<GITHUB_OUTPUT file>
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { unwrapNpmView } from "./npm-view.ts";

/** The package whose `latest` the site root documents: the core, which every release carries. */
export const SITE_PACKAGE = "hardhat-kms";

/**
 * The release tag for the output of `npm view hardhat-kms dist-tags --json`.
 *
 * @param json - npm's output: the dist-tags object, or a one-element array holding it (npm 12).
 * @returns `v` and the version on `latest`.
 * @throws When the output is not a dist-tags object, or `latest` is not a stable `X.Y.Z`.
 */
export function siteReleaseTag(json: string): string {
  const command = `npm view ${SITE_PACKAGE} dist-tags`;
  const parsed = unwrapNpmView(command, JSON.parse(json));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || "error" in parsed) {
    throw new Error(`${command} printed ${JSON.stringify(parsed)}, not a dist-tags object`);
  }
  const latest: unknown = Reflect.get(parsed, "latest");
  if (typeof latest !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(latest)) {
    throw new Error(
      `latest of ${SITE_PACKAGE} is ${JSON.stringify(latest)}, not a stable X.Y.Z; the site root is built only from a release`,
    );
  }
  return `v${latest}`;
}

function main(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { output: { type: "string" } } });
  if (values.output === undefined || values.output === "") {
    throw new Error("--output is required: the GITHUB_OUTPUT file");
  }
  const tag = siteReleaseTag(
    execFileSync("npm", ["view", SITE_PACKAGE, "dist-tags", "--json"], { encoding: "utf8" }),
  );
  appendFileSync(values.output, `tag=${tag}\n`);
  process.stdout.write(`the site root documents ${tag}, the version on npm latest\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
