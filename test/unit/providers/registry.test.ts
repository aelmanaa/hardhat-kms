import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import { BUILTIN_PROVIDERS, builtinProvider } from "../../../src/internal/providers/registry.ts";

describe("provider registry", () => {
  it("lists the built-in providers and the SDK versions each one supports", () => {
    assert.deepEqual(Object.keys(BUILTIN_PROVIDERS), ["aws", "gcp", "azure"]);
    for (const [id, provider] of Object.entries(BUILTIN_PROVIDERS)) {
      assert.equal(provider.id, id);
    }
    // These ranges are published in the configuration reference; change both together.
    assert.deepEqual(builtinProvider("aws")?.sdks, [
      { packageName: "@aws-sdk/client-kms", range: "^3.0.0" },
    ]);
    assert.deepEqual(builtinProvider("gcp")?.sdks, [
      { packageName: "@google-cloud/kms", range: "^6.0.0" },
    ]);
    assert.deepEqual(builtinProvider("azure")?.sdks, [
      { packageName: "@azure/keyvault-keys", range: "^4.0.0" },
      { packageName: "@azure/identity", range: "^4.0.0" },
    ]);
  });

  it("returns nothing for third-party ids and Object.prototype names", () => {
    for (const id of ["myvault", "constructor", "toString", "__proto__"]) {
      assert.equal(builtinProvider(id), undefined, id);
    }
  });

  it("cannot be modified at run time, down to each SDK entry", () => {
    assert.ok(Object.isFrozen(BUILTIN_PROVIDERS));
    for (const provider of Object.values(BUILTIN_PROVIDERS)) {
      assert.ok(Object.isFrozen(provider) && Object.isFrozen(provider.sdks), provider.id);
      assert.ok(
        provider.sdks.every((entry) => Object.isFrozen(entry)),
        provider.id,
      );
    }
  });

  it("loads the AWS adapter module", async () => {
    const module = await builtinProvider("aws")?.load();
    assert.equal(typeof module?.createKeyAdapter, "function");
  });

  it("says which issue tracks each adapter that is not written yet", async () => {
    for (const [id, issue, name] of [
      ["gcp", 29, "Google Cloud KMS"],
      ["azure", 30, "Azure Key Vault"],
    ] as const) {
      await assert.rejects(builtinProvider(id)?.load() ?? Promise.resolve(), (error: unknown) => {
        assert.ok(error instanceof HardhatPluginError);
        assert.ok(error.message.includes(`issues/${issue}`), error.message);
        assert.ok(error.message.includes(`signing with ${name} keys`), error.message);
        return true;
      });
    }
  });
});
