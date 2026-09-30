import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BUILTIN_PROVIDERS, builtinProvider } from "../../../src/internal/providers/registry.ts";

describe("provider registry", () => {
  it("lists the first-party providers and where each adapter comes from", () => {
    assert.deepEqual(Object.keys(BUILTIN_PROVIDERS), ["aws", "gcp", "azure"]);
    for (const [id, provider] of Object.entries(BUILTIN_PROVIDERS)) {
      assert.equal(provider.id, id);
    }
    assert.deepEqual(builtinProvider("aws")?.adapter, { package: "hardhat-kms-aws" });
    assert.deepEqual(builtinProvider("gcp")?.adapter, { issue: 29 });
    assert.deepEqual(builtinProvider("azure")?.adapter, { issue: 30 });
  });

  it("returns nothing for third-party ids and Object.prototype names", () => {
    for (const id of ["myvault", "constructor", "toString", "__proto__"]) {
      assert.equal(builtinProvider(id), undefined, id);
    }
  });

  it("cannot be modified at run time", () => {
    assert.ok(Object.isFrozen(BUILTIN_PROVIDERS));
    for (const provider of Object.values(BUILTIN_PROVIDERS)) {
      assert.ok(Object.isFrozen(provider) && Object.isFrozen(provider.adapter), provider.id);
    }
  });
});
