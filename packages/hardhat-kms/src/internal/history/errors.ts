import type { HardhatPluginError } from "hardhat/plugins";

import { ERRORS } from "../error-catalog.ts";
import { catalogError, type ErrorDetails } from "../errors.ts";

/**
 * The error a history reader throws when the provider refuses to return log entries: it names the
 * permission to grant. Throwing it, rather than returning no events, keeps `kms history` from
 * reporting an empty history for a log it could not read.
 *
 * @param permission - What to grant, such as `cloudtrail:LookupEvents` or
 * `roles/logging.privateLogViewer`.
 * @param details - The provider, the operation and the key's display id.
 * @returns The error to throw.
 */
export function auditLogAccessDenied(
  permission: string,
  details: ErrorDetails = {},
): HardhatPluginError {
  return catalogError(ERRORS.historyAccessDenied, { permission }, details);
}

/**
 * The error a history reader throws when the provider keeps throttling its reads after the
 * reader's own retries.
 *
 * @param limit - The provider's documented limit, such as `2 lookups per second`.
 * @param details - The provider, the operation and the key's display id.
 * @returns The error to throw.
 */
export function auditLogThrottled(limit: string, details: ErrorDetails = {}): HardhatPluginError {
  return catalogError(ERRORS.historyThrottled, { limit }, details);
}
