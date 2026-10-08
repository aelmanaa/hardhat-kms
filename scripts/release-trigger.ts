// The first step of release-stage.yml, the jobs release.yml and release-next.yml share: reads what
// started the run and decides the tag and the mode.
// - The channel is the constant the calling workflow passes: `stable` for release.yml, `next` for
//   release-next.yml (scripts/release-channel.ts).
// - A push of a tag: the tag is the pushed ref, a `vX.Y.Z` tag for stable or a `vX.Y.Z-next.N`
//   tag for next, and the run is a release.
// - A manual dispatch: always a dry run. `dry-run` must be exactly `true`, and `tag` exactly
//   `none` or a tag of the channel.
// Each value is checked as a whole string before anything is written, so an input with a newline
// cannot add lines to GITHUB_OUTPUT. verify-release-tag.ts then checks the tag itself.
//
// Usage: node scripts/release-trigger.ts --channel=C --event=E --ref-name=R --tag=T --dry-run=D
//          --output=FILE
//   Appends `tag=` and `dry-run=` to FILE (GITHUB_OUTPUT). Exits 1, writing nothing, when an
//   input is refused. verify-release-tag.ts, or release-channel.ts on a dry run without a tag,
//   writes the dist-tag. Pass each value in the `--name=value` form, so a value that starts
//   with `--` stays a value.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { CHANNELS, type Channel, isChannelTag, parseChannel } from "./release-channel.ts";

/** What started the run, as release-stage.yml passes it. */
export interface TriggerInput {
  /** The channel the calling workflow names. */
  channel: Channel;
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

/** The reason a tag is refused, with what the channel accepts. */
function tagMessage(channel: Channel, tag: string): string {
  if (channel === "stable") {
    return `${JSON.stringify(tag)} is not a vX.Y.Z release tag; only a stable version releases from main`;
  }
  return `${JSON.stringify(tag)} is not a vX.Y.Z-next.N release tag; release-next.yml stages only next prereleases`;
}

/**
 * Decides the tag and the mode of a run.
 * @param input - The event and the inputs.
 * @returns The tag and the mode.
 * @throws When an input is refused, with what to do instead.
 */
export function readTrigger(input: TriggerInput): Trigger {
  const { channel } = input;
  const { shape, workflow } = CHANNELS[channel];
  if (input.event === "push") {
    const tag = input.refName ?? "";
    if (!isChannelTag(channel, tag)) {
      throw new Error(tagMessage(channel, tag));
    }
    return { tag, dryRun: false };
  }
  if (input.event !== "workflow_dispatch") {
    throw new Error(
      `${workflow} runs on a tag push or a manual dispatch, not ${String(input.event)}`,
    );
  }
  if (input.inputDryRun !== "true") {
    throw new Error(
      `dry-run is ${JSON.stringify(input.inputDryRun ?? "")}. A release starts only from a pushed signed tag; a manual dispatch runs the dry run, so set dry-run to true.`,
    );
  }
  const tag = input.inputTag ?? "";
  if (tag !== "none" && !isChannelTag(channel, tag)) {
    throw new Error(
      `tag ${JSON.stringify(tag)} is not none or a v${shape} tag; give an existing release tag, or none to pack the dispatched branch`,
    );
  }
  return { tag, dryRun: true };
}

function main(argv: readonly string[]): void {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      channel: { type: "string" },
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
    channel: parseChannel(values.channel),
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
