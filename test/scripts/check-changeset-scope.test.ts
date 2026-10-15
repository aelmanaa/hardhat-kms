// The changeset scope check of ci.yml (`scripts/check-changeset-scope.ts`): a pull request that
// changes nothing under packages/ adds no changeset. The decision is tested on change lists and on
// scratch git repositories, where a branch stands for a pull request and a local branch for the
// fetched base. The last block pins the Changeset job of ci.yml. Runs in `pnpm test`, with no
// network.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import {
  type Change,
  changesSince,
  checkScope,
  isChangeset,
  parseNameStatus,
  RULE_URL,
} from "../../scripts/check-changeset-scope.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/check-changeset-scope.ts");

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

const added = (file: string): Change => ({ status: "A", path: file });
const modified = (file: string): Change => ({ status: "M", path: file });
const deleted = (file: string): Change => ({ status: "D", path: file });

describe("isChangeset", () => {
  it("is a Markdown file directly under .changeset/ other than the README", () => {
    assert.equal(isChangeset(".changeset/easy-ears-roll.md"), true);
    assert.equal(isChangeset(".changeset/README.md"), false);
    assert.equal(isChangeset(".changeset/config.json"), false);
    assert.equal(isChangeset(".changeset/pre/easy-ears-roll.md"), false);
    assert.equal(isChangeset("docs/easy-ears-roll.md"), false);
    assert.equal(isChangeset("packages/hardhat-kms/.changeset/x.md"), false);
  });
});

describe("parseNameStatus", () => {
  it("reads NUL-separated status and path pairs", () => {
    assert.deepEqual(parseNameStatus("A\0.changeset/x.md\0M\0docs/a b.md\0"), [
      added(".changeset/x.md"),
      modified("docs/a b.md"),
    ]);
    assert.deepEqual(parseNameStatus(""), []);
  });

  it("refuses output it does not understand", () => {
    assert.throws(() => parseNameStatus("A\0"), /odd number of fields/);
    assert.throws(() => parseNameStatus("R100\0a\0"), /unexpected entry "R100"/);
  });
});

describe("checkScope", () => {
  const base = "origin/main";

  it("passes a package change with a changeset", () => {
    const result = checkScope(
      [modified("packages/hardhat-kms/src/index.ts"), added(".changeset/x.md")],
      base,
    );
    assert.equal(result.ok, true);
    assert.equal(result.packageChanged, true);
  });

  it("passes a package change with no changeset: changeset status refuses that one", () => {
    const result = checkScope([modified("packages/hardhat-kms-aws/src/index.ts")], base);
    assert.equal(result.ok, true);
    assert.match(result.message, /changeset status checks its changeset/);
  });

  it("refuses a changeset on a pull request that changes no package, naming each one", () => {
    const result = checkScope(
      [modified(".github/workflows/ci.yml"), added(".changeset/b.md"), added(".changeset/a.md")],
      base,
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.addedChangesets, [".changeset/a.md", ".changeset/b.md"]);
    assert.equal(
      result.message,
      `This pull request changes nothing under packages/ since origin/main, so it carries no changeset, not even an empty one. Delete .changeset/a.md, .changeset/b.md. See ${RULE_URL}`,
    );
  });

  it("passes a pull request that changes no package and adds no changeset", () => {
    const result = checkScope([modified("docs/user/README.md"), modified("scripts/pack.ts")], base);
    assert.equal(result.ok, true);
    assert.equal(result.packageChanged, false);
  });

  it("passes a test-only package change with an empty changeset", () => {
    const result = checkScope(
      [modified("packages/hardhat-kms/test/rpc.test.ts"), added(".changeset/empty.md")],
      base,
    );
    assert.equal(result.ok, true);
  });

  it("passes an edit of the changeset README or config", () => {
    assert.equal(
      checkScope([modified(".changeset/README.md"), modified(".changeset/config.json")], base).ok,
      true,
    );
  });

  it("passes a pull request that only edits or deletes an existing changeset", () => {
    assert.equal(checkScope([modified(".changeset/x.md")], base).ok, true);
    assert.equal(checkScope([deleted(".changeset/x.md")], base).ok, true);
  });

  it("passes a Version Packages pull request: it changes packages and deletes changesets", () => {
    const result = checkScope(
      [
        modified("packages/hardhat-kms/package.json"),
        modified("packages/hardhat-kms/CHANGELOG.md"),
        deleted(".changeset/x.md"),
        modified("pnpm-lock.yaml"),
      ],
      "origin/release/1.0",
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.addedChangesets, []);
  });
});

describe("check-changeset-scope on git repositories", () => {
  let sandbox: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  const git = (args: readonly string[]): string =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
      ].concat(args),
      { cwd: repo, encoding: "utf8", env },
    );

  const write = (file: string, text: string): void => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };

  /** Commits the files on a new branch from `from`, as the head of a pull request. */
  const pullRequest = (name: string, from: string, files: Record<string, string>): void => {
    git(["switch", "--quiet", "-c", name, from]);
    for (const [file, text] of Object.entries(files)) {
      write(file, text);
    }
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", name]);
  };

  /** Runs the script in the repository with HEAD at `head`. */
  const run = (head: string, base: string) => {
    git(["switch", "--quiet", head]);
    const result = spawnSync(process.execPath, [SCRIPT, `--base=${base}`], {
      cwd: repo,
      encoding: "utf8",
      env,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  before(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "changeset-scope-test-"));
    repo = path.join(sandbox, "repo");
    mkdirSync(repo);
    // The Node 22 CI leg loads TypeScript through `NODE_OPTIONS=--import tsx`, which Node resolves
    // from the child's working directory. The scratch repository has no `node_modules`, so the
    // script's process gets the workspace's copy by URL. Any other option stays.
    const tsx = /(?:^|\s)--import(?:=|\s+)tsx(?=\s|$)/g;
    const nodeOptions = process.env["NODE_OPTIONS"] ?? "";
    env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(sandbox, "no-global-gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      NODE_OPTIONS: tsx.test(nodeOptions)
        ? nodeOptions.replaceAll(tsx, ` --import ${import.meta.resolve("tsx")} `).trim()
        : nodeOptions,
    };
    git(["init", "--quiet", "--initial-branch=main"]);
    write("packages/hardhat-kms/src/index.ts", "export {};\n");
    write("packages/hardhat-kms/test/index.test.ts", "// test\n");
    write(".changeset/README.md", "# Changesets\n");
    write(".changeset/config.json", "{}\n");
    write(".github/workflows/ci.yml", "name: CI\n");
    write("docs/user/README.md", "# Docs\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", "initial"]);
  });

  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("refuses a pull request that touches only .github/ and adds a changeset", () => {
    pullRequest("ci-with-changeset", "main", {
      ".github/workflows/ci.yml": "name: CI 2\n",
      ".changeset/x.md": "---\n---\n",
    });
    const result = run("ci-with-changeset", "main");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^::error::This pull request changes nothing under packages\//);
    assert.match(result.stderr, /Delete \.changeset\/x\.md\./);
    assert.ok(result.stderr.includes(RULE_URL));
  });

  it("passes a pull request that touches packages/ and adds a changeset", () => {
    pullRequest("package-with-changeset", "main", {
      "packages/hardhat-kms/src/index.ts": "export const a = 1;\n",
      ".changeset/y.md": "---\n'hardhat-kms': patch\n---\n\nFixes a.\n",
    });
    const result = run("package-with-changeset", "main");
    assert.equal(result.status, 0, result.stderr);
  });

  it("passes a test-only package change with an empty changeset", () => {
    pullRequest("test-with-empty-changeset", "main", {
      "packages/hardhat-kms/test/index.test.ts": "// test 2\n",
      ".changeset/empty.md": "---\n---\n",
    });
    assert.equal(run("test-with-empty-changeset", "main").status, 0);
  });

  it("passes a pull request that touches neither", () => {
    pullRequest("docs-only", "main", { "docs/user/README.md": "# Docs 2\n" });
    const result = run("docs-only", "main");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Nothing under packages\/ changed since main/);
  });

  it("passes a pull request that only edits the changeset README or config", () => {
    pullRequest("changeset-config", "main", {
      ".changeset/README.md": "# Changesets 2\n",
      ".changeset/config.json": '{ "baseBranch": "main" }\n',
    });
    assert.equal(run("changeset-config", "main").status, 0);
  });

  it("counts a changeset renamed from another file as added", () => {
    git(["switch", "--quiet", "-c", "rename", "main"]);
    git(["mv", "docs/user/README.md", ".changeset/z.md"]);
    git(["commit", "--quiet", "-m", "rename"]);
    assert.equal(run("rename", "main").status, 1);
  });

  it("compares a pull request into release/1.0 with that branch, not main", () => {
    // release/1.0 carries a package change that main lacks, as a hotfix line does.
    pullRequest("release/1.0", "main", { "packages/hardhat-kms/src/index.ts": "// 1.0.1\n" });
    pullRequest("into-release", "release/1.0", {
      "docs/user/README.md": "# Docs for 1.0\n",
      ".changeset/w.md": "---\n---\n",
    });
    // Against main, the release line's package change hides that this pull request changes none.
    assert.equal(run("into-release", "main").status, 0);
    const result = run("into-release", "release/1.0");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /since release\/1\.0, so it carries no changeset/);
    assert.deepEqual(
      changesSince("release/1.0", repo).map((change) => change.path),
      [".changeset/w.md", "docs/user/README.md"],
    );
  });

  it("passes a fix into release/1.0 with its changeset", () => {
    pullRequest("fix-into-release", "release/1.0", {
      "packages/hardhat-kms/src/index.ts": "// 1.0.2\n",
      ".changeset/v.md": "---\n'hardhat-kms': patch\n---\n\nFixes b.\n",
    });
    assert.equal(run("fix-into-release", "release/1.0").status, 0);
  });

  it("fails when --base is missing or unknown", () => {
    git(["switch", "--quiet", "main"]);
    const missing = spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: "utf8", env });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--base is required/);
    assert.equal(run("main", "origin/no-such-branch").status, 1);
  });
});

describe("the Changeset job of ci.yml", () => {
  const workflow: unknown = parse(
    readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"),
  );
  const job = field(field(workflow, "jobs"), "changeset");
  const steps = field(job, "steps");
  assert.ok(Array.isArray(steps));
  const runs = steps.map((step: unknown) => ({
    run: field(step, "run"),
    base: field(field(step, "env"), "BASE_REF"),
  }));

  it("skips only changeset-release/<base branch> from this repository, the Version Packages head", () => {
    assert.equal(
      field(job, "if"),
      "github.event_name == 'pull_request' && !(github.head_ref == format('changeset-release/{0}', github.base_ref) &&\n" +
        "  github.event.pull_request.head.repo.full_name == github.repository) &&\n" +
        "github.event.pull_request.user.login != 'dependabot[bot]'",
    );
  });

  it("runs changeset status and the scope check against the pull request's base branch", () => {
    const status = runs.find(
      (step) => typeof step.run === "string" && step.run.includes("pnpm changeset status"),
    );
    const scope = runs.find(
      (step) => typeof step.run === "string" && step.run.includes("check-changeset-scope.ts"),
    );
    assert.ok(status !== undefined && scope !== undefined);
    assert.equal(status.base, "${{ github.base_ref }}");
    assert.equal(scope.base, "${{ github.base_ref }}");
    assert.match(String(status.run), /--since "origin\/\$\{BASE_REF\}"/);
    assert.equal(scope.run, 'node scripts/check-changeset-scope.ts "--base=origin/${BASE_REF}"');
    assert.ok(runs.indexOf(status) < runs.indexOf(scope));
    assert.ok(!JSON.stringify(job).includes("origin/main"));
  });
});
