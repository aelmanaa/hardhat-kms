// Parsing of `npm view ... --json` output that holds for npm 11 and npm 12. npm 11 prints the
// value itself, and npm 12 wraps it in a one-element array.
// Used by scripts/registry-release.ts and scripts/test-hardhat-versions.ts.

/**
 * Unwraps the parsed `--json` output of `npm view`. npm 11 prints the value itself, and npm 12
 * wraps it in a one-element array: `[{"beta":"1.0.0"}]` for `npm view <package> dist-tags --json`,
 * `["<commit>"]` for `npm view <package>@<version> --json gitHead`. promote.yml inlines the same
 * rule in its dist-tag move; change the two together.
 *
 * @param command - The command that printed the output, for the error message.
 * @param parsed - The parsed output.
 * @returns The value, or the only element of a one-element array.
 */
export function unwrapNpmView(command: string, parsed: unknown): unknown {
  if (!Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed.length !== 1) {
    throw new Error(
      `${command} printed an array of ${parsed.length} entries; expected one value or a one-element array`,
    );
  }
  return parsed[0];
}

/**
 * Parses the output of `npm view <package> time --json`.
 *
 * @param name - The package the output is for.
 * @param json - npm's output.
 * @returns Each version, and `created` and `modified`, with its ISO publish time.
 */
export function parsePublishTimes(name: string, json: string): Record<string, string> {
  const command = `npm view ${name} time`;
  const parsed = unwrapNpmView(command, JSON.parse(json));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${command} printed ${JSON.stringify(parsed)}, not an object of publish times`);
  }
  if ("error" in parsed) {
    throw new Error(`${command} failed: ${JSON.stringify(parsed.error)}`);
  }
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
