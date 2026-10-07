// The clean-up of the CLI tests' projects: a project is removed only after its child has exited, so
// the removal does not fail on Windows with EBUSY (#326), and only a project the helper created is
// removed. The first test checks the order on every OS; only Windows would fail without it.
import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { endChild, endWithTestProcess } from "../helpers/hardhat-cli.ts";
import { createTempProject, removeTempProject } from "../helpers/temp-project.ts";

/** Opens a file in its working directory, prints OPEN, and runs until it is ended. */
const HOLDER = `
const { openSync } = require("node:fs");
openSync("held.txt", "w");
console.log("OPEN");
setInterval(() => {}, 1000);
`;

describe("the CLI tests' projects", () => {
  it("is removed once the child that runs in it has ended", async () => {
    const project = createTempProject("temp-project-");
    const child = spawn(process.execPath, ["-e", HOLDER], {
      cwd: project,
      stdio: ["ignore", "pipe", "inherit"],
    });
    endWithTestProcess(child);
    child.stdout.setEncoding("utf8");
    const [line] = await once(child.stdout, "data");
    assert.equal(String(line).trim(), "OPEN");

    await endChild(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "the child has exited");
    await removeTempProject(project);
    assert.equal(existsSync(project), false);
    // A child that has exited already is not an error.
    await endChild(child);
  });

  it(
    "returns at once for a child that never started, and signals nothing",
    { timeout: 5_000 },
    async () => {
      // An unspawned ChildProcess has no pid. kill() is replaced, so the test cannot signal anything.
      const child = new ChildProcess();
      const signals: unknown[] = [];
      child.kill = (signal?: NodeJS.Signals | number): boolean => {
        signals.push(signal);
        return false;
      };
      assert.equal(child.pid, undefined);
      await endChild(child);
      assert.deepEqual(signals, []);
    },
  );

  it("refuses a path it did not create, and a project it removed already", async () => {
    const project = createTempProject("temp-project-");
    await assert.rejects(
      removeTempProject(path.join(path.dirname(project), "temp-project-other")),
      /refusing to remove .*createTempProject did not create it/,
    );
    const others = [
      "",
      `${project}${path.sep}`,
      path.join(project, ".."),
      path.relative(process.cwd(), project),
    ];
    for (const other of others) {
      await assert.rejects(removeTempProject(other), /refusing to remove/, JSON.stringify(other));
    }
    // A link to the project is another path, and is refused too.
    const link = `${project}-link`;
    symlinkSync(project, link, "junction");
    try {
      await assert.rejects(removeTempProject(link), /refusing to remove/);
    } finally {
      await rm(link, { force: true });
    }
    await removeTempProject(project);
    await assert.rejects(removeTempProject(project), /refusing to remove/);
  });

  it("refuses a prefix that is not lowercase words ending in -", () => {
    for (const prefix of ["../x-", "a/b-", "", "x", "X-"]) {
      assert.throws(() => createTempProject(prefix), /a project prefix is/, prefix);
    }
  });
});
