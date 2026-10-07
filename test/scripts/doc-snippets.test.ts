// The snippet checks of `pnpm run docs:check` (`scripts/doc-snippets.ts`) on fixture pages: a call
// of an API marked `@deprecated` fails with the Markdown file and line, a config that typechecks but
// fails Hardhat's validation fails with the line of its fence, a skipped snippet is not checked,
// and current APIs and valid configs pass.
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

  it("reports a config that typechecks but does not load in Hardhat, and skips a marked one", () => {
    const problems = checkSnippets([`${FIXTURES}/config-invalid.md`], directory);
    assert.equal(problems.length, 2, problems.join("\n"));
    assert.match(
      problems[0] ?? "",
      /^test\/scripts\/fixtures\/doc-snippets\/config-invalid\.md:5: the config does not load in Hardhat: HHE15: Invalid config:\n\t\* Config error in config\.kms\.keys\.deployer\.address: Expected a 0x-prefixed 20-byte address/,
    );
    assert.match(
      problems[1] ?? "",
      /^test\/scripts\/fixtures\/doc-snippets\/config-invalid\.md:24: the config does not load in Hardhat: HHE15: Invalid config:\n\t\* Config error in config\.networks\.sepolia\.kmsAccounts\.0: .*deploer/,
    );
    assert.equal(existsSync(directory), false);
  });

  it("loads a valid config, ignoring Hardhat's environment variables", () => {
    const previous = process.env.HARDHAT_KMS;
    // A value that would fail the runtime's creation if the check passed it on.
    process.env.HARDHAT_KMS = "not-a-provider";
    try {
      assert.deepEqual(checkSnippets([`${FIXTURES}/config-valid.md`], directory), []);
    } finally {
      if (previous === undefined) {
        delete process.env.HARDHAT_KMS;
      } else {
        process.env.HARDHAT_KMS = previous;
      }
    }
  });

  it("passes when there is no snippet", () => {
    assert.deepEqual(checkSnippets([], directory), []);
  });
});
