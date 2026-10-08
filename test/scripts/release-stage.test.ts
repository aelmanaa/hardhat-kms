// The shape of the release workflows: release.yml and release-next.yml call release-stage.yml with
// a fixed channel and the tag patterns that keep the two apart, and every job of release-stage.yml
// that checks out only some scripts checks out each script it runs and every script those import.
// Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
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
});
