import type { HardhatPluginError } from "hardhat/plugins";

import { ERRORS } from "../error-catalog.ts";
import { catalogError, type ErrorDetails } from "../errors.ts";

// No ids: a permission, a role or a limit, such as `roles/logging.privateLogViewer`,
// `Microsoft.OperationalInsights/workspaces/query/read (Log Analytics Data Reader)` or
// `200 per 30 seconds`.
const ID_FREE = /^[A-Za-z0-9][A-Za-z0-9 .,:;()_/*-]{0,199}$/;

// Long runs of digits or hex, URLs, and the prefixes of ARNs, aliases, Google Cloud resource names
// and Azure hosts look like account ids, key ids and endpoints.
const ID_LIKE = /\d{5}|[0-9a-f]{8}|:\/\/|arn:|alias\/|projects\/|\.azure\.net/i;

/** Whether a value is safe to print: no characters or runs that could carry an id. */
function idFree(value: string): boolean {
  return ID_FREE.test(value) && !ID_LIKE.test(value);
}

/**
 * The error a history reader throws when the provider refuses to return log entries: it names the
 * permissions to grant. Throwing it, rather than returning no events, keeps `kms history` from
 * reporting an empty history for a log it could not read.
 *
 * A value that looks like it could carry an id is not printed: the error then says that the read
 * was refused and that the reader named the permission in a form the plugin does not print.
 *
 * @param permission - What to grant, such as `cloudtrail:LookupEvents`, or several values, such
 * as the two Azure permissions. Never an id: each at most 200 letters, digits, spaces and
 * `. , : ; ( ) _ / * -`, with no URL, ARN, alias, `projects/` path, Azure host, or run of five
 * digits or eight hex characters.
 * @param details - The provider, the operation and the key's display id.
 * @returns The error to throw.
 */
export function auditLogAccessDenied(
  permission: string | readonly string[],
  details: ErrorDetails = {},
): HardhatPluginError {
  const values = typeof permission === "string" ? [permission] : [...permission];
  if (values.length === 0 || !values.every(idFree)) {
    return catalogError(ERRORS.historyAccessDeniedUnprintable, {}, details);
  }
  return catalogError(ERRORS.historyAccessDenied, { permission: values.join(" and ") }, details);
}

/**
 * The error a history reader throws when the provider keeps throttling its reads after the
 * reader's own retries.
 *
 * @param limit - The provider's documented limit, such as `2 requests per second`. Never an id,
 * with the same rules as a permission. A value that breaks them is not printed.
 * @param details - The provider, the operation and the key's display id.
 * @returns The error to throw.
 */
export function auditLogThrottled(limit: string, details: ErrorDetails = {}): HardhatPluginError {
  if (!idFree(limit)) {
    return catalogError(ERRORS.historyThrottledUnprintable, {}, details);
  }
  return catalogError(ERRORS.historyThrottled, { limit }, details);
}
