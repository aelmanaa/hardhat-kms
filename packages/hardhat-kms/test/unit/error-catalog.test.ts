import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ENTRIES, ERRORS } from "../../src/internal/error-catalog.ts";
import { catalogError } from "../../src/internal/errors.ts";

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** The placeholders of a template, in order. */
const placeholders = (template: string) =>
  [...template.matchAll(PLACEHOLDER)].map((match) => match[1]);

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

  it("names the two types of a refused send and nothing else from the request (#496)", () => {
    assert.equal(ERRORS.txRequestTypeMismatch.id, "core.tx.type-mismatch");
    assert.equal(ERRORS.txUnsupportedType.id, "core.tx.unsupported-type");
    assert.deepEqual(placeholders(ERRORS.txRequestTypeMismatch.template), [
      "requested",
      "actual",
      "requested",
    ]);
    assert.deepEqual(placeholders(ERRORS.txUnsupportedType.template), ["type"]);
    assert.equal(
      catalogError(
        ERRORS.txRequestTypeMismatch,
        { requested: "0x2 (eip1559)", actual: "0x0 (legacy)" },
        { operation: "eth_sendTransaction" },
      ).message,
      "eth_sendTransaction: the transaction asks for type 0x2 (eip1559), but its fields make it type 0x0 (legacy); nothing was signed. Set the fee fields of type 0x2 (eip1559), add accessList: [] for type 0x1, or remove type.",
    );
    assert.equal(
      catalogError(ERRORS.txUnsupportedType, { type: "0x7e" }, { operation: "eth_signTransaction" })
        .message,
      "eth_signTransaction: transaction type 0x7e is not supported; KMS accounts sign types 0x0, 0x1, 0x2 and 0x4. Nothing was signed.",
    );
  });
});
