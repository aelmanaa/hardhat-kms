// An integration test that starts the Hardhat CLI calls `runHardhat` from
// `packages/hardhat-kms/test/helpers/hardhat-cli.ts`, never `spawnSync`: one synchronous limit for
// startup and work timed out under load (#240), and the helper's run can be stopped by the test's
// signal. This test parses every `packages/*/test/integration/**/*.test.ts` and fails on a
// `spawnSync` call whose arguments name the CLI. A `spawnSync` that starts a fixture script with
// Node is fine.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseSync } from "oxc-parser";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** The CLI's path inside the `hardhat` package, and the helper's constant for it. */
const CLI_PATH = "hardhat/dist/src/cli.js";
const CLI_CONSTANT = "HARDHAT_CLI";

function field(node: unknown, name: string): unknown {
  return typeof node === "object" && node !== null ? Reflect.get(node, name) : undefined;
}

/** Calls `visit` on every node of an AST, parents first. */
function walk(node: unknown, visit: (node: object) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, visit);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  if (typeof field(node, "type") === "string") {
    visit(node);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== "parent" && typeof child === "object" && child !== null) {
      walk(child, visit);
    }
  }
}

/** The name a function is called by: `spawnSync` for both `spawnSync(...)` and `cp.spawnSync(...)`. */
function calleeName(callee: unknown): string | undefined {
  const type = field(callee, "type");
  if (type === "Identifier") {
    const name = field(callee, "name");
    return typeof name === "string" ? name : undefined;
  }
  if (type === "MemberExpression" && field(callee, "computed") !== true) {
    const name = field(field(callee, "property"), "name");
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

/** Whether a subtree names the Hardhat CLI, in a string, a template or the helper's constant. */
function namesHardhatCli(node: unknown): boolean {
  let found = false;
  walk(node, (child) => {
    const type = field(child, "type");
    const value = field(child, "value");
    if (type === "Identifier" && field(child, "name") === CLI_CONSTANT) {
      found = true;
    } else if (type === "Literal" && typeof value === "string" && value.includes(CLI_PATH)) {
      found = true;
    } else if (type === "TemplateElement") {
      const raw = field(value, "raw");
      if (typeof raw === "string" && raw.includes(CLI_PATH)) {
        found = true;
      }
    }
  });
  return found;
}

/**
 * The `spawnSync` calls in a test file that start the Hardhat CLI.
 *
 * @param file - The file's path, for the messages.
 * @param source - Its TypeScript source.
 * @returns One message per call, with its line, or one when the file does not parse.
 */
function hardhatSpawnSyncProblems(file: string, source: string): string[] {
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) {
    return [`${file}: cannot parse (${parsed.errors[0]?.message ?? "unknown error"})`];
  }
  const problems: string[] = [];
  walk(parsed.program, (node) => {
    if (
      field(node, "type") === "CallExpression" &&
      calleeName(field(node, "callee")) === "spawnSync" &&
      namesHardhatCli(field(node, "arguments"))
    ) {
      const start = field(node, "start");
      const line = source.slice(0, typeof start === "number" ? start : 0).split("\n").length;
      problems.push(
        `${file}:${line}: spawnSync starts the Hardhat CLI; call runHardhat from packages/hardhat-kms/test/helpers/hardhat-cli.ts`,
      );
    }
  });
  return problems;
}

/** The integration test files of every package, as paths relative to the repository. */
function integrationTests(): string[] {
  const files = (directory: string): string[] =>
    readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        return files(relative);
      }
      return entry.name.endsWith(".test.ts") ? [relative] : [];
    });
  return readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        return files(path.posix.join("packages", entry.name, "test/integration"));
      } catch {
        return [];
      }
    });
}

const FILE = "packages/example/test/integration/example.test.ts";
const check = (source: string): string[] => hardhatSpawnSyncProblems(FILE, source);

describe("hardhatSpawnSyncProblems", () => {
  it("passes a spawnSync that starts a fixture script with Node", () => {
    const source = [
      'import { spawnSync } from "node:child_process";',
      'const result = spawnSync(process.execPath, [path.join(here, "../fixtures/run.ts")], {',
      '  encoding: "utf8",',
      "});",
      "",
    ].join("\n");
    assert.deepEqual(check(source), []);
  });

  it("passes a run through the helper", () => {
    const source = [
      'import { HARDHAT_CLI, runHardhat } from "../helpers/hardhat-cli.ts";',
      'const run = await runHardhat(["kms", "address"], { cwd: project });',
      'const node = spawn(process.execPath, [HARDHAT_CLI, "node"], { cwd: project });',
      "",
    ].join("\n");
    assert.deepEqual(check(source), []);
  });

  it("reports a spawnSync whose arguments name the CLI's path, with its line", () => {
    const source = [
      'import { spawnSync } from "node:child_process";',
      "",
      "const result = spawnSync(",
      "  process.execPath,",
      '  [path.join(repo, "node_modules/hardhat/dist/src/cli.js"), ...args],',
      "  { cwd: project },",
      ");",
      "",
    ].join("\n");
    assert.deepEqual(check(source), [
      `${FILE}:3: spawnSync starts the Hardhat CLI; call runHardhat from packages/hardhat-kms/test/helpers/hardhat-cli.ts`,
    ]);
  });

  it("reports the path in a template literal and the helper's constant", () => {
    const source = [
      "spawnSync(process.execPath, [`${repo}/node_modules/hardhat/dist/src/cli.js`]);",
      "child_process.spawnSync(process.execPath, [HARDHAT_CLI, ...args]);",
      "",
    ].join("\n");
    assert.equal(check(source).length, 2);
  });

  it("reports a file that does not parse", () => {
    assert.equal(check("const = ;\n").length, 1);
  });
});

describe("the integration tests", () => {
  it("start the Hardhat CLI through runHardhat, not spawnSync", () => {
    const files = integrationTests();
    assert.ok(files.length > 0, "no integration test found");
    const problems = files.flatMap((file) =>
      hardhatSpawnSyncProblems(file, readFileSync(path.join(root, file), "utf8")),
    );
    assert.deepEqual(problems, []);
  });
});
