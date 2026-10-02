// Pure helpers for Google Cloud KMS's wire formats: the CRC32C checksums of requests and responses,
// and the status codes of its errors. No SDK, no I/O.

import { crc32c } from "hardhat-kms/provider-utils";

/**
 * Reads a `google.protobuf.Int64Value`, which the SDK gives as a number, a decimal string or a
 * `Long`, as a non-negative safe integer.
 *
 * @param field - The field as the SDK returned it.
 * @returns The value, or `undefined` if the field is missing or not a non-negative integer.
 */
export function int64Value(field: unknown): number | undefined {
  if (typeof field !== "object" || field === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(field, "value");
  const text =
    typeof value === "number" || typeof value === "bigint" || typeof value === "string"
      ? String(value)
      : ownDecimal(value);
  if (!/^\d{1,16}$/.test(text)) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** The decimal text of a protobufjs `Long`, which has its own `toString`, or `""`. */
function ownDecimal(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const toString: unknown = Reflect.get(value, "toString");
  if (typeof toString !== "function" || toString === Object.prototype.toString) {
    return "";
  }
  const text: unknown = Reflect.apply(toString, value, []);
  return typeof text === "string" ? text : "";
}

/**
 * Checks bytes against the CRC32C checksum Google Cloud KMS sent with them.
 *
 * @param bytes - The bytes received.
 * @param checksum - The checksum field of the response, an `Int64Value`.
 * @returns Whether the checksum is present and matches. A missing checksum does not match.
 */
export function crc32cMatches(bytes: Uint8Array, checksum: unknown): boolean {
  const expected = int64Value(checksum);
  return expected !== undefined && expected === crc32c(bytes);
}

/** gRPC status code names, by number, as Google Cloud errors carry them in `code`. */
const STATUS_NAMES = [
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
] as const;

/** A gRPC status name. */
export type StatusName = (typeof STATUS_NAMES)[number];

/**
 * The name of a gRPC status code, as Cloud Audit Logs records it in `status.code`.
 *
 * @param code - The status code.
 * @returns Its name, or `undefined` for a code that is not a known status.
 */
export function statusName(code: number): StatusName | undefined {
  return Number.isInteger(code) ? STATUS_NAMES[code] : undefined;
}

/**
 * Reads the gRPC status of an error thrown by the Google Cloud SDK.
 *
 * @param error - Anything thrown.
 * @returns The status name, or `undefined` if the error carries no known status code.
 */
export function statusOf(error: unknown): StatusName | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "number" ? statusName(code) : undefined;
}

/**
 * Reads the network error under a Google Cloud SDK error, such as `ECONNREFUSED` or `ENOTFOUND`.
 * Over REST, a request that never reached the service fails with UNAVAILABLE and keeps the
 * network error as its `cause`.
 *
 * @param error - Anything thrown.
 * @returns The network error code, or `undefined` if there is none.
 */
export function networkErrorCode(error: unknown): string | undefined {
  const cause: unknown = error instanceof Error ? Reflect.get(error, "cause") : undefined;
  const code: unknown =
    typeof cause === "object" && cause !== null ? Reflect.get(cause, "code") : undefined;
  // Only the shape of a Node errno code, so nothing else from the error can be shown.
  return typeof code === "string" && /^E[A-Z0-9_]{2,31}$/.test(code) ? code : undefined;
}
