// withOverrides, which scripts/test-sdk-floors.ts uses to add the SDK floors to the overrides that
// pnpm-workspace.yaml already has. Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { parse } from "yaml";

import { root, withOverrides } from "../../scripts/temporary-install.ts";

const overridesOf = (text: string): unknown => Reflect.get(Object(parse(text)), "overrides");

describe("withOverrides", () => {
  it("adds an overrides map to a file that has none", () => {
    const text = withOverrides("packages:\n  - packages/*\n", { "google-gax": "6.5.0" });
    assert.deepEqual(overridesOf(text), { "google-gax": "6.5.0" });
    assert.match(text, /^packages:\n {2}- packages\/\*\n/);
  });

  it("keeps the overrides and comments the file has", () => {
    const committed = [
      "packages:",
      "  - packages/*",
      "",
      "# Security overrides.",
      "overrides:",
      "  # Pinned upstream.",
      "  axios: 1.20.0",
      '  "typed-rest-client>qs": ^6.16.0',
      "",
    ].join("\n");
    const text = withOverrides(committed, { "google-gax": "6.5.0", viem: "2.55.13" });
    assert.deepEqual(overridesOf(text), {
      axios: "1.20.0",
      "typed-rest-client>qs": "^6.16.0",
      "google-gax": "6.5.0",
      viem: "2.55.13",
    });
    assert.match(text, /# Security overrides\.\noverrides:\n {2}# Pinned upstream\.\n/);
  });

  it("refuses an entry that replaces an override the file has", () => {
    assert.throws(
      () => withOverrides("overrides:\n  axios: 1.20.0\n", { axios: "1.13.5" }),
      /already overrides axios/,
    );
  });

  it("adds the floors to the committed pnpm-workspace.yaml", () => {
    const committed = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
    const before = overridesOf(committed);
    const text = withOverrides(committed, { "google-gax": "6.5.0" });
    assert.deepEqual(overridesOf(text), { ...Object(before), "google-gax": "6.5.0" });
  });
});
