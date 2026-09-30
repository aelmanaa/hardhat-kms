import assert from "node:assert/strict";

import type { HardhatUserConfig } from "hardhat/config";

import { validateKmsUserConfig } from "../../src/internal/config/validate.ts";

/** A validation error with its path joined by dots. */
export interface FlatError {
  path: string;
  message: string;
}

/**
 * Validates an untyped config, as a user's JavaScript config would arrive.
 *
 * @param config - Any value.
 * @returns The errors, with dotted paths.
 */
export function validate(config: unknown): FlatError[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately invalid configs
  return validateKmsUserConfig(config as HardhatUserConfig).map(({ path, message }) => ({
    path: path.join("."),
    message,
  }));
}

/**
 * Asserts that validation reports an error at `path` whose message contains `messagePart`.
 *
 * @param config - The config to validate.
 * @param path - The expected dotted path.
 * @param messagePart - A substring the message must contain; never empty.
 * @param count - The exact number of errors expected, when given.
 */
export function assertError(
  config: unknown,
  path: string,
  messagePart: string,
  count?: number,
): void {
  assert.notEqual(messagePart, "", "give a message substring to check");
  const errors = validate(config);
  const match = errors.find((error) => error.path === path);
  assert.ok(match, `expected an error at ${path}, got ${JSON.stringify(errors)}`);
  assert.ok(
    match.message.includes(messagePart),
    `"${match.message}" should include "${messagePart}"`,
  );
  if (count !== undefined) {
    assert.equal(errors.length, count, `expected ${count} errors, got ${JSON.stringify(errors)}`);
  }
}
