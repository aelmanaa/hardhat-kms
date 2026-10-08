// The live suite's mode and package-source switches and the anvil lookup. Runs offline, in
// `pnpm test`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { findAnvil } from "./helpers/anvil.ts";
import { liveMode, liveSource, MODE_VARIABLE, SOURCE_VARIABLE } from "./helpers/mode.ts";

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

  it("runs the checkout's packages unless a registry version is asked for", () => {
    assert.deepEqual(liveSource({}), { kind: "source" });
    assert.deepEqual(liveSource({ [SOURCE_VARIABLE]: "" }), { kind: "source" });
    assert.deepEqual(liveSource({ [SOURCE_VARIABLE]: " source " }), { kind: "source" });
    assert.deepEqual(liveSource({ [SOURCE_VARIABLE]: "registry:0.9.0" }), {
      kind: "registry",
      version: "0.9.0",
    });
    assert.deepEqual(liveSource({ [SOURCE_VARIABLE]: "registry:1.0.0-beta.1" }), {
      kind: "registry",
      version: "1.0.0-beta.1",
    });
  });

  it("refuses any other package source, a range or a tag included", () => {
    for (const value of [
      "registry",
      "registry:",
      "registry:^1.0.0",
      "registry:latest",
      "registry:1.0",
      "npm:1.0.0",
      "Source",
      "dist",
    ]) {
      assert.throws(
        () => liveSource({ [SOURCE_VARIABLE]: value }),
        /must be "source" or "registry:<exact version>"/,
        value,
      );
    }
  });

  it("finds anvil on PATH first, then in ~/.foundry/bin", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hardhat-kms-anvil-"));
    try {
      const home = path.join(directory, "home");
      const bin = path.join(directory, "bin");
      const foundry = path.join(home, ".foundry", "bin");
      // The name findAnvil looks for on this platform.
      const name = process.platform === "win32" ? "anvil.exe" : "anvil";
      for (const folder of [bin, foundry]) {
        mkdirSync(folder, { recursive: true });
        writeFileSync(path.join(folder, name), "");
      }
      assert.equal(findAnvil({ PATH: bin, HOME: home }), path.join(bin, name));
      assert.equal(findAnvil({ PATH: directory, HOME: home }), path.join(foundry, name));
      assert.equal(findAnvil({ PATH: directory, HOME: directory }), undefined);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
