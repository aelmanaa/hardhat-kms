// The snippet checks of `pnpm run docs:check` (`scripts/doc-snippets.ts`) on fixture pages: a call
// of an API marked `@deprecated` fails with the Markdown file and line, a skipped snippet is not
// checked, and current APIs pass.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkSnippets } from "../../scripts/doc-snippets.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = "test/scripts/fixtures/doc-snippets";
// Inside the root, so the snippets resolve its dependencies; apart from `.docs-check`, so a
// concurrent `pnpm run docs:check` does not remove it.
const directory = path.join(root, `.docs-check-test-${String(process.pid)}`);

describe("checkSnippets", () => {
  it("reports a deprecated call with its Markdown line, and skips a marked snippet", () => {
    const problems = checkSnippets([`${FIXTURES}/deprecated.md`], directory);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(
      problems[0] ?? "",
      /^test\/scripts\/fixtures\/doc-snippets\/deprecated\.md:8: typescript\(no-deprecated\): `connect` is deprecated\./,
    );
    assert.equal(existsSync(directory), false);
  });

  it("passes snippets that call no deprecated API", () => {
    assert.deepEqual(checkSnippets([`${FIXTURES}/current.md`], directory), []);
  });

  it("passes when there is no snippet", () => {
    assert.deepEqual(checkSnippets([], directory), []);
  });
});
