// scripts/test-bumped-versions.ts and the ci.yml job that runs it. Runs in `pnpm test`, with no
// network. The bump runs the real `changeset version` on a scratch git repository shaped like this
// one; the test run itself (`pnpm test` at the bumped versions) is exercised by the CI job.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { RELEASE_PACKAGES } from "../../scripts/release-packages.ts";
import {
  bumpTree,
  offlineConfig,
  pendingChangesets,
  SIGNAL_EXIT_CODES,
  versionChanges,
} from "../../scripts/test-bumped-versions.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/test-bumped-versions.ts");
/** The changesets CLI of the workspace, run with this Node so that no shim is needed. */
const CHANGESET_BIN = createRequire(path.join(ROOT, "package.json")).resolve(
  "@changesets/cli/bin.js",
);

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * A scratch git repository shaped like this one for the release: the published packages at 1.2.0
 * as one pnpm workspace, this repository's `.changeset/config.json` (the GitHub changelog and the
 * fixed group), and one `minor` changeset on the core, committed.
 */
function scratchRepository(sandbox: string, env: NodeJS.ProcessEnv): string {
  const repo = path.join(sandbox, "repo");
  const write = (file: string, text: string | Buffer): void => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };
  write("package.json", `${JSON.stringify({ name: "scratch", private: true })}\n`);
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  for (const { name, directory } of RELEASE_PACKAGES) {
    write(`packages/${directory}/package.json`, `${JSON.stringify({ name, version: "1.2.0" })}\n`);
  }
  write(".changeset/config.json", readFileSync(path.join(ROOT, ".changeset/config.json")));
  write(".changeset/README.md", "# Changesets\n");
  write(".changeset/café-fix.md", '---\n"hardhat-kms": minor\n---\n\nA fix.\n');
  const git = (args: readonly string[]): void => {
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repo, env, stdio: "ignore" },
    );
  };
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "initial"]);
  return repo;
}

/**
 * The environment of the processes the tests start in a scratch repository: no global or system
 * git config, and the workspace's tsx by URL on the Node 22 leg, which loads TypeScript through
 * `NODE_OPTIONS=--import tsx` that Node would resolve from the scratch directory.
 */
function scratchEnv(sandbox: string): NodeJS.ProcessEnv {
  const tsx = /(?:^|\s)--import(?:=|\s+)tsx(?=\s|$)/g;
  const nodeOptions = process.env["NODE_OPTIONS"] ?? "";
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(sandbox, "no-global-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    NODE_OPTIONS: tsx.test(nodeOptions)
      ? nodeOptions.replaceAll(tsx, ` --import ${import.meta.resolve("tsx")} `).trim()
      : nodeOptions,
  };
}

describe("pendingChangesets", () => {
  it("keeps the Markdown files directly under .changeset/ but the README, sorted", () => {
    assert.deepEqual(
      pendingChangesets(
        ".changeset/README.md\0.changeset/config.json\0.changeset/zebra-fix.md\0.changeset/alpha-feature.md\0",
      ),
      [".changeset/alpha-feature.md", ".changeset/zebra-fix.md"],
    );
  });

  it("finds none in a tree with only the README and the config", () => {
    assert.deepEqual(pendingChangesets(".changeset/README.md\0.changeset/config.json\0"), []);
    assert.deepEqual(pendingChangesets(""), []);
  });
});

describe("offlineConfig", () => {
  it("turns the changelog off and keeps the rest of the repository's config", () => {
    const text = readFileSync(path.join(ROOT, ".changeset/config.json"), "utf8");
    const original: unknown = JSON.parse(text);
    const offline: unknown = JSON.parse(offlineConfig(text));
    assert.notEqual(field(original, "changelog"), false);
    assert.equal(field(offline, "changelog"), false);
    assert.deepEqual({ ...Object(offline), changelog: field(original, "changelog") }, original);
  });

  it("refuses a config that is not a JSON object", () => {
    assert.throws(() => offlineConfig("[]"), /not a JSON object/);
    assert.throws(() => offlineConfig("null"), /not a JSON object/);
  });
});

describe("versionChanges", () => {
  it("lists only the packages whose version changed", () => {
    const released = new Map([
      ["hardhat-kms", "1.2.0"],
      ["@hardhat-kms/aws", "1.2.0"],
    ]);
    assert.deepEqual(
      versionChanges(
        released,
        new Map([
          ["hardhat-kms", "1.3.0"],
          ["@hardhat-kms/aws", "1.2.0"],
        ]),
      ),
      ["hardhat-kms 1.2.0 -> 1.3.0"],
    );
    assert.deepEqual(versionChanges(released, released), []);
  });
});

describe("the bumped job of ci.yml", () => {
  const workflow: unknown = parse(
    readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"),
  );
  const job = field(field(workflow, "jobs"), "bumped");
  const steps = field(job, "steps");
  const stepList: unknown[] = Array.isArray(steps) ? steps : [];

  it("runs on pull requests and on pushes to main, with a read-only token", () => {
    const on = field(workflow, "on");
    assert.ok(typeof on === "object" && on !== null && Object.hasOwn(on, "pull_request"));
    assert.deepEqual(field(field(on, "push"), "branches"), ["main"]);
    assert.deepEqual(field(workflow, "permissions"), { contents: "read" });
    assert.equal(field(job, "permissions"), undefined);
    assert.equal(field(job, "if"), undefined);
  });

  it("runs the script and restores no cache", () => {
    assert.ok(
      stepList.some((step) => field(step, "run") === "node scripts/test-bumped-versions.ts"),
    );
    for (const step of stepList) {
      const uses = asString(field(step, "uses"));
      assert.ok(!uses.startsWith("actions/cache"), uses);
      if (uses.startsWith("actions/setup-node@")) {
        assert.equal(field(field(step, "with"), "package-manager-cache"), false);
        assert.equal(field(field(step, "with"), "cache"), undefined);
      }
    }
  });

  it("checks out without persisting credentials and passes no secret", () => {
    const checkout = stepList.find((step) =>
      asString(field(step, "uses")).startsWith("actions/checkout@"),
    );
    assert.equal(field(field(checkout, "with"), "persist-credentials"), false);
    assert.doesNotMatch(JSON.stringify(job), /secrets\.|github\.token|GITHUB_TOKEN/);
  });
});

describe("the bump on a scratch repository", () => {
  let sandbox: string;
  let env: NodeJS.ProcessEnv;
  let repo: string;

  before(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "bumped-versions-test-"));
    env = scratchEnv(sandbox);
    repo = scratchRepository(sandbox, env);
  });

  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("finds a changeset whose name git would quote, from git ls-tree -z", () => {
    const output = execFileSync(
      "git",
      ["ls-tree", "-z", "--name-only", "HEAD", "--", ".changeset/"],
      {
        cwd: repo,
        env,
        encoding: "utf8",
      },
    );
    assert.deepEqual(pendingChangesets(output), [".changeset/café-fix.md"]);
    const quoted = execFileSync("git", ["ls-tree", "--name-only", "HEAD", "--", ".changeset/"], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    assert.deepEqual(pendingChangesets(quoted.replaceAll("\n", "\0")), []);
  });

  it("bumps every package of the fixed group and leaves the config as it was, byte for byte", () => {
    const configPath = path.join(repo, ".changeset/config.json");
    const config = readFileSync(configPath);
    let changelogDuringVersion: unknown;
    const changes = bumpTree(repo, (cwd) => {
      changelogDuringVersion = field(JSON.parse(readFileSync(configPath, "utf8")), "changelog");
      // No GITHUB_TOKEN: with the GitHub changelog on, changeset version would fail asking for one.
      const { GITHUB_TOKEN: _token, ...withoutToken } = env;
      execFileSync(process.execPath, [CHANGESET_BIN, "version"], {
        cwd,
        env: withoutToken,
        stdio: "pipe",
      });
    });
    assert.equal(changelogDuringVersion, false);
    assert.deepEqual(
      changes,
      RELEASE_PACKAGES.map(({ name }) => `${name} 1.2.0 -> 1.3.0`),
    );
    assert.ok(readFileSync(configPath).equals(config), "the config changed");
    assert.deepEqual(readdirSync(path.join(repo, ".changeset")).toSorted(), [
      "README.md",
      "config.json",
    ]);
    for (const { directory } of RELEASE_PACKAGES) {
      assert.deepEqual(
        readdirSync(path.join(repo, "packages", directory)),
        ["package.json"],
        `packages/${directory} got a changelog`,
      );
    }
  });

  it("restores the config when changeset version fails", () => {
    const configPath = path.join(repo, ".changeset/config.json");
    const config = readFileSync(configPath);
    assert.throws(
      () =>
        bumpTree(repo, () => {
          throw new Error("version failed");
        }),
      /version failed/,
    );
    assert.ok(readFileSync(configPath).equals(config), "the config changed");
  });
});

describe(
  "the script on a signal",
  { skip: process.platform === "win32" && "POSIX signals" },
  () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      it(`removes the scratch worktree and exits ${SIGNAL_EXIT_CODES[signal]} on ${signal}`, async () => {
        const sandbox = mkdtempSync(path.join(tmpdir(), "bumped-versions-signal-"));
        try {
          const scratchTmp = path.join(sandbox, "tmp");
          const bin = path.join(sandbox, "bin");
          mkdirSync(scratchTmp);
          mkdirSync(bin);
          // A pnpm that never finishes, so the signal arrives during the scratch install.
          writeFileSync(path.join(bin, "pnpm"), '#!/bin/sh\necho "fake pnpm $*"\nexec sleep 60\n');
          chmodSync(path.join(bin, "pnpm"), 0o755);
          const base = scratchEnv(sandbox);
          const repo = scratchRepository(sandbox, base);
          const env = {
            ...base,
            TMPDIR: scratchTmp,
            PATH: `${bin}${path.delimiter}${base["PATH"] ?? ""}`,
          };
          const child = spawn(process.execPath, [SCRIPT], {
            cwd: repo,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          const exit = new Promise<number | null>((resolve) => {
            child.once("close", (code) => {
              resolve(code);
            });
          });
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error(`the scratch install never started: ${output}`));
            }, 30_000);
            child.stdout.on("data", (chunk: Buffer) => {
              output += chunk.toString("utf8");
              if (output.includes("fake pnpm install")) {
                clearTimeout(timer);
                resolve();
              }
            });
          });
          const worktrees = (): string =>
            execFileSync("git", ["worktree", "list", "--porcelain"], {
              cwd: repo,
              env,
              encoding: "utf8",
            });
          assert.equal(worktrees().match(/^worktree /gm)?.length, 2);
          child.kill(signal);
          assert.equal(await exit, SIGNAL_EXIT_CODES[signal]);
          assert.equal(worktrees().match(/^worktree /gm)?.length, 1);
          // tsx, on the Node 22 leg, keeps its own cache in the temp directory.
          assert.deepEqual(
            readdirSync(scratchTmp).filter((entry) => entry.startsWith("hardhat-kms-bumped-")),
            [],
          );
        } finally {
          rmSync(sandbox, { recursive: true, force: true });
        }
      });
    }
  },
);
