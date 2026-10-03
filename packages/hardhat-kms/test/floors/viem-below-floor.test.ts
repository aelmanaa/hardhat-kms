// getAccount against a real viem release below the floor of the peer range. Only
// scripts/test-sdk-floors.ts runs this file, after it installs viem 2.55.11; the regular test runs
// do not include this directory.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import { isObject } from "@nomicfoundation/hardhat-utils/lang";
import { HardhatPluginError } from "hardhat/plugins";

import { createKmsNetworkConnection } from "../../src/internal/viem/account.ts";
import { ADDRESS, kmsCalls, setup } from "../helpers/library-account.ts";

describe("getAccount with viem below the floor", () => {
  it("refuses the installed viem before any KMS call", async () => {
    const manifest: unknown = JSON.parse(
      readFileSync(createRequire(import.meta.url).resolve("viem/package.json"), "utf8"),
    );
    assert.ok(isObject(manifest) && typeof manifest.version === "string");
    const installed = manifest.version;
    assert.equal(installed, "2.55.11", "run by test-sdk-floors.ts with viem 2.55.11 installed");
    const { adapter, connection } = setup();
    await assert.rejects(
      async () => await createKmsNetworkConnection(connection).getAccount(ADDRESS),
      (error: unknown) => {
        assert.ok(error instanceof HardhatPluginError);
        assert.equal(
          error.message,
          `getAccount: connection.kms.getAccount needs viem 2.55.13 or later, and the project has viem ${installed}. Upgrade viem to 2.55.13 or later`,
        );
        return true;
      },
    );
    assert.equal(kmsCalls(adapter), 0);
  });
});
