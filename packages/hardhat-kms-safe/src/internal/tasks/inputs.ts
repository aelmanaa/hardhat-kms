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

/**
 * ABI-encodes a call from a function signature and a JSON array of arguments. Integer arguments
 * may be decimal strings, so values above 2^53 stay exact.
 *
 * @param signature - Such as `transferOwnership(address)` or `function upgradeTo(address)`.
 * @param json - The arguments, such as `["0x…"]`.
 * @returns The call data.
 */
export function encodeCall(signature: string, json: string): Hex {
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
  const values = args.map((value: unknown, index) => {
    const type = item.inputs[index]?.type ?? "";
    if (/^u?int\d*$/.test(type) && (typeof value === "string" || typeof value === "number")) {
      try {
        return BigInt(value);
      } catch {
        throw fail(`argument ${index + 1} is not an integer`);
      }
    }
    return value;
  });
  try {
    return encodeFunctionData({ abi: [item], functionName: item.name, args: values });
  } catch {
    throw fail("an argument does not fit its parameter's type");
  }
}
