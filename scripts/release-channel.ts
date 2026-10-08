// The two release channels and the rules that tell them apart. release.yml and release-next.yml
// call the same reusable workflow, release-stage.yml, and each passes its channel as a constant
// written in the workflow file; no dispatch input and no tag name chooses it.
// - stable: a plain `X.Y.Z`, tagged on `main` and staged under the `beta` dist-tag, or a hotfix
//   tagged on `release/X.Y` and staged under `release-X.Y` (verify-release-tag.ts decides which).
// - next: an `X.Y.Z-next.N` prerelease from changesets pre mode, tagged on the `next` branch,
//   staged under the `next` dist-tag. A next version never reaches `beta` or `latest`.
// release-trigger.ts, verify-release-tag.ts and check-tarballs.ts read these rules from here.
//
// Usage: node scripts/release-channel.ts CHANNEL VERSION [--output FILE]
//   Exits 0 when VERSION belongs to CHANNEL, and 1 with the reason when it does not. The release
//   workflow runs it on a dry run without a tag, where no tag check reads the version, and
//   `--output` appends the channel's `dist-tag=` to FILE (GITHUB_OUTPUT) when the version passes.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** A release channel: the stable line or the prerelease line of a future major. */
export type Channel = "stable" | "next";

/** What a channel accepts and where it publishes. */
export interface ChannelRules {
  /** A whole version of the channel, without the `v`. */
  version: RegExp;
  /** The shape of that version, for messages. */
  shape: string;
  /** The dist-tag the workflow stages a commit of {@link ChannelRules.branch} under. */
  distTag: string;
  /** The branch whose history must contain the tagged commit; a stable hotfix may be on
   * `release/X.Y` instead. */
  branch: string;
  /** The workflow that releases the channel, for messages. */
  workflow: string;
}

/** The rules of each channel. */
export const CHANNELS: Readonly<Record<Channel, ChannelRules>> = {
  stable: {
    version: /^\d+\.\d+\.\d+$/,
    shape: "X.Y.Z",
    distTag: "beta",
    branch: "main",
    workflow: "release.yml",
  },
  next: {
    version: /^\d+\.\d+\.\d+-next\.\d+$/,
    shape: "X.Y.Z-next.N",
    distTag: "next",
    branch: "next",
    workflow: "release-next.yml",
  },
};

/**
 * Reads a channel name as one whole string.
 * @param value - The name, as the workflow passes it.
 * @returns The channel.
 * @throws When the value is not `stable` or `next`.
 */
export function parseChannel(value: string | undefined): Channel {
  if (value === "stable" || value === "next") {
    return value;
  }
  throw new Error(`channel ${JSON.stringify(value ?? "")} is not stable or next`);
}

/**
 * Whether a release tag names a version of the channel: `v` and the version, nothing else.
 * @param channel - The channel.
 * @param tag - The tag name.
 * @returns True when the tag is `v` followed by a whole version of the channel.
 */
export function isChannelTag(channel: Channel, tag: string): boolean {
  return tag.startsWith("v") && CHANNELS[channel].version.test(tag.slice(1));
}

/**
 * Why a version does not belong to a channel.
 * @param channel - The channel.
 * @param version - The version, without the `v`.
 * @returns The one-line reason, or undefined when the version belongs to the channel.
 */
export function versionFailure(channel: Channel, version: string): string | undefined {
  if (CHANNELS[channel].version.test(version)) {
    return undefined;
  }
  if (channel === "stable") {
    return `version ${version} is not a stable X.Y.Z version; only stable versions are released`;
  }
  return `version ${version} is not an X.Y.Z-next.N version; release-next.yml stages only the next prereleases of the next branch`;
}

function main(argv: readonly string[]): void {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { output: { type: "string" } },
  });
  const [name, version] = positionals;
  if (version === undefined || positionals.length !== 2) {
    throw new Error("usage: node scripts/release-channel.ts stable|next VERSION [--output FILE]");
  }
  const channel = parseChannel(name);
  const reason = versionFailure(channel, version);
  if (reason !== undefined) {
    throw new Error(reason);
  }
  const { distTag } = CHANNELS[channel];
  process.stdout.write(`${version} belongs to the ${channel} channel, staged under ${distTag}\n`);
  if (values.output !== undefined) {
    appendFileSync(values.output, `dist-tag=${distTag}\n`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
