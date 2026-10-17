import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configVariable } from "hardhat/config";

import { fakeResolver } from "../../helpers/config-variables.ts";

// A logger reads DEBUG when it is created, and the config modules create theirs when they load,
// so DEBUG is set before they are imported. Each test file runs in its own process.
process.env.DEBUG = "hardhat:kms:config";
process.env.DEBUG_COLORS = "no";
const { resolveKmsConfig } = await import("../../../src/internal/config/resolve.ts");

describe("Turnkey config debug lines", () => {
  it("name the config path of an API key variable that cannot be read, never a value", async () => {
    const key = resolveKmsConfig(
      {
        kms: {
          keys: {
            a: {
              provider: "turnkey",
              organizationId: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
              address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
              apiPrivateKey: configVariable("TK_PRIVATE"),
              apiPublicKey: configVariable("TK_PUBLIC"),
            },
          },
        },
      },
      fakeResolver({}),
    ).keys.a;
    assert.ok(key?.provider === "turnkey");

    let written = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      written += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    };
    try {
      await assert.rejects(key.apiPrivateKey.get(), /Missing configuration variable TK_PRIVATE/);
      await assert.rejects(
        key.apiPublicKey?.get() ?? Promise.resolve(),
        /Missing configuration variable TK_PUBLIC/,
      );
    } finally {
      process.stderr.write = original;
    }
    assert.match(written, /kms\.keys\.a\.apiPrivateKey: reading <TK_PRIVATE> failed \(Error\)/);
    assert.match(written, /kms\.keys\.a\.apiPublicKey: reading <TK_PUBLIC> failed \(Error\)/);
  });
});
