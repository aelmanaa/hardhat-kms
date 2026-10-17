import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUILTIN_PROVIDERS,
  builtinProvider,
  RESERVED_PROVIDERS,
  reservedProvider,
} from "../../../src/internal/providers/registry.ts";

describe("provider registry", () => {
  it("lists the first-party providers and where each adapter comes from", () => {
    assert.deepEqual(Object.keys(BUILTIN_PROVIDERS), ["aws", "gcp", "azure", "turnkey"]);
    for (const [id, provider] of Object.entries(BUILTIN_PROVIDERS)) {
      assert.equal(provider.id, id);
    }
    assert.deepEqual(builtinProvider("aws")?.adapter, { package: "@hardhat-kms/aws" });
    assert.deepEqual(builtinProvider("gcp")?.adapter, { package: "@hardhat-kms/gcp" });
    assert.deepEqual(builtinProvider("azure")?.adapter, { package: "@hardhat-kms/azure" });
    assert.deepEqual(builtinProvider("turnkey")?.adapter, { package: "@hardhat-kms/turnkey" });
    assert.equal(builtinProvider("turnkey")?.name, "Turnkey");
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

  it("reserves fireblocks and pkcs11, in any case, with their tracking issues, and no longer turnkey", () => {
    assert.deepEqual(Object.keys(RESERVED_PROVIDERS), ["fireblocks", "pkcs11"]);
    assert.deepEqual(reservedProvider("fireblocks"), {
      id: "fireblocks",
      name: "Fireblocks",
      issue: 55,
    });
    assert.equal(reservedProvider("FIREBLOCKS"), RESERVED_PROVIDERS.fireblocks);
    assert.deepEqual(reservedProvider("pkcs11"), { id: "pkcs11", name: "PKCS#11 HSM", issue: 57 });
    assert.equal(reservedProvider("PKCS11"), RESERVED_PROVIDERS.pkcs11);
    assert.equal(reservedProvider("PkCs11"), RESERVED_PROVIDERS.pkcs11);
    for (const provider of Object.values(RESERVED_PROVIDERS)) {
      assert.ok(Object.isFrozen(provider), provider.id);
    }
    assert.ok(Object.isFrozen(RESERVED_PROVIDERS));
    for (const id of [
      "aws",
      "myvault",
      "turnkey",
      "Turnkey",
      "turnkeys",
      "fireblock",
      "pkcs",
      "pkcs#11",
      "constructor",
      "__proto__",
    ]) {
      assert.equal(reservedProvider(id), undefined, id);
    }
    for (const id of Object.keys(RESERVED_PROVIDERS)) {
      assert.equal(builtinProvider(id), undefined, id);
    }
    assert.ok(Object.isFrozen(RESERVED_PROVIDERS));
    for (const reserved of Object.values(RESERVED_PROVIDERS)) {
      assert.ok(Object.isFrozen(reserved), reserved.id);
    }
  });
});
