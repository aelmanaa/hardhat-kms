import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";

import { readTypedData } from "../../../src/internal/rpc/typed-data.ts";

/** The message of the error `readTypedData` throws for `text`. */
function refusal(text: string): string {
  let message = "";
  assert.throws(
    () => readTypedData(text, "kms sign"),
    (error: unknown) => {
      assert.ok(error instanceof HardhatPluginError, String(error));
      ({ message } = error);
      return true;
    },
  );
  return message;
}

describe("readTypedData", () => {
  it("names the key of a number above 2^53 - 1, and quotes none of its digits", () => {
    // A secrets file given by mistake: the number is refused before any shape check.
    const message = refusal('{"stripe_secret_pin": 4111111111111111111}');
    assert.ok(
      message ===
        'kms sign: the typed data is invalid: a number at key "stripe_secret_pin" is above 2^53 - 1, so JSON cannot hold it exactly; write it as a string',
      message,
    );
    assert.ok(!/411111/.test(message), message);
  });

  it("cuts a long key to 40 characters, and names an array index or the top level", () => {
    const key = `k${"y".repeat(60)}`;
    const long = refusal(`{"${key}": 9007199254740993}`);
    assert.ok(long.includes(`a number at key "${key.slice(0, 40)}" is above`), long);
    assert.ok(!long.includes(key.slice(0, 41)), long);
    const element = refusal("[1, 9007199254740993]");
    assert.ok(element.includes('a number at key "1" is above'), element);
    const top = refusal("9007199254740993");
    assert.ok(top.includes("a number at the top level is above"), top);
    for (const text of [long, element, top]) {
      assert.ok(!text.includes("900719925474099"), text);
    }
  });

  it("names the operation in its other refusals", () => {
    assert.equal(refusal("{"), "kms sign: the typed data is not valid JSON");
    // JSON.parse with a reviver recurses, so deep nesting overflows the stack.
    assert.equal(
      refusal(`${"[".repeat(100_000)}${"]".repeat(100_000)}`),
      "kms sign: the typed data could not be read (RangeError); it may be nested too deeply",
    );
    assert.equal(
      refusal('{"types": {}, "primaryType": 1, "domain": {}, "message": {}}'),
      "kms sign: the typed data is invalid: the typed data needs a string `primaryType` and object `domain` and `message`",
    );
  });

  it("reads safe integers and fractions as numbers", () => {
    assert.throws(
      () => readTypedData('{"a": 9007199254740991, "b": -9007199254740991, "c": 1.5}', "kms sign"),
      (error: unknown) =>
        error instanceof HardhatPluginError && !error.message.includes("above 2^53 - 1"),
    );
  });
});
