import { catalogError } from "hardhat-kms/provider-utils";
import { encodeFunctionData, parseAbiItem, type AbiFunction, type Hex } from "viem";

import { ERRORS } from "../error-catalog.ts";

/**
 * The call data from `--data`, or from `--function` and `--args`.
 *
 * @param data - `--data`.
 * @param signature - `--function`, such as `transferOwnership(address)`.
 * @param args - `--args`, a JSON array.
 * @returns The data, `0x` when none is given.
 */
export function callData(
  data: string | undefined,
  signature: string | undefined,
  args: string | undefined,
): string {
  if (signature === undefined) {
    if (args !== undefined) {
      throw catalogError(ERRORS.argsWithoutFunction, {});
    }
    return data ?? "0x";
  }
  if (data !== undefined) {
    throw catalogError(ERRORS.dataAndFunction, {});
  }
  return encodeCall(signature, args ?? "[]");
}

/** The error for a call the task cannot encode. */
function fail(reason: string): Error {
  return catalogError(ERRORS.badFunction, { reason });
}

/** A parsed `--function` and its `--args`, ready to encode. */
interface ParsedCall {
  item: AbiFunction;
  values: unknown[];
}

/**
 * An integer argument: a JSON number that is a safe integer, or a string of decimal digits (with
 * an optional minus) or `0x` hex. A larger JSON number is refused, since `JSON.parse` has already
 * rounded it, and so is a blank or fractional string, which `BigInt` would read as 0 or refuse.
 *
 * @param value - The JSON value.
 * @param index - Its 0-based position, for the error.
 * @returns The integer.
 */
function integerArgument(value: unknown, index: number): bigint {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      return BigInt(value);
    }
    if (Number.isInteger(value)) {
      throw fail(
        `argument ${index + 1} is a JSON number above 2^53 - 1, which JSON rounds: pass it as a string, such as "123456789012345678901"`,
      );
    }
    throw fail(`argument ${index + 1} is not an integer`);
  }
  if (typeof value === "string" && (/^-?\d+$/.test(value) || /^0x[0-9a-f]+$/i.test(value))) {
    return BigInt(value);
  }
  throw fail(`argument ${index + 1} is not an integer`);
}

/**
 * Parses `--function` and `--args`.
 *
 * @param signature - Such as `transferOwnership(address)`.
 * @param json - The arguments as a JSON array.
 * @returns The function and its arguments.
 */
function parseCall(signature: string, json: string): ParsedCall {
  let item: AbiFunction;
  try {
    const parsed = parseAbiItem(
      signature.trim().startsWith("function ") ? signature.trim() : `function ${signature.trim()}`,
    );
    if (parsed.type !== "function") {
      throw fail("--function is not a function signature");
    }
    item = parsed;
  } catch {
    throw fail("--function is not a function signature");
  }
  let args: unknown;
  try {
    args = JSON.parse(json);
  } catch {
    throw fail("--args is not JSON");
  }
  if (!Array.isArray(args)) {
    throw fail("--args is not a JSON array");
  }
  if (args.length !== item.inputs.length) {
    throw fail(`${item.name} takes ${item.inputs.length} arguments and --args has ${args.length}`);
  }
  const values = args.map((value: unknown, index) =>
    /^u?int\d*$/.test(item.inputs[index]?.type ?? "") ? integerArgument(value, index) : value,
  );
  return { item, values };
}

/**
 * ABI-encodes a call from a function signature and a JSON array of arguments. Integer arguments
 * may be decimal or hex strings, so values above 2^53 stay exact.
 *
 * @param signature - Such as `transferOwnership(address)` or `function upgradeTo(address)`.
 * @param json - The arguments, such as `["0x…"]`.
 * @returns The call data.
 */
export function encodeCall(signature: string, json: string): Hex {
  const { item, values } = parseCall(signature, json);
  try {
    return encodeFunctionData({ abi: [item], functionName: item.name, args: values });
  } catch {
    throw fail("an argument does not fit its parameter's type");
  }
}

/**
 * The call `--function` and `--args` encode, as the task shows it before the key signs: the
 * function with its parameter types, then each argument, integers in decimal.
 *
 * @param signature - `--function`.
 * @param json - `--args`, or `undefined` for none.
 * @returns Such as `transferOwnership(address) with 0x…`.
 */
export function describeCall(signature: string, json: string | undefined): string {
  const { item, values } = parseCall(signature, json ?? "[]");
  const name = `${item.name}(${item.inputs.map((input) => input.type).join(",")})`;
  if (values.length === 0) {
    return name;
  }
  const shown = values.map((value) =>
    typeof value === "string" || typeof value === "bigint" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value),
  );
  return `${name} with ${shown.join(", ")}`;
}
