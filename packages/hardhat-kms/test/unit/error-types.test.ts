import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const fixtures = fileURLToPath(new URL("../type-fixtures/", import.meta.url));
const tsc = fileURLToPath(new URL("../../../../node_modules/typescript/bin/tsc", import.meta.url));

describe("TemplateParams", () => {
  it("fails exactly the lines of the fixture marked `// compile error`", () => {
    const expected = readFileSync(`${fixtures}templates.ts`, "utf8")
      .split("\n")
      .flatMap((line, index) => (line.endsWith("// compile error") ? [index + 1] : []));
    const result = spawnSync(process.execPath, [tsc, "-p", fixtures, "--pretty", "false"], {
      encoding: "utf8",
    });
    const failed = [
      ...new Set(
        [...result.stdout.matchAll(/templates\.ts\((\d+),\d+\): error TS\d+/g)].map((match) =>
          Number(match[1]),
        ),
      ),
    ].toSorted((a, b) => a - b);
    assert.ok(expected.length > 0);
    assert.deepEqual(failed, expected, result.stdout);
  });
});
