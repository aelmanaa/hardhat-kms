// The live suite's mode switch and anvil lookup. Runs offline, in `pnpm test`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { findAnvil } from "./helpers/anvil.ts";
import { liveMode, MODE_VARIABLE } from "./helpers/mode.ts";

describe("live test mode", () => {
  it("runs on the fork unless real Sepolia is asked for", () => {
    assert.equal(liveMode({}), "fork");
    assert.equal(liveMode({ [MODE_VARIABLE]: "" }), "fork");
    assert.equal(liveMode({ [MODE_VARIABLE]: " fork " }), "fork");
    assert.equal(liveMode({ [MODE_VARIABLE]: "sepolia" }), "sepolia");
    assert.equal(liveMode({ [MODE_VARIABLE]: "Sepolia" }), "sepolia");
  });

  it("refuses any other value", () => {
    for (const value of ["mainnet", "live", "true", "sepolia-fork"]) {
      assert.throws(() => liveMode({ [MODE_VARIABLE]: value }), /must be "fork" or "sepolia"/);
    }
  });

  it("finds anvil on PATH first, then in ~/.foundry/bin", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hardhat-kms-anvil-"));
    try {
      const home = path.join(directory, "home");
      const bin = path.join(directory, "bin");
      const foundry = path.join(home, ".foundry", "bin");
      for (const folder of [bin, foundry]) {
        mkdirSync(folder, { recursive: true });
        writeFileSync(path.join(folder, "anvil"), "");
      }
      assert.equal(findAnvil({ PATH: bin, HOME: home }), path.join(bin, "anvil"));
      assert.equal(findAnvil({ PATH: directory, HOME: home }), path.join(foundry, "anvil"));
      assert.equal(findAnvil({ PATH: directory, HOME: directory }), undefined);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
