import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as fc from "fast-check";

import { jsonErrorOffset, lineAndColumn } from "../../../src/internal/tasks/json-position.ts";

/**
 * Where V8's `JSON.parse` says `text` stops being valid, or `undefined` when the text is valid or
 * the message names no position.
 */
function v8Position(text: string): number | undefined {
  let position: number | undefined;
  try {
    JSON.parse(text);
  } catch (error) {
    assert.ok(error instanceof SyntaxError);
    const match = /at position (\d+)/.exec(error.message);
    position = match?.[1] === undefined ? undefined : Number(match[1]);
  }
  return position;
}

describe("jsonErrorOffset", () => {
  it("finds the first character that is not JSON", () => {
    const cases: [string, number][] = [
      // Nothing, or no value at all.
      ["", 0],
      [" \t\r\n", 4],
      ["AWS_SECRET_ACCESS_KEY=example\n", 0],
      ["﻿{}", 0],
      // After a whole value.
      ['{"a":1}x', 7],
      ["[] []", 3],
      ["1,2", 1],
      // Objects.
      ["{ to: 1 }", 2],
      ['{"a" 1}', 5],
      ['{"a":1', 6],
      ['{"a":1,}', 7],
      ["{,}", 1],
      // A key that is a value, but not a string.
      ["{1:2}", 1],
      ['{"a":1,2:3}', 7],
      ['{"a":1 "b":2}', 7],
      ['{"a":[1,{"b":tru}]}', 13],
      ['{"a":[1,2}', 9],
      // Arrays.
      ["[1,]", 3],
      ["[1 2]", 3],
      ["[1,2", 4],
      ["[", 1],
      ["[".repeat(10_000), 10_000],
      ["[\n  1,\n  oops\n]", 9],
      // Strings, numbers and literals are reported where they start.
      ['"abc', 0],
      ['["a\\q"]', 1],
      ['["\\u12g4"]', 1],
      ['["\u0001"]', 1],
      ['["a\nb"]', 1],
      ["[01]", 2],
      ["[-]", 1],
      ["[1.]", 2],
      ["[1e]", 2],
      ["[+1]", 1],
      ["[.5]", 1],
      ["[True]", 1],
      ["[nul]", 1],
      ["[undefined]", 1],
      ["['a']", 1],
    ];
    for (const [text, offset] of cases) {
      assert.throws(() => JSON.parse(text), SyntaxError, text);
      assert.equal(jsonErrorOffset(text), offset, JSON.stringify(text));
    }
  });

  it("reads every value that JSON allows", () => {
    const valid = [
      '{ "a" : [ 1 , -0.5e+10 , 2E-3 , 0 , true , false , null , "" ] , "b" : { } , "c" : [ ] }',
      '"\\" \\\\ \\/ \\b \\f \\n \\r \\t \\u00aF \u007f \u{1f600} ~ !"',
      "\t\r\n 12 \t\r\n",
      "[1.25, 1e25, 0E+1]",
    ];
    for (const text of valid) {
      assert.doesNotThrow(() => JSON.parse(text));
      assert.equal(jsonErrorOffset(text), text.length, text);
      // Followed by one character that is not JSON, it ends there.
      assert.equal(jsonErrorOffset(`${text}x`), text.length, text);
    }
  });

  it("is never after the position V8 names, for JSON with a few characters added", () => {
    fc.assert(
      fc.property(
        fc.json(),
        fc.nat(),
        fc.string({ minLength: 1, maxLength: 3 }),
        (json, at, junk) => {
          const cut = at % (json.length + 1);
          const text = `${json.slice(0, cut)}${junk}${json.slice(cut)}`;
          const position = v8Position(text);
          fc.pre(position !== undefined);
          // V8 reports some errors inside a string or number, which the scanner reports where the
          // token starts: never after V8's position.
          const offset = jsonErrorOffset(text);
          assert.ok(offset <= position, `${JSON.stringify(text)}: ${offset} > ${position}`);
        },
      ),
    );
  });
});

describe("jsonErrorOffset on long strings", () => {
  it("reads strings of any length without overflowing", () => {
    const long = "a".repeat(10_000_000);
    assert.equal(jsonErrorOffset(`"${long}`), 0);
    assert.equal(jsonErrorOffset(`"${long}"x`), long.length + 2);
    assert.equal(jsonErrorOffset(`"${"\\n".repeat(5_000_000)}`), 0);
  });
});

describe("lineAndColumn", () => {
  it("counts lines from 1 at each newline, and columns from 1 after it", () => {
    const text = "ab\ncd\r\n\nef";
    assert.deepEqual(lineAndColumn(text, 0), { line: 1, column: 1 });
    assert.deepEqual(lineAndColumn(text, 2), { line: 1, column: 3 });
    assert.deepEqual(lineAndColumn(text, 3), { line: 2, column: 1 });
    assert.deepEqual(lineAndColumn(text, 5), { line: 2, column: 3 });
    assert.deepEqual(lineAndColumn(text, 7), { line: 3, column: 1 });
    assert.deepEqual(lineAndColumn(text, 8), { line: 4, column: 1 });
    assert.deepEqual(lineAndColumn(text, 10), { line: 4, column: 3 });
  });
});
