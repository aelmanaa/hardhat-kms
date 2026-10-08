// The shape of the release workflows: release.yml and release-next.yml call release-stage.yml with
// a fixed channel and the tag patterns that keep the two apart, and every job of release-stage.yml
// that checks out only some scripts checks out each script it runs and every script those import.
// Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOWS = path.join(ROOT, ".github/workflows");

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

function readWorkflow(name: string): unknown {
  return parse(readFileSync(path.join(WORKFLOWS, name), "utf8"));
}

/** The `jobs` of a workflow as name and job pairs. */
function jobsOf(workflow: unknown): [string, unknown][] {
  const jobs = field(workflow, "jobs");
  return typeof jobs === "object" && jobs !== null ? Object.entries(jobs) : [];
}

/** The scripts a file imports with `from "./x.ts"`, and theirs, as `scripts/...` paths. */
function importClosure(script: string, seen = new Set<string>()): Set<string> {
  if (seen.has(script)) {
    return seen;
  }
  seen.add(script);
  const text = readFileSync(path.join(ROOT, script), "utf8");
  for (const match of text.matchAll(/from "\.\/([^"]+\.ts)"/g)) {
    importClosure(`scripts/${match[1] ?? ""}`, seen);
  }
  return seen;
}

/** A tag filter of GitHub Actions: `*` matches any run of characters but `/`, `[0-9]` one digit. */
function matchesFilter(pattern: string, tag: string): boolean {
  const source = pattern
    .replaceAll(/[.+?^${}()|\\]/g, String.raw`\$&`)
    .replaceAll("*", "[^/]*")
    .replaceAll(String.raw`\[0-9\]`, "[0-9]");
  return new RegExp(`^${source}$`).test(tag);
}

/** Whether a push of `tag` starts the workflow, with `!` patterns excluding. */
function startsOn(workflow: unknown, tag: string): boolean {
  const tags = field(field(field(workflow, "on"), "push"), "tags");
  assert.ok(Array.isArray(tags));
  let started = false;
  for (const pattern of tags) {
    assert.equal(typeof pattern, "string");
    const text = String(pattern);
    if (text.startsWith("!")) {
      if (matchesFilter(text.slice(1), tag)) {
        started = false;
      }
    } else if (matchesFilter(text, tag)) {
      started = true;
    }
  }
  return started;
}

/** The lines of a script from the first line that holds `start` to the next line `fi`. */
function block(run: string, start: string): string {
  const lines = run.split("\n");
  const from = lines.findIndex((line) => line.includes(start));
  assert.notEqual(from, -1, start);
  const to = lines.findIndex((line, index) => index > from && line.trim() === "fi");
  assert.notEqual(to, -1, start);
  return lines.slice(from, to + 1).join("\n");
}

/** Runs a piece of a step's shell under bash with the given environment. */
function bash(script: string, env: Record<string, string>) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });
}

describe("the release callers", () => {
  for (const [file, channel] of [
    ["release.yml", "stable"],
    ["release-next.yml", "next"],
  ] as const) {
    it(`${file} calls release-stage.yml with the ${channel} channel`, () => {
      const jobs = jobsOf(readWorkflow(file));
      assert.equal(jobs.length, 1);
      const [, job] = jobs[0] ?? [];
      assert.equal(field(job, "uses"), "./.github/workflows/release-stage.yml");
      assert.equal(field(field(job, "with"), "channel"), channel);
    });
  }

  it("starts release.yml on stable tags and release-next.yml on next tags, never both", () => {
    const stable = readWorkflow("release.yml");
    const next = readWorkflow("release-next.yml");
    for (const tag of ["v1.2.3", "v0.9.0", "v10.20.30"]) {
      assert.equal(startsOn(stable, tag), true, tag);
      assert.equal(startsOn(next, tag), false, tag);
    }
    for (const tag of ["v2.0.0-next.0", "v2.0.0-next.12"]) {
      assert.equal(startsOn(stable, tag), false, tag);
      assert.equal(startsOn(next, tag), true, tag);
    }
    for (const tag of ["v2.0.0-beta.0", "v1.2.3-rc.1"]) {
      assert.equal(startsOn(stable, tag), false, tag);
      assert.equal(startsOn(next, tag), false, tag);
    }
  });
});

describe("release-stage.yml", () => {
  const stage = readWorkflow("release-stage.yml");

  it("is only called, never started by an event of its own", () => {
    const on = field(stage, "on");
    assert.ok(typeof on === "object" && on !== null);
    assert.deepEqual(Object.keys(on), ["workflow_call"]);
  });

  // What goes to npm is built only from the lockfile and the registry, so no release job may
  // restore or save a dependency cache. setup-node and pnpm/action-setup must say so explicitly,
  // so a change of their default cannot turn one on.
  it("restores and saves no dependency cache in any job", () => {
    const found: string[] = [];
    let setups = 0;
    for (const [name, job] of jobsOf(stage)) {
      const steps = field(job, "steps");
      assert.ok(Array.isArray(steps), name);
      for (const step of steps) {
        const uses = field(step, "uses");
        if (typeof uses !== "string") {
          continue;
        }
        const action = uses.split("@")[0] ?? "";
        const inputs = field(step, "with");
        const where = `${name}: ${action}`;
        if (action === "actions/cache" || action.startsWith("actions/cache/")) {
          found.push(`${where} is a cache action`);
        }
        for (const input of ["cache", "package-manager-cache"]) {
          const value = field(inputs, input);
          if (value !== undefined && value !== false) {
            found.push(`${where} sets ${input}: ${JSON.stringify(value)}`);
          }
        }
        const off =
          action === "actions/setup-node"
            ? "package-manager-cache"
            : action === "pnpm/action-setup"
              ? "cache"
              : undefined;
        if (off !== undefined) {
          setups += 1;
          if (field(inputs, off) === undefined) {
            found.push(`${where} does not set ${off}: false`);
          }
        }
      }
    }
    assert.ok(setups > 0, "no setup-node or pnpm/action-setup step found");
    assert.deepEqual(found, []);
  });

  it("checks out every script a sparse job runs, and what those import", () => {
    const missing: string[] = [];
    for (const [name, job] of jobsOf(stage)) {
      const steps = field(job, "steps");
      assert.ok(Array.isArray(steps), name);
      const sparse = steps
        .map((step: unknown) => field(field(step, "with"), "sparse-checkout"))
        .find((value: unknown) => typeof value === "string");
      if (typeof sparse !== "string") {
        continue;
      }
      const checkedOut = new Set(sparse.split("\n").filter((line) => line !== ""));
      for (const step of steps) {
        const run = field(step, "run");
        if (typeof run !== "string") {
          continue;
        }
        for (const match of run.matchAll(/node (scripts\/[\w-]+\.ts)/g)) {
          for (const script of importClosure(match[1] ?? "")) {
            if (!checkedOut.has(script)) {
              missing.push(`${name}: ${script}`);
            }
          }
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  /** The `run` scripts of every step of release-stage.yml, with the step's job and env. */
  const runs = jobsOf(stage).flatMap(([job, value]) => {
    const steps = field(value, "steps");
    return Array.isArray(steps)
      ? steps.flatMap((step: unknown) => {
          const run = field(step, "run");
          return typeof run === "string"
            ? [{ job, name: String(field(step, "name")), run, env: field(step, "env") }]
            : [];
        })
      : [];
  });

  it(
    "lets the publish job stage stable under beta or release-X.Y and next under next only",
    { skip: process.platform === "win32" ? "the guard is bash; the release runs on Linux" : false },
    () => {
      const publish = runs.find(
        (step) => step.job === "publish" && step.run.includes("npm stage publish"),
      );
      assert.ok(publish !== undefined);
      // From the first `allowed=` line to the `fi` that ends the check: the whole guard.
      const guard = block(publish.run, "allowed=");
      const cases: [string, string, boolean][] = [
        ["stable", "beta", true],
        ["stable", "release-1.0", true],
        ["stable", "release-12.34", true],
        ["stable", "next", false],
        ["stable", "latest", false],
        ["stable", "release-1", false],
        ["stable", "beta\nlatest", false],
        ["next", "next", true],
        ["next", "beta", false],
        ["next", "release-1.0", false],
        ["next", "latest", false],
        ["next", "next-1", false],
      ];
      for (const [channel, distTag, accepted] of cases) {
        const result = bash(guard, { CHANNEL: channel, DIST_TAG: distTag });
        assert.equal(result.status === 0, accepted, `${channel} ${JSON.stringify(distTag)}`);
      }
    },
  );

  // check-tarballs.ts runs from the tagged commit. A stable tag may predate the --channel option
  // (a hotfix branch cut from v0.9.0), so a stable call passes no option and gets the script's
  // default, the stable rule; only the next channel passes --channel next.
  it(
    "calls check-tarballs.ts with --channel next on next and with no channel option on stable",
    {
      skip: process.platform === "win32" ? "the steps are bash; the release runs on Linux" : false,
    },
    () => {
      const calls = runs.filter((step) => step.run.includes("scripts/check-tarballs.ts"));
      assert.equal(calls.length, 3, calls.map((step) => step.job).join(", "));
      for (const step of calls) {
        assert.equal(field(step.env, "CHANNEL"), "${{ inputs.channel }}", step.job);
        // From `channel_args=()` to the end of the call; node is a function that prints the
        // arguments after the script name.
        const lines = step.run.split("\n");
        const from = lines.findIndex((line) => line.includes("channel_args=()"));
        const call = lines.findIndex((line) => line.includes("scripts/check-tarballs.ts"));
        assert.ok(from !== -1 && call > from, step.job);
        const to = (lines[call] ?? "").trimEnd().endsWith("\\") ? call + 1 : call;
        const script = `node() { shift; printf '%s\\n' "$@"; }\n${lines.slice(from, to + 1).join("\n")}`;
        const env = { VERSION: "1.2.3", COMMIT: "c", out: "o", sums: "s", RUNNER_TEMP: "/t" };
        const stable = bash(script, { ...env, CHANNEL: "stable" });
        assert.equal(stable.status, 0, `${step.job}: ${stable.stderr}`);
        assert.equal(stable.stdout.includes("--channel"), false, step.job);
        assert.match(stable.stdout, /^--commit\nc\n$/m, step.job);
        const next = bash(script, { ...env, CHANNEL: "next" });
        assert.equal(next.status, 0, `${step.job}: ${next.stderr}`);
        assert.match(next.stdout, /\n--channel\nnext\n$/, step.job);
      }
    },
  );

  it(
    "fetches next for the next channel, and main and release/* for stable",
    { skip: process.platform === "win32" ? "the step is bash; the release runs on Linux" : false },
    () => {
      const verify = runs.find((step) => step.run.includes("scripts/verify-release-tag.ts"));
      assert.ok(verify !== undefined);
      // git is a function that prints its arguments, so the block runs without a repository.
      const fetch = `git() { printf '%s\\n' "$@"; }\n${block(verify.run, 'if [ "$CHANNEL" = next ]; then')}`;
      const next = bash(fetch, { CHANNEL: "next", TAG: "v2.0.0-next.0" });
      assert.equal(next.status, 0, next.stderr);
      const nextRefs = next.stdout.split("\n").filter((line) => line.startsWith("+refs/heads/"));
      assert.deepEqual(nextRefs, ["+refs/heads/next:refs/remotes/origin/next"]);
      const stable = bash(fetch, { CHANNEL: "stable", TAG: "v1.2.3" });
      assert.equal(stable.status, 0, stable.stderr);
      const stableRefs = stable.stdout
        .split("\n")
        .filter((line) => line.startsWith("+refs/heads/"));
      assert.deepEqual(stableRefs, [
        "+refs/heads/main:refs/remotes/origin/main",
        "+refs/heads/release/*:refs/remotes/origin/release/*",
      ]);
    },
  );
});
