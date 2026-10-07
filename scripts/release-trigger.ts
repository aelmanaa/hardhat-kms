// The first step of release.yml: reads what started the run and decides the tag and the mode.
// - A push of a tag: the tag is the pushed ref, and the run is a release.
// - A manual dispatch: always a dry run. `dry-run` must be exactly `true`, and `tag` exactly
//   `none` or a `vX.Y.Z` tag.
// Each value is checked as a whole string before anything is written, so an input with a newline
// cannot add lines to GITHUB_OUTPUT. verify-release-tag.ts then checks the tag itself.
//
// Usage: node scripts/release-trigger.ts --event=E --ref-name=R --tag=T --dry-run=D --output=FILE
//   Appends `tag=` and `dry-run=` to FILE (GITHUB_OUTPUT). Exits 1, writing nothing, when an input
//   is refused. Pass each value in the `--name=value` form, so a value that starts with `--` stays
//   a value.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** A release tag: `v` and a stable version, nothing before or after it. */
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/** What started the run, as release.yml passes it. */
export interface TriggerInput {
  /** `push` or `workflow_dispatch`. */
  event: string | undefined;
  /** The pushed ref's short name, such as `v1.2.0`. */
  refName: string | undefined;
  /** The `tag` input of a dispatch. */
  inputTag: string | undefined;
  /** The `dry-run` input of a dispatch. */
  inputDryRun: string | undefined;
}

/** The tag to verify (or `none`) and whether the run publishes nothing. */
export interface Trigger {
  tag: string;
  dryRun: boolean;
}

/**
 * Decides the tag and the mode of a run.
 * @param input - The event and the inputs.
 * @returns The tag and the mode.
 * @throws When an input is refused, with what to do instead.
 */
export function readTrigger(input: TriggerInput): Trigger {
  if (input.event === "push") {
    const tag = input.refName ?? "";
    if (!RELEASE_TAG.test(tag)) {
      throw new Error(
        `${JSON.stringify(tag)} is not a vX.Y.Z release tag; only a stable version releases from main`,
      );
    }
    return { tag, dryRun: false };
  }
  if (input.event !== "workflow_dispatch") {
    throw new Error(
      `release.yml runs on a tag push or a manual dispatch, not ${String(input.event)}`,
    );
  }
  if (input.inputDryRun !== "true") {
    throw new Error(
      `dry-run is ${JSON.stringify(input.inputDryRun ?? "")}. A release starts only from a pushed signed tag; a manual dispatch runs the dry run, so set dry-run to true.`,
    );
  }
  const tag = input.inputTag ?? "";
  if (tag !== "none" && !RELEASE_TAG.test(tag)) {
    throw new Error(
      `tag ${JSON.stringify(tag)} is not none or a vX.Y.Z tag; give an existing release tag, or none to pack the dispatched branch`,
    );
  }
  return { tag, dryRun: true };
}

function main(argv: readonly string[]): void {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      event: { type: "string" },
      "ref-name": { type: "string" },
      tag: { type: "string" },
      "dry-run": { type: "string" },
      output: { type: "string" },
    },
  });
  if (values.output === undefined || values.output === "") {
    throw new Error("--output is required: the GITHUB_OUTPUT file");
  }
  const trigger = readTrigger({
    event: values.event,
    refName: values["ref-name"],
    inputTag: values.tag,
    inputDryRun: values["dry-run"],
  });
  appendFileSync(values.output, `tag=${trigger.tag}\ndry-run=${String(trigger.dryRun)}\n`);
  process.stdout.write(`tag ${trigger.tag}, ${trigger.dryRun ? "dry run" : "release"}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
