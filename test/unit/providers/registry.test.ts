import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import { BUILTIN_PROVIDERS, builtinProvider } from "../../../src/internal/providers/registry.ts";

describe("provider registry", () => {
  it("lists the built-in providers and the SDKs each one needs", () => {
    assert.deepEqual(Object.keys(BUILTIN_PROVIDERS), ["aws", "gcp", "azure"]);
    assert.deepEqual(
      builtinProvider("aws")?.sdks.map((sdk) => sdk.packageName),
      ["@aws-sdk/client-kms"],
    );
    assert.deepEqual(
      builtinProvider("gcp")?.sdks.map((sdk) => sdk.packageName),
      ["@google-cloud/kms"],
    );
    assert.deepEqual(
      builtinProvider("azure")?.sdks.map((sdk) => sdk.packageName),
      ["@azure/keyvault-keys", "@azure/identity"],
    );
    for (const provider of Object.values(BUILTIN_PROVIDERS)) {
      for (const sdk of provider.sdks) {
        assert.match(sdk.range, /^\^\d+\.\d+\.\d+$/, `${provider.id} ${sdk.packageName}`);
      }
    }
  });

  it("returns nothing for third-party ids and Object.prototype names", () => {
    for (const id of ["myvault", "constructor", "toString", "__proto__"]) {
      assert.equal(builtinProvider(id), undefined, id);
    }
  });

  it("cannot be modified at run time", () => {
    assert.ok(Object.isFrozen(BUILTIN_PROVIDERS));
  });

  it("says which issue tracks each adapter that is not written yet", async () => {
    for (const [id, issue] of [
      ["aws", 16],
      ["gcp", 29],
      ["azure", 30],
    ] as const) {
      await assert.rejects(builtinProvider(id)?.load() ?? Promise.resolve(), (error: unknown) => {
        assert.ok(error instanceof HardhatPluginError);
        assert.ok(error.message.includes(`issues/${issue}`), error.message);
        return true;
      });
    }
  });
});
