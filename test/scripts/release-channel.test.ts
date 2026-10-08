// The release channels of `scripts/release-channel.ts`: which versions and tags each accepts, the
// dist-tag and branch each names, and the command the release workflow runs on a dry run without
// a tag. Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHANNELS,
  isChannelTag,
  parseChannel,
  versionFailure,
} from "../../scripts/release-channel.ts";

const SCRIPT = fileURLToPath(new URL("../../scripts/release-channel.ts", import.meta.url));

const STABLE = ["0.9.0", "1.2.3", "10.20.30"];
const NEXT = ["2.0.0-next.0", "2.0.0-next.12", "3.1.0-next.4"];
const NEITHER = [
  "",
  "1.2",
  "v1.2.3",
  "1.2.3-rc.1",
  "1.2.3+build.7",
  "2.0.0-beta.0",
  "2.0.0-next",
  "2.0.0-next.",
  "2.0.0-next.0.1",
  "2.0.0-next.0+build",
  "2.0.0-next.x",
  "2.0.0-NEXT.0",
  "2.0.0-next.0\n",
  " 2.0.0-next.0",
];

describe("CHANNELS", () => {
  it("stages stable under beta from main and next under next from next", () => {
    assert.equal(CHANNELS.stable.distTag, "beta");
    assert.equal(CHANNELS.stable.branch, "main");
    assert.equal(CHANNELS.next.distTag, "next");
    assert.equal(CHANNELS.next.branch, "next");
  });

  it("keeps the stable rule equal to the default of check-tarballs.ts at older tags", () => {
    // release-stage.yml passes no --channel on stable, because a hotfix tag cut from v0.9.0 runs
    // that commit's check-tarballs.ts, which has no such option and checks /^\d+\.\d+\.\d+$/.
    assert.equal(CHANNELS.stable.version.source, String.raw`^\d+\.\d+\.\d+$`);
    assert.equal(CHANNELS.stable.version.flags, "");
  });

  it("never stages either channel under latest", () => {
    for (const channel of Object.values(CHANNELS)) {
      assert.notEqual(channel.distTag, "latest");
    }
  });
});

describe("versionFailure", () => {
  it("accepts only X.Y.Z on stable, with the message verify-release-tag.ts gives", () => {
    for (const version of STABLE) {
      assert.equal(versionFailure("stable", version), undefined, version);
    }
    for (const version of [...NEXT, ...NEITHER]) {
      assert.equal(
        versionFailure("stable", version),
        `version ${version} is not a stable X.Y.Z version; only stable versions are released`,
        JSON.stringify(version),
      );
    }
  });

  it("accepts only X.Y.Z-next.N on next", () => {
    for (const version of NEXT) {
      assert.equal(versionFailure("next", version), undefined, version);
    }
    for (const version of [...STABLE, ...NEITHER]) {
      assert.equal(
        versionFailure("next", version),
        `version ${version} is not an X.Y.Z-next.N version; release-next.yml stages only the next prereleases of the next branch`,
        JSON.stringify(version),
      );
    }
  });
});

describe("isChannelTag", () => {
  it("takes v and a whole version of the channel", () => {
    assert.equal(isChannelTag("stable", "v1.2.3"), true);
    assert.equal(isChannelTag("stable", "v2.0.0-next.0"), false);
    assert.equal(isChannelTag("next", "v2.0.0-next.0"), true);
    assert.equal(isChannelTag("next", "v1.2.3"), false);
    for (const tag of ["1.2.3", "2.0.0-next.0", "vv2.0.0-next.0", "v2.0.0-next.0\nx", ""]) {
      assert.equal(isChannelTag("stable", tag), false, JSON.stringify(tag));
      assert.equal(isChannelTag("next", tag), false, JSON.stringify(tag));
    }
  });
});

describe("parseChannel", () => {
  it("reads stable and next and refuses anything else", () => {
    assert.equal(parseChannel("stable"), "stable");
    assert.equal(parseChannel("next"), "next");
    for (const value of ["beta", "latest", "Next", "next\n", " stable", "", undefined]) {
      assert.throws(() => parseChannel(value), { message: /is not stable or next$/ });
    }
  });
});

/**
 * Runs the script as the release workflow does. Node 24.0.0 may print an ExperimentalWarning for
 * the type stripping first, so the stderr checks match a line, not the start of the output.
 */
const run = (args: readonly string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

describe("release-channel.ts as the workflow runs it", () => {
  it("exits 0 for a version of the channel", () => {
    const result = run(["next", "2.0.0-next.0"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "2.0.0-next.0 belongs to the next channel, staged under next\n");
  });

  it("appends the channel's dist-tag with --output, and nothing for a refused version", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "release-channel-test-"));
    try {
      const output = path.join(directory, "github-output");
      writeFileSync(output, "");
      assert.equal(run(["stable", "1.2.3", "--output", output]).status, 0);
      assert.equal(run(["next", "2.0.0-next.0", "--output", output]).status, 0);
      assert.equal(run(["next", "1.2.3", "--output", output]).status, 1);
      assert.equal(readFileSync(output, "utf8"), "dist-tag=beta\ndist-tag=next\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exits 1 with the reason for a version of the other channel", () => {
    const next = run(["next", "1.2.3"]);
    assert.equal(next.status, 1);
    assert.match(next.stderr, /^::error::version 1\.2\.3 is not an X\.Y\.Z-next\.N version/m);
    const stable = run(["stable", "2.0.0-next.0"]);
    assert.equal(stable.status, 1);
    assert.match(stable.stderr, /^::error::version 2\.0\.0-next\.0 is not a stable X\.Y\.Z/m);
  });

  it("exits 1 for a bad channel or a wrong argument count", () => {
    assert.equal(run(["beta", "1.2.3"]).status, 1);
    assert.equal(run(["next"]).status, 1);
    assert.equal(run(["next", "2.0.0-next.0", "extra"]).status, 1);
  });
});
