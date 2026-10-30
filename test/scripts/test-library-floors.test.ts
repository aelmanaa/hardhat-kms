// The runs scripts/test-library-floors.ts makes from each Hardhat library's floors (#587).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { floorRuns } from "../../scripts/test-library-floors.ts";

describe("floorRuns", () => {
  it("runs every first floor together, then each further floor with the others at their first", () => {
    assert.deepEqual(
      floorRuns({
        "@nomicfoundation/hardhat-errors": ["3.1.0"],
        "@nomicfoundation/hardhat-utils": ["4.3.0", "5.0.0"],
        "@nomicfoundation/hardhat-zod-utils": ["3.0.7"],
      }),
      [
        {
          "@nomicfoundation/hardhat-errors": "3.1.0",
          "@nomicfoundation/hardhat-utils": "4.3.0",
          "@nomicfoundation/hardhat-zod-utils": "3.0.7",
        },
        {
          "@nomicfoundation/hardhat-errors": "3.1.0",
          "@nomicfoundation/hardhat-utils": "5.0.0",
          "@nomicfoundation/hardhat-zod-utils": "3.0.7",
        },
      ],
    );
  });

  it("makes one run when each library has one floor", () => {
    assert.deepEqual(floorRuns({ a: ["1.0.0"], b: ["2.0.0"] }), [{ a: "1.0.0", b: "2.0.0" }]);
  });

  it("refuses a library with no floor", () => {
    assert.throws(() => floorRuns({ a: [] }), /a has no floor/);
  });
});
