// withOverrides, which scripts/test-sdk-floors.ts uses to add the SDK floors to the overrides that
// pnpm-workspace.yaml already has. Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { parse } from "yaml";

import { overrideTarget, root, withOverrides } from "../../scripts/temporary-install.ts";

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

  it("refuses an entry whose package an override forces under a parent or a range", () => {
    const cases: [string, string][] = [
      ['"@google-cloud/kms>google-gax": 6.11.1', "google-gax"],
      ['"typed-rest-client>qs": ^6.16.0', "qs"],
      ['"viem@<2.60": 2.60.0', "viem"],
      ['"a>@azure/identity@^4": 4.13.3', "@azure/identity"],
    ];
    for (const [line, name] of cases) {
      assert.throws(
        () => withOverrides(`overrides:\n  ${line}\n`, { [name]: "1.0.0" }, [name]),
        new RegExp(`already overrides ${name.replaceAll("/", String.raw`\/`)} `),
        line,
      );
    }
  });

  it("replaces a plain override it may replace, keeping what was added since", () => {
    const current = [
      "overrides:",
      "  axios: 1.20.0",
      '  "google-gax": "6.5.0"',
      "  viem: 2.55.13",
      "minimumReleaseAgeExclude:",
      "  - google-gax",
      "",
    ].join("\n");
    const text = withOverrides(current, { "google-gax": "6.5.0", viem: "2.55.11" }, [
      "google-gax",
      "viem",
    ]);
    assert.deepEqual(overridesOf(text), {
      axios: "1.20.0",
      "google-gax": "6.5.0",
      viem: "2.55.11",
    });
    assert.deepEqual(Reflect.get(Object(parse(text)), "minimumReleaseAgeExclude"), ["google-gax"]);
    assert.throws(
      () => withOverrides(current, { axios: "1.13.5" }, ["viem"]),
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

describe("overrideTarget", () => {
  it("names the package an override key forces", () => {
    assert.equal(overrideTarget("qs"), "qs");
    assert.equal(overrideTarget("typed-rest-client>qs"), "qs");
    assert.equal(overrideTarget("qs@<6.16"), "qs");
    assert.equal(overrideTarget("@scope/name"), "@scope/name");
    assert.equal(overrideTarget("a>b>@scope/name@^1"), "@scope/name");
  });
});
