import type { HardhatPluginError } from "hardhat/plugins";

import { ERRORS } from "../error-catalog.ts";
import { catalogError, type ErrorDetails, internalError } from "../errors.ts";

// No ids: a permission or a limit, such as `roles/logging.privateLogViewer` or `2 per second`.
const ID_FREE = /^[A-Za-z0-9][A-Za-z0-9 .,:_/*-]{0,127}$/;

// Long runs of digits or hex, and URLs, look like account ids, key ids and endpoints.
const ID_LIKE = /\d{5}|[0-9a-f]{8}|:\/\//i;

function idFree(value: string): string {
  if (!ID_FREE.test(value) || ID_LIKE.test(value)) {
    throw internalError(ERRORS.historyErrorArgument, {});
  }
  return value;
}

/**
 * The error a history reader throws when the provider refuses to return log entries: it names the
 * permission to grant. Throwing it, rather than returning no events, keeps `kms history` from
 * reporting an empty history for a log it could not read.
 *
 * @param permission - What to grant, such as `cloudtrail:LookupEvents` or
 * `roles/logging.privateLogViewer`. Never an id: at most 128 letters, digits, spaces and
 * `. , : _ / * -`.
 * @param details - The provider, the operation and the key's display id.
 * @returns The error to throw.
 */
export function auditLogAccessDenied(
  permission: string,
  details: ErrorDetails = {},
): HardhatPluginError {
  return catalogError(ERRORS.historyAccessDenied, { permission: idFree(permission) }, details);
}

/**
 * The error a history reader throws when the provider keeps throttling its reads after the
 * reader's own retries.
 *
 * @param limit - The provider's documented limit, such as `2 lookups per second`. Never an id,
 * with the same characters as a permission.
 * @param details - The provider, the operation and the key's display id.
 * @returns The error to throw.
 */
export function auditLogThrottled(limit: string, details: ErrorDetails = {}): HardhatPluginError {
  return catalogError(ERRORS.historyThrottled, { limit: idFree(limit) }, details);
}
