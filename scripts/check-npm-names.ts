// Checks that every published package already exists on npm, before release-stage.yml stages any
// of them. A trusted-publisher configuration lives in a package's settings on npmjs.com, and
// `npm trust` refuses a package that does not exist yet, so a brand-new package name cannot have
// one: its stage over OIDC would fail, and it would fail after the packages before it in the list
// were already staged. This check stops the run first and names the package.
// docs/contributor/releasing.md, First publish of a new package, has the owner's steps.
//
// It cannot see whether the trusted publisher of an existing package is set up or has expired:
// npm shows that only to a signed-in maintainer. A missing or expired configuration fails the
// `npm stage publish` of that package, and the publish job names it.
//
// Usage: node scripts/check-npm-names.ts [--warn]
//   Exits 1 when a package is missing from the registry, or with --warn (the dry run) prints a
//   warning annotation and exits 0. An npm error other than E404 always exits 1. No token is read.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { unwrapNpmView } from "./npm-view.ts";
import { PACKAGES } from "./release-packages.ts";

/** What `npm view <name> name --json` returned. */
export interface NameView {
  status: number | null;
  stdout: string;
}

/** Whether a package exists on the registry. */
export type NameState = "published" | "missing";

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/**
 * Reads the output of `npm view <name> name --json`. npm 11 prints the name, npm 12 a one-element
 * array holding it; for a package the registry does not have, both print an `E404` error object
 * and exit 1.
 *
 * @param name - The package asked about.
 * @param view - The exit status and standard output of the command.
 * @returns `published` or `missing`.
 * @throws On any other output or error, such as a network failure.
 */
export function parseNameView(name: string, view: NameView): NameState {
  const command = `npm view ${name} name`;
  let parsed: unknown;
  try {
    parsed = unwrapNpmView(command, JSON.parse(view.stdout));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new Error(`${command} exited ${String(view.status)} and printed no JSON`, {
        cause: error,
      });
    }
    throw error;
  }
  if (view.status === 0 && parsed === name) {
    return "published";
  }
  const code = field(field(parsed, "error"), "code");
  if (view.status !== 0 && code === "E404") {
    return "missing";
  }
  throw new Error(`${command} exited ${String(view.status)} and printed ${JSON.stringify(parsed)}`);
}

/**
 * The message for the packages npm does not have yet.
 *
 * @param missing - Their names.
 * @returns One line, naming each package and the owner's steps.
 */
export function missingMessage(missing: readonly string[]): string {
  const names = missing.join(", ");
  return `${names} ${missing.length === 1 ? "does" : "do"} not exist on npm yet, so ${missing.length === 1 ? "it has" : "they have"} no trusted publisher and cannot be staged over OIDC. The owner publishes the name once and sets up its trusted publishers first: docs/contributor/releasing.md, First publish of a new package.`;
}

function main(argv: readonly string[]): void {
  const { values } = parseArgs({
    args: [...argv],
    options: { warn: { type: "boolean" } },
    strict: true,
  });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const missing: string[] = [];
  for (const name of PACKAGES) {
    const result = spawnSync(npm, ["view", name, "name", "--json"], {
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const state = parseNameView(name, { status: result.status, stdout: result.stdout });
    process.stdout.write(`${state === "published" ? "ok  " : "MISSING"} ${name}\n`);
    if (state === "missing") {
      missing.push(name);
    }
  }
  if (missing.length === 0) {
    process.stdout.write(`all ${PACKAGES.length} packages exist on npm\n`);
    return;
  }
  const message = missingMessage(missing);
  if (values.warn === true) {
    process.stdout.write(`::warning::${message} A release run stops here.\n`);
    return;
  }
  process.stdout.write(`::error::${message}\n`);
  process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
