// The dist-tag move of promote.yml, run as bash with npm replaced by a function that prints a
// recorded `npm view <package> dist-tags --json` output and records each `npm dist-tag add`.
// npm 11 prints the dist-tags object, npm 12 (the pinned npm) a one-element array holding it.
// Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/** The `run` of the step of the `latest` job that moves the dist-tags. */
function distTagStep(): string {
  const workflow: unknown = parse(
    readFileSync(path.join(ROOT, ".github/workflows/promote.yml"), "utf8"),
  );
  const steps = field(field(field(workflow, "jobs"), "latest"), "steps");
  assert.ok(Array.isArray(steps));
  const runs = steps
    .map((step) => field(step, "run"))
    .filter((run): run is string => typeof run === "string" && run.includes("npm dist-tag add"));
  assert.equal(runs.length, 1);
  return runs[0] ?? "";
}

const work = mkdtempSync(path.join(tmpdir(), "promote-test-"));
after(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Runs the step with `npm view` printing `view` for every package. */
function moveLatest(view: string, version = "1.2.3") {
  const summary = path.join(work, "summary.md");
  writeFileSync(summary, "");
  const stub = `npm() {
  if [ "$1" = view ]; then printf '%s\\n' "$NPM_VIEW"; else printf 'npm %s\\n' "$*"; fi
}
`;
  const result = spawnSync("bash", ["-e", "-c", stub + distTagStep()], {
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "",
      VERSION: version,
      NPM_VIEW: view,
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  const adds = result.stdout.split("\n").filter((line) => line.startsWith("npm dist-tag add"));
  // The step writes its ::error:: lines with echo, to standard output; node writes to stderr.
  return { status: result.status, output: result.stdout + result.stderr, adds };
}

const PACKAGES = ["hardhat-kms", "@hardhat-kms/aws", "@hardhat-kms/gcp", "@hardhat-kms/azure"];
const moved = (version: string) =>
  PACKAGES.map((name) => `npm dist-tag add ${name}@${version} latest`);

describe(
  "the dist-tag move of promote.yml",
  { skip: process.platform === "win32" ? "the step is bash; the promote runs on Linux" : false },
  () => {
    const npm11 = JSON.stringify({ beta: "1.2.3", latest: "1.2.2" }, null, 2);
    const npm12 = JSON.stringify([{ beta: "1.2.3", latest: "1.2.2" }], null, 2);

    it("moves latest for the four packages from npm 11's object and npm 12's array", () => {
      for (const view of [npm11, npm12]) {
        const result = moveLatest(view);
        assert.equal(result.status, 0, result.output);
        assert.deepEqual(result.adds, moved("1.2.3"));
      }
    });

    it("reads a hotfix staged under release-X.Y from npm 12's array", () => {
      const result = moveLatest(
        JSON.stringify([{ "release-1.2": "1.2.4", latest: "1.3.0" }]),
        "1.2.4",
      );
      assert.notEqual(result.status, 0);
      assert.match(result.output, /latest at 1\.3\.0, above 1\.2\.4/);
      const hotfix = moveLatest(
        JSON.stringify([{ "release-1.2": "1.2.4", latest: "1.2.3" }]),
        "1.2.4",
      );
      assert.equal(hotfix.status, 0, hotfix.output);
      assert.deepEqual(hotfix.adds, moved("1.2.4"));
    });

    it("still refuses a version beta does not point at, in both shapes", () => {
      for (const view of [{ beta: "1.2.2" }, [{ beta: "1.2.2" }]]) {
        const result = moveLatest(JSON.stringify(view));
        assert.notEqual(result.status, 0);
        assert.match(result.output, /hardhat-kms has beta at 1\.2\.2 and release-1\.2 at nothing/);
        assert.deepEqual(result.adds, []);
      }
    });

    it("refuses any other shape before moving a tag, naming the package", () => {
      const cases: [string, RegExp][] = [
        ["[]", /npm view hardhat-kms dist-tags --json printed an array of 0 entries/],
        [
          JSON.stringify([{ beta: "1.2.3" }, { beta: "1.2.3" }]),
          /npm view hardhat-kms dist-tags --json printed an array of 2 entries/,
        ],
        ['"1.2.3"', /printed "1\.2\.3", not a dist-tags object/],
        ["[[]]", /printed \[\], not a dist-tags object/],
        [
          '{"error":{"code":"E404"}}',
          /printed \{"error":\{"code":"E404"\}\}, not a dist-tags object/,
        ],
      ];
      for (const [view, message] of cases) {
        const result = moveLatest(view);
        assert.notEqual(result.status, 0, view);
        assert.match(result.output, message, view);
        assert.deepEqual(result.adds, [], view);
      }
    });
  },
);
