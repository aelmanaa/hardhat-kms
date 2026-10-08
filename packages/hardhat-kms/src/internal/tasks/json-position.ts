/**
 * Where JSON text stops being valid, without quoting any of it.
 *
 * `JSON.parse`'s own message quotes the text around the error, which can be part of a secret when
 * the wrong file is given (a `.env` file, say). These functions find the position again with a
 * small scanner of the JSON grammar (RFC 8259), so an error can name a line and column instead.
 */

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
// Sticky: each matches at `lastIndex` only. A string holds no `"`, `\` or control character
// (below U+0020) unescaped.
const STRING = /"(?:[\u0020\u0021\u0023-\u005b\u005d-\uffff]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/y;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const LITERAL = /true|false|null/y;

/** The index just past the token of `pattern` at `start`, or `undefined` if there is none. */
function tokenEnd(pattern: RegExp, text: string, start: number): number | undefined {
  pattern.lastIndex = start;
  return pattern.test(text) ? pattern.lastIndex : undefined;
}

/**
 * Finds the offset of the first character that makes `text` invalid JSON.
 *
 * A string, number or literal that is malformed is reported at its first character. Text that
 * ends too early is reported at its end. Call it only on text that `JSON.parse` refuses: for
 * valid JSON it returns the text's length.
 *
 * @param text - The JSON text.
 * @returns A UTF-16 offset in `[0, text.length]`.
 */
export function jsonErrorOffset(text: string): number {
  // The closing bracket of each open array or object, innermost last.
  const closers: string[] = [];
  let index = 0;
  let expectValue = true;
  const skipWhitespace = (): void => {
    while (WHITESPACE.has(text.charAt(index))) {
      index++;
    }
  };
  /** Reads `"key" :` at `index`; returns false where it is not one. */
  const readKey = (): boolean => {
    const end = tokenEnd(STRING, text, index);
    if (end === undefined) {
      return false;
    }
    index = end;
    skipWhitespace();
    if (text.charAt(index) !== ":") {
      return false;
    }
    index++;
    return true;
  };
  for (;;) {
    skipWhitespace();
    const char = text.charAt(index);
    if (expectValue) {
      if (char === "[" || char === "{") {
        index++;
        skipWhitespace();
        const closer = char === "[" ? "]" : "}";
        if (text.charAt(index) === closer) {
          index++;
          expectValue = false;
        } else {
          closers.push(closer);
          if (closer === "}" && !readKey()) {
            return index;
          }
        }
        continue;
      }
      const end =
        tokenEnd(STRING, text, index) ??
        tokenEnd(NUMBER, text, index) ??
        tokenEnd(LITERAL, text, index);
      if (end === undefined) {
        return index;
      }
      index = end;
      expectValue = false;
      continue;
    }
    const closer = closers.at(-1);
    if (closer === undefined) {
      // A whole value was read: anything after it is the error.
      return index;
    }
    if (char === closer) {
      closers.pop();
      index++;
      continue;
    }
    if (char !== ",") {
      return index;
    }
    index++;
    skipWhitespace();
    if (closer === "}" && !readKey()) {
      return index;
    }
    expectValue = true;
  }
}

/**
 * The 1-based line and column of `offset` in `text`. Lines end at `\n`; the column counts UTF-16
 * code units, as editors that show `JSON.parse` positions do.
 *
 * @param text - The text.
 * @param offset - A UTF-16 offset in `[0, text.length]`.
 * @returns The line and column.
 */
export function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: offset - lineStart + 1 };
}
