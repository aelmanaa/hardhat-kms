import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import { checkProviderVersion, versionMismatch } from "../../../src/internal/providers/version.ts";

const coreVersion = String(
  Reflect.get(
    Object(JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"))),
    "version",
  ),
);

describe("provider version check", () => {
  it("accepts a provider package of the installed hardhat-kms version", () => {
    checkProviderVersion("hardhat-kms-aws", coreVersion);
    assert.equal(versionMismatch("hardhat-kms-aws", "0.3.1", "0.3.1"), undefined);
    // Build metadata does not make a different release.
    assert.equal(versionMismatch("hardhat-kms-aws", "0.3.1+build.5", "0.3.1"), undefined);
  });

  it("fails with both versions, the given details and an install command", () => {
    assert.throws(
      () =>
        checkProviderVersion("hardhat-kms-aws", "999.0.0", {
          provider: "aws",
          operation: "create adapter",
          key: "aws:alias/a",
        }),
      (error: unknown) => {
        assert.ok(error instanceof HardhatPluginError, String(error));
        assert.ok(
          error.message.includes(
            `aws, create adapter, key aws:alias/a: hardhat-kms-aws 999.0.0 needs hardhat-kms 999.0.0, but hardhat-kms ${coreVersion} is installed`,
          ),
          error.message,
        );
        assert.ok(error.message.includes("hardhat-kms@999.0.0 hardhat-kms-aws@999.0.0"));
        return true;
      },
    );
  });

  it("recommends the newer version, compared numerically", () => {
    for (const [provider, core, target] of [
      ["0.1.0", "0.2.0", "0.2.0"],
      ["1.10.0", "1.9.3", "1.10.0"],
      ["0.2.1", "0.2.0", "0.2.1"],
    ] as const) {
      assert.match(
        versionMismatch("hardhat-kms-aws", provider, core) ?? "",
        new RegExp(`hardhat-kms@${target} hardhat-kms-aws@${target}\``),
        `${provider} / ${core}`,
      );
    }
  });

  it("recommends the release over its prerelease, and nothing for versions it cannot read", () => {
    for (const [provider, core] of [
      ["1.0.0-rc.1", "1.0.0"],
      ["1.0.0", "1.0.0-rc.1"],
    ] as const) {
      assert.match(
        versionMismatch("hardhat-kms-aws", provider, core) ?? "",
        /@1\.0\.0 hardhat-kms-aws@1\.0\.0`/,
      );
    }
    assert.match(
      versionMismatch("hardhat-kms-aws", "next", "0.2.0") ?? "",
      /hardhat-kms-aws next needs hardhat-kms next, but hardhat-kms 0\.2\.0 is installed\. Install the same version of both$/,
    );
  });
});
