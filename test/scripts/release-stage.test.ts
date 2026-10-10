// The shape of the release workflows: release.yml and release-next.yml call release-stage.yml with
// a fixed channel and the tag patterns that keep the two apart, and every job of release-stage.yml
// that checks out only some scripts checks out each script it runs and every script those import.
// Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

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

  for (const jobName of ["publish", "publish-dry-run"]) {
    for (const channel of ["stable", "next"]) {
      it(`runs ${jobName}'s ${channel} tarball check without installed dependencies`, () => {
        const job = jobsOf(stage).find(([name]) => name === jobName)?.[1];
        const steps = field(job, "steps");
        assert.ok(Array.isArray(steps));
        const sparse = steps
          .map((step: unknown) => field(field(step, "with"), "sparse-checkout"))
          .find((value: unknown) => typeof value === "string");
        assert.equal(typeof sparse, "string");
        const work = mkdtempSync(path.join(tmpdir(), "release-sparse-check-"));
        try {
          mkdirSync(path.join(work, "scripts"));
          for (const file of String(sparse)
            .split("\n")
            .filter((line) => line !== "")) {
            copyFileSync(path.join(ROOT, file), path.join(work, file));
          }
          mkdirSync(path.join(work, "tarballs"));
          const version = channel === "stable" ? "1.2.0" : "2.0.0-next.0";
          const commit = "1".repeat(40);
          const packages = [
            "hardhat-kms",
            "@hardhat-kms/aws",
            "@hardhat-kms/gcp",
            "@hardhat-kms/azure",
          ];
          const sums = packages.map((name, index) => {
            const source = `source-${index}`;
            mkdirSync(path.join(work, source, "package"), { recursive: true });
            writeFileSync(
              path.join(work, source, "package/package.json"),
              JSON.stringify({ name, version, gitHead: commit }),
            );
            const file = `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;
            execFileSync("tar", ["-czf", `tarballs/${file}`, "-C", source, "package"], {
              cwd: work,
            });
            const sum = createHash("sha256")
              .update(readFileSync(path.join(work, "tarballs", file)))
              .digest("hex");
            return `${sum}  ${file}`;
          });
          writeFileSync(path.join(work, "SHA256SUMS"), `${sums.join("\n")}\n`);
          const args = [
            "--experimental-strip-types",
            "scripts/check-tarballs.ts",
            "--dir",
            "tarballs",
            "--sums",
            "SHA256SUMS",
            "--version",
            version,
            "--commit",
            commit,
          ];
          if (channel === "next") {
            args.push("--channel", "next");
          }
          // The Node 22 CI leg preloads tsx through NODE_OPTIONS. The release job uses
          // native stripping; its empty checkout must not inherit that workspace loader.
          const options = {
            cwd: work,
            encoding: "utf8",
            env: { ...process.env, NODE_OPTIONS: "" },
          } as const;
          const good = spawnSync(process.execPath, args, options);
          assert.equal(good.status, 0, good.stderr);
          assert.equal(good.stdout.trim().split("\n").length, 4);
          const file = path.join(work, "tarballs", `hardhat-kms-${version}.tgz`);
          writeFileSync(file, "swapped artifact");
          const bad = spawnSync(process.execPath, args, options);
          assert.equal(bad.status, 1, bad.stderr);
          assert.match(bad.stderr, /SHA-256/);
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      });
    }
  }

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

describe("promote.yml", () => {
  const workflow = readWorkflow("promote.yml");
  const jobs = new Map(jobsOf(workflow));

  it("marks the release latest after npm succeeds even when the optional live ancestor skipped", () => {
    const job = jobs.get("release-latest");
    assert.equal(field(job, "needs"), "latest");
    const condition = field(job, "if");
    assert.ok(typeof condition === "string");
    const expression = condition.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "");
    // This condition uses the JS-compatible subset of Actions expressions. Without a status
    // function, Actions also applies success() to every ancestor, including skipped live jobs.
    const overridesStatus = /\b(?:always|cancelled|failure|success)\s*\(/.test(expression);
    for (const live of ["skipped", "success"]) {
      for (const latest of ["success", "failure", "cancelled", "skipped"]) {
        for (const cancelled of [false, true]) {
          const result: unknown = runInNewContext(expression, {
            cancelled: () => cancelled,
            needs: { latest: { result: latest } },
          });
          assert.equal(typeof result, "boolean");
          const defaultStatus = !cancelled && live === "success" && latest === "success";
          assert.equal(
            (overridesStatus || defaultStatus) && result,
            !cancelled && latest === "success",
            JSON.stringify({ live, latest, cancelled }),
          );
        }
      }
    }
  });

  it("moves latest in one concurrency group for every version, never cancelled", () => {
    const groups = ["latest", "release-latest"].map((name) => {
      const concurrency = field(jobs.get(name), "concurrency");
      assert.equal(field(concurrency, "cancel-in-progress"), false, name);
      const group = field(concurrency, "group");
      assert.equal(typeof group, "string", name);
      return String(group);
    });
    const [group] = groups;
    assert.ok(group !== undefined);
    assert.deepEqual(groups, [group, group]);
    // A fixed name: no expression, so no version (or anything else per run) in it.
    assert.doesNotMatch(group, /\$\{\{|version/i);
    // No other job, verify above all, waits on it.
    for (const [name, job] of jobs) {
      if (name !== "latest" && name !== "release-latest") {
        assert.notEqual(field(field(job, "concurrency"), "group"), group, name);
      }
    }
    assert.match(String(field(field(workflow, "concurrency"), "group")), /inputs\.version/);
  });

  it("checks the Sepolia proof in the verify job, after the live rule and with full history", () => {
    const steps: unknown = field(jobs.get("verify"), "steps");
    assert.ok(Array.isArray(steps));
    const text = (step: unknown, name: string): string => {
      const value = field(step, name);
      return typeof value === "string" ? value : "";
    };
    const runs = steps.map((step: unknown) => text(step, "run"));
    const rule = runs.findIndex((run) => run.includes("scripts/check-live-rule.ts"));
    const proof = runs.findIndex((run) =>
      run.startsWith('node test/live/check-release-proof.ts "$VERSION" "$LIVE_RUN"'),
    );
    assert.notEqual(rule, -1);
    assert.equal(proof, rule + 1);
    const checkout: unknown = steps.find((step: unknown) =>
      text(step, "uses").startsWith("actions/checkout@"),
    );
    assert.equal(field(field(checkout, "with"), "fetch-depth"), 0);
  });
});
