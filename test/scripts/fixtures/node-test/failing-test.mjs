// One failing test, for the exit code.
import assert from "node:assert/strict";
import { test } from "node:test";

test("failing test", () => {
  assert.equal(1, 2);
});
