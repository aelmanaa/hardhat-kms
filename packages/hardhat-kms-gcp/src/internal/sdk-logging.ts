import { catalogWarning } from "hardhat-kms/provider-utils";

import { ERRORS } from "./error-catalog.ts";

/** The variable that turns on the logs of Google's client libraries. */
export const SDK_LOGGING_VARIABLE = "GOOGLE_SDK_NODE_LOGGING";

/**
 * The logs of Google's client libraries that print what the plugin keeps out of its own output:
 * `kms`, @google-cloud/kms's, with each request and response and so the key version name, and
 * `auth`, google-auth-library's, with each response body and so the access token of a token
 * refresh or exchange and the entries `kms history` reads.
 */
export type SdkLogNamespace = "kms" | "auth";

/**
 * Whether Google's client libraries may log under `namespace` with the variable set to `setting`.
 * This follows google-logging-utils (`build/src/logging-utils.js`), which google-gax and
 * google-auth-library log through: an unset or empty variable turns logging off, and any other
 * value is a comma-separated list of namespaces, matched whole and ignoring case, in which `*`
 * matches any text and a value of exactly `all` matches every namespace. From 2.1.0 a value of
 * exactly `true` also matches every namespace; it counts as on whatever the installed version, so
 * the warning never misses it (#651). `1` turns on nothing. A test checks this against the
 * installed libraries.
 *
 * @param setting - The variable's value.
 * @param namespace - The library's log namespace.
 * @returns Whether that library logs.
 */
export function sdkLogs(setting: string | undefined, namespace: SdkLogNamespace): boolean {
  if (setting === undefined || setting === "") {
    return false;
  }
  const filters = setting === "all" || setting === "true" ? "*" : setting;
  const pattern = filters
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/,/g, "$|^");
  return new RegExp(`^${pattern}$`, "i").test(namespace);
}

/**
 * Builds the warning about Google's client library logs, printed at most once.
 *
 * @param setting - Reads the variable when the warning may be due.
 * @returns A function that warns, the first time only, when any of the given logs is on.
 */
export function sdkLoggingWarning(
  setting: () => string | undefined,
): (namespaces: readonly SdkLogNamespace[]) => void {
  let warned = false;
  return (namespaces) => {
    if (warned) {
      return;
    }
    const value = setting();
    if (namespaces.some((namespace) => sdkLogs(value, namespace))) {
      warned = true;
      catalogWarning(ERRORS.sdkLogging, {});
    }
  };
}

/** The process's warning: one per process, from the variable in `process.env`. */
export const warnAboutSdkLogging: (namespaces: readonly SdkLogNamespace[]) => void =
  sdkLoggingWarning(
    // oxlint-disable-next-line node/no-process-env -- the variable is Google's, read only to warn; the plugin never changes it
    () => process.env[SDK_LOGGING_VARIABLE],
  );
