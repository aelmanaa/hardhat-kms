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

/**
 * Recognises the credentials failures google-auth-library reports, by fixed text in its
 * messages. The part matched holds no request details; the rest of a message, which can name a
 * file path, is never shown.
 *
 * @param error - The error a call or the client's initialization rejected with.
 * @returns The catalogue entry to report: `noCredentials` when no Application Default Credentials
 * were found, `credentialsFile` when the file `GOOGLE_APPLICATION_CREDENTIALS` names could not be
 * read, or `undefined` for any other error.
 */
export function credentialFailure(error: unknown): "noCredentials" | "credentialsFile" | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  if (error.message.includes("Could not load the default credentials")) {
    return "noCredentials";
  }
  if (
    error.message.includes(
      "Unable to read the credential file specified by the GOOGLE_APPLICATION_CREDENTIALS environment variable",
    )
  ) {
    return "credentialsFile";
  }
  return undefined;
}

/** A project segment of a key version name, as the config check takes it. */
const KEY_PROJECT = /^projects\/([A-Za-z0-9_.:-]+)\/locations\//;

/**
 * Reads the project from a key version name, the id or number the name was configured with.
 * Both config forms, a full `keyVersionName` and its parts, resolve to such a name.
 *
 * @param name - `projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>/cryptoKeyVersions/<v>`.
 * @returns The project, or `undefined` if the name does not start with a valid project.
 */
export function keyProject(name: string): string | undefined {
  const project = KEY_PROJECT.exec(name)?.[1];
  return project === undefined || project === "." || project === ".." ? undefined : project;
}

/**
 * The Google endpoints google-auth-library calls to get an access token, other than the OAuth
 * token endpoint, by the first label of their `googleapis.com` host, with the fixed name an error
 * shows for each. A request path is never
 * shown: it can hold the project number.
 */
const AUTH_ENDPOINTS: ReadonlyMap<string, string> = new Map([
  ["sts", "the token exchange (sts.googleapis.com)"],
  ["cloudresourcemanager", "the project lookup (cloudresourcemanager.googleapis.com)"],
  ["iamcredentials", "service account impersonation (iamcredentials.googleapis.com)"],
]);

/**
 * The OAuth error code google-auth-library puts first in the message of a refused token exchange,
 * such as `invalid_grant`. The description after it can repeat claims of the external token.
 */
const OAUTH_ERROR_CODE = /^Error code ([a-z][a-z_]{0,39})(?=:|\s|$)/;

/** How many errors of a `cause` chain are read: the SDK wraps an auth failure once. */
const MAX_CAUSES = 4;

/** Why getting an access token failed for good. */
export type AuthFailure =
  | { kind: "tokenExchange"; code: string }
  | { kind: "login" }
  | { kind: "endpoint"; endpoint: string; status: number };

/** The host of a gaxios error's request URL, a string or a `URL`. */
function requestHost(error: Error): string | undefined {
  const config: unknown = Reflect.get(error, "config");
  const url: unknown =
    typeof config === "object" && config !== null ? Reflect.get(config, "url") : undefined;
  if (url instanceof URL) {
    return url.hostname;
  }
  return typeof url === "string" && URL.canParse(url) ? new URL(url).hostname : undefined;
}

/**
 * The HTTP status of an error: a gaxios error's, on the error or on its response, or the one
 * google-gax keeps as `httpStatusCode` on the error it wraps a failed request in.
 */
function httpStatusOf(error: Error): number | undefined {
  const response: unknown = Reflect.get(error, "response");
  const status: unknown =
    Reflect.get(error, "status") ??
    (typeof response === "object" && response !== null
      ? Reflect.get(response, "status")
      : undefined) ??
    Reflect.get(error, "httpStatusCode");
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

/**
 * Whether an HTTP status refuses the request for good: a 4xx other than 408 (timeout) and 429
 * (throttled). A 5xx, 408 or 429 may pass on a retry, so it keeps the handling it had before.
 */
function refusedForGood(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Recognises a refusal from an endpoint google-auth-library calls to get an access token, on the
 * error or on the errors in its `cause` chain: over REST the SDK wraps it in an error with a gRPC
 * status that would otherwise read as Cloud KMS's own answer. Only a refusal for good counts: a
 * 5xx, 408 or 429 is left to the caller, which retries it as before.
 *
 * The OAuth token endpoint refusing a refresh means the login expired or was revoked. A refused
 * token exchange gives only its OAuth error code. Any other refusal gives only the HTTP status and
 * the endpoint's fixed name, never the request path or the server's message.
 *
 * @param error - Anything thrown.
 * @returns The failure, or `undefined` for an error that is none of these.
 */
export function authFailure(error: unknown): AuthFailure | undefined {
  const chain: Error[] = [];
  for (let current: unknown = error; chain.length < MAX_CAUSES && current instanceof Error;) {
    chain.push(current);
    current = Reflect.get(current, "cause");
  }
  // The SDK's wrapper copies the message of the error under it but not its HTTP status, so the
  // status is read from the first error in the chain that has one.
  const status = chain.map(httpStatusOf).find((found) => found !== undefined);
  if (status !== undefined && !refusedForGood(status)) {
    return undefined;
  }
  for (const current of chain) {
    const host = requestHost(current);
    const label = host?.endsWith(".googleapis.com") === true ? host.split(".")[0] : undefined;
    if (label === "oauth2" && status !== undefined) {
      return { kind: "login" };
    }
    const code = OAUTH_ERROR_CODE.exec(current.message)?.[1];
    if (code !== undefined && code !== "undefined") {
      return { kind: "tokenExchange", code };
    }
    const endpoint = label === undefined ? undefined : AUTH_ENDPOINTS.get(label);
    if (endpoint !== undefined && status !== undefined) {
      return { kind: "endpoint", endpoint, status };
    }
  }
  return undefined;
}
