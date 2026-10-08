// The npm 11 and npm 12 parsing of `npm view --json` output (`scripts/npm-view.ts`), fed with
// output npm 12.2.0 printed, trimmed to a few versions. Runs in `pnpm test`, with no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parsePublishTimes } from "../../scripts/npm-view.ts";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/registry-release",
);

describe("parsePublishTimes", () => {
  it("reads npm 12's one-element array and npm 11's bare object alike", () => {
    const npm12 = readFileSync(path.join(FIXTURES, "view-time-hardhat-npm12.json"), "utf8");
    const times = parsePublishTimes("hardhat", npm12);
    assert.equal(times["3.19.0"], "2026-10-08T16:18:47.618Z");
    assert.equal(times["3.0.0"], "2025-08-13T19:31:16.438Z");
    const parsed: unknown = JSON.parse(npm12);
    assert.ok(Array.isArray(parsed));
    assert.deepEqual(parsePublishTimes("hardhat", JSON.stringify(parsed[0])), times);
  });

  it("refuses another array, a non-object and npm's error, naming the command", () => {
    assert.throws(() => parsePublishTimes("hardhat", "[{}, {}]"), {
      message:
        "npm view hardhat time printed an array of 2 entries; expected one value or a one-element array",
    });
    assert.throws(() => parsePublishTimes("hardhat", '"x"'), {
      message: 'npm view hardhat time printed "x", not an object of publish times',
    });
    assert.throws(() => parsePublishTimes("hardhat", '[{"error":{"code":"E404"}}]'), {
      message: 'npm view hardhat time failed: {"code":"E404"}',
    });
  });
});
