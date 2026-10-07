// The clean-up of the CLI tests' projects: a project is removed only after its child has exited, so
// the removal does not fail on Windows with EBUSY (#326), and only a project the helper created is
// removed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
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

  it("refuses a path it did not create, and a project it removed already", async () => {
    const project = createTempProject("temp-project-");
    await assert.rejects(
      removeTempProject(path.join(path.dirname(project), "temp-project-other")),
      /refusing to remove .*createTempProject did not create it/,
    );
    await assert.rejects(
      removeTempProject(`${project}${path.sep}`),
      /refusing to remove/,
      "a spelling of the path that is not the one it returned",
    );
    await removeTempProject(project);
    await assert.rejects(removeTempProject(project), /refusing to remove/);
  });

  it("refuses a prefix that names another directory", () => {
    for (const prefix of ["../x-", "a/b-", "", "x", "X-"]) {
      assert.throws(() => createTempProject(prefix), /a project prefix is/, prefix);
    }
  });
});
