// The `entries.list` call of the history reader, over REST with google-auth-library, which
// @google-cloud/kms already installs through google-gax. The Cloud Logging client library would
// add about 3.9 MB to every install for this one call.
import { Readable } from "node:stream";

import type { gaxios } from "google-auth-library";

import { CallTimedOut, type ListEntries } from "./history.ts";

/** Cloud Logging's REST endpoint. */
const LOGGING_ENDPOINT = "https://logging.googleapis.com";

/** The OAuth scope that reading log entries needs. */
export const LOGGING_READ_SCOPE = "https://www.googleapis.com/auth/logging.read";

/** The part of google-auth-library's `GoogleAuth`, or of an `AuthClient`, the call uses. */
export interface LoggingAuth {
  request<T>(options: gaxios.GaxiosOptions): Promise<gaxios.GaxiosResponse<T>>;
}

/**
 * Builds the `entries.list` call: an authorized POST with the request as its JSON body.
 *
 * @param auth - Signs the request: a `GoogleAuth` with the logging read scope, which finds
 * Application Default Credentials as the Cloud KMS client does.
 * @param userAgent - The plugin's user-agent tag, such as `hardhat-kms/1.0.0`.
 * @param endpoint - Cloud Logging's endpoint; tests pass a local server.
 * @returns The call. The reader gives each call its time, from its scan budget.
 */
export function loggingTransport(
  auth: LoggingAuth,
  userAgent: string,
  endpoint: string = LOGGING_ENDPOINT,
): ListEntries {
  return async (request, signal, timeoutMs) => {
    signal.throwIfAborted();
    // The deadline goes in the signal rather than in gaxios's `timeout`: gaxios 7 drops a signal
    // that has already aborted when it adds its own timeout, and sends the request anyway.
    const deadline = AbortSignal.timeout(timeoutMs);
    const json = Buffer.from(JSON.stringify(request));
    // A stream the call owns, with an error listener. gaxios sends through node-fetch 3, which on
    // an abort destroys the request body with the abort error. A string or buffer body becomes a
    // stream that no one listens to, and an abort before the body is sent, such as during a token
    // refresh, then crashes the process with an unhandled 'error' event. Here the error is
    // ignored: the call itself rejects with it. A stream body also turns off google-auth-library's
    // one-time re-auth retry on 401 or 403, which only applies to credentials without expiry_date.
    const body = Readable.from([json]);
    body.on("error", () => {});
    try {
      const response = await auth.request<unknown>({
        url: `${endpoint}/v2/entries:list`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(json.length),
          "User-Agent": userAgent,
        },
        data: body,
        signal: AbortSignal.any([signal, deadline]),
        responseType: "json",
        // The reader retries, with its own pauses and its own signal checks.
        retry: false,
      });
      return response.data;
    } catch (error) {
      if (deadline.aborted && !signal.aborted) {
        throw new CallTimedOut(timeoutMs);
      }
      throw error;
    }
  };
}
