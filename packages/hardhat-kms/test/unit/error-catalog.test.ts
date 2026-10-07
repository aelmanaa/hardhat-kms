import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ENTRIES, ERRORS } from "../../src/internal/error-catalog.ts";

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

describe("the core error catalogue", () => {
  it("lists every entry once", () => {
    assert.equal(ENTRIES.length, Object.keys(ERRORS).length);
  });

  it("gives each entry a unique id in the core namespace", () => {
    const ids = ENTRIES.map((entry) => entry.id);
    const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual(repeated, []);
    for (const id of ids) {
      assert.match(id, /^core\.[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("gives each entry a group, a template, a cause and a fix", () => {
    for (const entry of ENTRIES) {
      for (const field of ["group", "template", "cause", "fix"] as const) {
        assert.notEqual(entry[field].trim(), "", `${entry.id} has an empty ${field}`);
      }
    }
  });

  it("puts no URL in a message, apart from the issue links and the AWS endpoint example", () => {
    const withUrl = ENTRIES.filter((entry) => /https?:\/\//.test(entry.template)).map(
      (entry) => entry.id,
    );
    // The issue link of a planned provider, in the config check and when an adapter is built, and
    // the LocalStack example of an AWS endpoint.
    assert.deepEqual(withUrl.toSorted(), [
      "core.config.aws-endpoint",
      "core.config.provider-reserved",
      "core.provider.not-available",
    ]);
  });

  it("has no placeholder for a key id, a URL or a secret", () => {
    for (const entry of ENTRIES) {
      const names = [...entry.template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");
      for (const name of names) {
        assert.doesNotMatch(name, /^(?:key|keyId|arn|url|secret|token|password)$/i, entry.id);
      }
    }
  });
});
