import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import { PLUGIN_ID } from "../../src/internal/constants.ts";
import {
  catalogError,
  catalogMessage,
  fillTemplate,
  internalError,
  kmsError,
} from "../../src/internal/errors.ts";

describe("kmsError", () => {
  it("prefixes the message with the provider, operation and key", () => {
    const error = kmsError("boom", { provider: "aws", operation: "sign", key: "alias/deployer" });

    assert.ok(error instanceof HardhatPluginError);
    assert.equal(error.pluginId, PLUGIN_ID);
    assert.equal(error.message, "aws, sign, key alias/deployer: boom");
  });

  it("omits missing context", () => {
    assert.equal(kmsError("boom").message, "boom");
    assert.equal(kmsError("boom", { operation: "sign" }).message, "sign: boom");
  });
});

describe("catalogue helpers", () => {
  const entry = {
    id: "core.test.entry",
    kind: "error",
    group: "Tests",
    template: "the key derives to {address}, a list of {name, type} for {count} keys",
    cause: "A test.",
    fix: "None.",
  } as const;

  it("fills each placeholder and keeps braces around anything else", () => {
    assert.equal(
      fillTemplate(entry.template, { address: "0xabc", count: 2n }),
      "the key derives to 0xabc, a list of {name, type} for 2 keys",
    );
    assert.equal(fillTemplate("no placeholders {", {}), "no placeholders {");
    assert.equal(fillTemplate("{a}{b}", { a: 1, b: "x" }), "1x");
  });

  it("builds a plugin error with kmsError's prefix", () => {
    const error = catalogError(entry, { address: "0xabc", count: 1 }, { operation: "sign" });

    assert.ok(error instanceof HardhatPluginError);
    assert.equal(
      error.message,
      "sign: the key derives to 0xabc, a list of {name, type} for 1 keys",
    );
  });

  it("builds the text of a reason, and a plain Error for an internal entry", () => {
    assert.equal(
      catalogMessage({ ...entry, kind: "reason" }, { address: "a", count: 0 }),
      "the key derives to a, a list of {name, type} for 0 keys",
    );
    const error = internalError(
      { ...entry, kind: "internal", template: "no value for {name}" },
      {
        name: "AWS_KMS_KEY_ID",
      },
    );
    assert.ok(!(error instanceof HardhatPluginError));
    assert.equal(error.message, "no value for AWS_KMS_KEY_ID");
  });
});
