// The helper the debug-log tests read their lines with.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { debugLines } from "../helpers/debug-lines.ts";

describe("debugLines", () => {
  it("removes the timing suffix, a negative one too", () => {
    const written = [
      "  hardhat:kms:signer first +0ms",
      "  hardhat:kms:signer second +12ms",
      "  hardhat:kms:signer third +-13ms",
      "  hardhat:kms:signer fourth +1500ms",
      "",
    ].join("\n");

    assert.deepEqual(debugLines(written, "hardhat:kms:signer"), [
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("keeps a line without a suffix whole, and a +ms inside the message", () => {
    const written = "  hardhat:kms:rpc took +5ms to answer\n  hardhat:kms:rpc done";

    assert.deepEqual(debugLines(written, "hardhat:kms:rpc"), ["took +5ms to answer", "done"]);
  });

  it("keeps only the lines under the namespace", () => {
    const written = [
      "  hardhat:kms:signer mine +1ms",
      "  hardhat:kms:signers not mine +1ms",
      "  hardhat:kms:rpc not mine either +1ms",
      "something else",
    ].join("\n");

    assert.deepEqual(debugLines(written, "hardhat:kms:signer"), ["mine"]);
  });
});
