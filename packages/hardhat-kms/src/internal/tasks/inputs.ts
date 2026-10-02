import { readFile } from "node:fs/promises";

import type { TypedData } from "../crypto/digests.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError, errorName } from "../errors.ts";
import { readTypedData } from "../rpc/typed-data.ts";

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

/**
 * Decodes `0x`-prefixed hex with an even number of digits.
 *
 * @param value - The hex from the command line.
 * @param what - How errors name the value, for example `the message`.
 * @param operation - The task, for error messages.
 * @returns The bytes.
 */
export function decodeHex(value: string, what: string, operation: string): Uint8Array {
  if (!HEX_BYTES.test(value)) {
    throw catalogError(ERRORS.notHex, { what }, { operation });
  }
  return new Uint8Array(Buffer.from(value.slice(2), "hex"));
}

/**
 * Reads a message as cast does: a `0x` value is hex bytes, anything else is UTF-8 text.
 *
 * @param message - The message from the command line.
 * @param operation - The task, for error messages.
 * @returns The message bytes.
 */
export function readMessage(message: string, operation: string): Uint8Array {
  return message.startsWith("0x")
    ? decodeHex(message, "the message", operation)
    : new TextEncoder().encode(message);
}

/**
 * Reads the typed data of a `--data` task: the message is the JSON itself or, with
 * `--from-file`, the path of a file that holds it.
 *
 * @param message - The message from the command line.
 * @param fromFile - Whether `--from-file` was given.
 * @param operation - The task, for error messages.
 * @returns A private, checked copy of the typed data.
 */
export async function readTypedDataArgument(
  message: string,
  fromFile: boolean,
  operation: string,
): Promise<TypedData> {
  return readTypedData(fromFile ? await readTypedDataFile(message, operation) : message, operation);
}

async function readTypedDataFile(file: string, operation: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw catalogError(
      ERRORS.typedDataFileUnreadable,
      { file, errorName: errorName(error) },
      { operation },
    );
  }
}
