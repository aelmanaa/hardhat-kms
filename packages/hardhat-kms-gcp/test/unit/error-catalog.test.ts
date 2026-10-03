import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ENTRIES, ERRORS } from "../../src/internal/error-catalog.ts";

describe("the @hardhat-kms/gcp error catalogue", () => {
  it("lists every entry once, with a unique id in the gcp namespace", () => {
    assert.equal(ENTRIES.length, Object.keys(ERRORS).length);
    const ids = ENTRIES.map((entry) => entry.id);
    assert.deepEqual(
      ids.filter((id, index) => ids.indexOf(id) !== index),
      [],
    );
    for (const id of ids) {
      assert.match(id, /^gcp\.[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("gives each entry a group, a template, a cause and a fix", () => {
    for (const entry of ENTRIES) {
      for (const field of ["group", "template", "cause", "fix"] as const) {
        assert.notEqual(entry[field].trim(), "", `${entry.id} has an empty ${field}`);
      }
    }
  });

  it("puts no URL in a message", () => {
    assert.deepEqual(
      ENTRIES.filter((entry) => /https?:\/\//.test(entry.template)).map((entry) => entry.id),
      [],
    );
  });
});
