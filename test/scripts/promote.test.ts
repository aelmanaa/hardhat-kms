// The dist-tag move of promote.yml, run as bash with npm replaced by a function that prints a
// recorded `npm view <package> dist-tags --json` output and records each `npm dist-tag add`.
// npm 11 prints the dist-tags object, npm 12 (the pinned npm) a one-element array holding it.
// It also checks that the Turnkey live workflow runs only when dispatched, in its own environment,
// with its secrets in two steps. Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { PACKAGES } from "../../scripts/release-packages.ts";

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

/**
 * Runs the step with `npm view` printing `view` for every package, or the entry of `overrides`
 * for the packages it names.
 */
function moveLatest(
  view: string,
  version = "1.2.3",
  overrides: Record<string, string> = {},
  packages: string = PACKAGES.join(" "),
) {
  const summary = path.join(work, "summary.md");
  writeFileSync(summary, "");
  const stub = `npm() {
  if [ "$1" != view ]; then printf 'npm %s\\n' "$*"; return; fi
  case "$2" in
${Object.entries(overrides)
  .map(([name, output]) => `    ${JSON.stringify(name)}) printf '%s\\n' ${shellQuote(output)} ;;\n`)
  .join("")}    *) printf '%s\\n' "$NPM_VIEW" ;;
  esac
}
`;
  const result = spawnSync("bash", ["-e", "-c", stub + distTagStep()], {
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "",
      VERSION: version,
      NPM_VIEW: view,
      PACKAGES: packages,
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  const adds = result.stdout.split("\n").filter((line) => line.startsWith("npm dist-tag add"));
  // The step writes its ::error:: lines with echo, to standard output; node writes to stderr.
  return { status: result.status, output: result.stdout + result.stderr, adds };
}

/** A single-quoted bash word. */
const shellQuote = (text: string): string => `'${text.replaceAll("'", String.raw`'\''`)}'`;

const moved = (version: string) =>
  PACKAGES.map((name) => `npm dist-tag add ${name}@${version} latest`);

describe(
  "the dist-tag move of promote.yml",
  { skip: process.platform === "win32" ? "the step is bash; the promote runs on Linux" : false },
  () => {
    const npm11 = JSON.stringify({ beta: "1.2.3", latest: "1.2.2" }, null, 2);
    const npm12 = JSON.stringify([{ beta: "1.2.3", latest: "1.2.2" }], null, 2);

    it("moves latest for every published package from npm 11's object and npm 12's array", () => {
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

    it("checks every package before moving any: a bad later package moves none", () => {
      const bad: [string, RegExp][] = [
        ["[]", /npm view @hardhat-kms\/gcp dist-tags --json printed an array of 0 entries/],
        [JSON.stringify([{ beta: "1.2.2" }]), /@hardhat-kms\/gcp has beta at 1\.2\.2/],
        [
          JSON.stringify([{ beta: "1.2.3", latest: "1.3.0" }]),
          /@hardhat-kms\/gcp has latest at 1\.3\.0/,
        ],
      ];
      for (const [view, message] of bad) {
        const result = moveLatest(npm12, "1.2.3", { "@hardhat-kms/gcp": view });
        assert.notEqual(result.status, 0, view);
        assert.match(result.output, message, view);
        assert.deepEqual(result.adds, [], view);
      }
    });

    it("moves latest off a name placeholder: a new package's first promotion", () => {
      for (const placeholder of ["0.0.0-placeholder.0", "0.0.0-stage"]) {
        const result = moveLatest(npm12, "1.2.3", {
          "@hardhat-kms/turnkey": JSON.stringify([
            { placeholder: "0.0.0-placeholder.0", beta: "1.2.3", latest: placeholder },
          ]),
        });
        assert.equal(result.status, 0, result.output);
        assert.deepEqual(result.adds, moved("1.2.3"));
      }
    });

    it("refuses any other non-X.Y.Z latest before moving a tag, naming the package", () => {
      for (const current of ["1.0.0-rc.1", "0.0.0-rc.1", "0.0.0-placeholder.1", "2.0.0-beta.0"]) {
        const result = moveLatest(npm12, "1.2.3", {
          "@hardhat-kms/gcp": JSON.stringify([{ beta: "1.2.3", latest: current }]),
        });
        assert.notEqual(result.status, 0, current);
        assert.ok(
          result.output.includes(
            `@hardhat-kms/gcp has latest at ${current}, which is neither a stable X.Y.Z nor a name placeholder; fix the dist-tag first`,
          ),
          result.output,
        );
        assert.deepEqual(result.adds, [], current);
      }
    });

    it("skips a package whose latest already is the version and moves the rest", () => {
      const result = moveLatest(npm12, "1.2.3", {
        "hardhat-kms": JSON.stringify([{ beta: "1.2.3", latest: "1.2.3" }]),
        "@hardhat-kms/aws": JSON.stringify([{ beta: "1.2.3", latest: "1.2.3" }]),
      });
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(result.adds, moved("1.2.3").slice(2));
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

    it("moves Turnkey with the others, and only the packages the verify job listed", () => {
      assert.ok(PACKAGES.includes("@hardhat-kms/turnkey"));
      const older = "hardhat-kms @hardhat-kms/aws @hardhat-kms/gcp @hardhat-kms/azure";
      const result = moveLatest(npm12, "1.2.3", {}, older);
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(
        result.adds,
        older.split(" ").map((name) => `npm dist-tag add ${name}@1.2.3 latest`),
      );
    });

    it("refuses an empty list and a name outside the project before moving a tag", () => {
      const cases: [string, RegExp][] = [
        ["", /the verify job listed no packages for 1\.2\.3/],
        ["hardhat-kms left-pad", /'left-pad' is not hardhat-kms or an @hardhat-kms package/],
        ["hardhat-kms @other/aws", /'@other\/aws' is not hardhat-kms or an @hardhat-kms package/],
      ];
      for (const [packages, message] of cases) {
        const result = moveLatest(npm12, "1.2.3", {}, packages);
        assert.notEqual(result.status, 0, packages);
        assert.match(result.output, message, packages);
        assert.deepEqual(result.adds, [], packages);
      }
    });
  },
);

describe("the package list of promote.yml", () => {
  const workflow: unknown = parse(
    readFileSync(path.join(ROOT, ".github/workflows/promote.yml"), "utf8"),
  );
  const job = (name: string): unknown => field(field(workflow, "jobs"), name);

  it("comes from scripts/release-packages.ts at the tagged commit, in the verify job", () => {
    assert.equal(
      field(field(job("verify"), "outputs"), "packages"),
      "${{ steps.packages.outputs.packages }}",
    );
    const steps = field(job("verify"), "steps");
    assert.ok(Array.isArray(steps));
    const step: unknown = steps.find((entry: unknown) => field(entry, "id") === "packages");
    assert.match(
      String(field(step, "run")),
      /node scripts\/release-packages\.ts --commit "\$COMMIT"/,
    );
    assert.equal(field(field(step, "env"), "COMMIT"), "${{ steps.tag.outputs.commit }}");
  });

  it("is what every registry check of the verify job reads, through --commit", () => {
    const steps = field(job("verify"), "steps");
    assert.ok(Array.isArray(steps));
    for (const script of ["check-registry-release", "check-packages", "consumer-typecheck"]) {
      const step: unknown = steps.find((entry: unknown) =>
        String(field(entry, "run")).includes(`node scripts/${script}.ts`),
      );
      assert.match(String(field(step, "run")), /--commit "\$COMMIT"/, script);
      assert.equal(field(field(step, "env"), "COMMIT"), "${{ steps.tag.outputs.commit }}", script);
    }
  });

  it("reaches the dist-tag move, which names no package itself", () => {
    const steps = field(job("latest"), "steps");
    assert.ok(Array.isArray(steps));
    const step: unknown = steps.find((entry: unknown) =>
      String(field(entry, "run")).includes("npm dist-tag add"),
    );
    assert.equal(field(field(step, "env"), "PACKAGES"), "${{ needs.verify.outputs.packages }}");
    assert.doesNotMatch(String(field(step, "run")), /@hardhat-kms\/(aws|gcp|azure|turnkey)/);
  });

  it("keeps Turnkey out of the live job's keys and cloud sign-ins", () => {
    assert.doesNotMatch(JSON.stringify(job("live")), /turnkey/i);
  });
});

/** A workflow file, parsed. */
function readWorkflow(file: string): unknown {
  return parse(readFileSync(path.join(ROOT, ".github/workflows", file), "utf8"));
}

describe("the Turnkey live workflow", () => {
  const workflow = readWorkflow("turnkey-live.yml");
  const smoke = field(field(workflow, "jobs"), "smoke");
  const steps = field(smoke, "steps");

  it("runs only when dispatched, never on a schedule or a pull request", () => {
    const triggers = field(workflow, "on");
    assert.ok(typeof triggers === "object" && triggers !== null);
    assert.deepEqual(Object.keys(triggers), ["workflow_dispatch"]);
    assert.deepEqual(field(workflow, "permissions"), {});
  });

  it("runs in the turnkey-live environment, with read access and no OIDC token", () => {
    assert.equal(field(smoke, "environment"), "turnkey-live");
    assert.deepEqual(field(smoke, "permissions"), { contents: "read" });
    assert.equal(field(smoke, "env"), undefined);
  });

  it("gives the Turnkey secrets to the check and the test steps only", () => {
    assert.ok(Array.isArray(steps));
    const holders = steps
      .filter((step: unknown) => JSON.stringify(field(step, "env") ?? {}).includes("secrets."))
      .map((step: unknown) => field(step, "name"));
    assert.deepEqual(holders, [
      "Check that the secrets and variables are set",
      "Turnkey smoke test",
    ]);
    const test: unknown = steps.find(
      (step: unknown) => field(step, "name") === "Turnkey smoke test",
    );
    assert.deepEqual(field(test, "env"), {
      TURNKEY_API_PRIVATE_KEY: "${{ secrets.TURNKEY_API_PRIVATE_KEY }}",
      TURNKEY_ORGANIZATION_ID: "${{ secrets.TURNKEY_ORGANIZATION_ID }}",
      HARDHAT_KMS_LIVE_TURNKEY_ADDRESS: "${{ vars.TURNKEY_ADDRESS }}",
      HARDHAT_KMS_LIVE_TURNKEY_DENIED_ADDRESS: "${{ vars.TURNKEY_DENIED_ADDRESS }}",
      HARDHAT_KMS_LIVE_TURNKEY_CONSENSUS_ADDRESS: "${{ vars.TURNKEY_CONSENSUS_ADDRESS }}",
      HARDHAT_KMS_LIVE_TURNKEY_SEPOLIA: "${{ inputs.sepolia-send && '1' || '' }}",
    });
  });

  it("stays out of the three-cloud live workflow", () => {
    assert.doesNotMatch(JSON.stringify(readWorkflow("live-tests.yml")), /turnkey/i);
  });
});
