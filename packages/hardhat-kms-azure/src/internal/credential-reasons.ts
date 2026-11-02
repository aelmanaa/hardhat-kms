// Turns each source's failure in the credential chain into a short, fixed reason, so that
// `azure.credential.none` can say which source failed and why. A reason comes only from a marker
// @azure/identity puts at the start of its own fixed messages (the same in 4.13.3 and 4.14.1),
// never from the rest of a message or from the output of `az` or `azd`, which can name the tenant.
import type { GetTokenOptions } from "@azure/identity";
import { catalogMessage } from "hardhat-kms/provider-utils";

import { ERRORS } from "./error-catalog.ts";

/** The name of each source in a reason. */
export const SOURCE = {
  servicePrincipal: "service principal from the environment",
  workloadIdentity: "workload identity",
  azureCli: "Azure CLI",
  azureDeveloperCli: "Azure Developer CLI",
  managedIdentity: "managed identity",
} as const;

/** The variables a service principal needs, as `azure.credential.source-not-set-up` names them. */
export const SERVICE_PRINCIPAL_VARIABLES =
  "AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET or AZURE_CLIENT_CERTIFICATE_PATH";
/** The variables workload identity needs. */
export const WORKLOAD_IDENTITY_VARIABLES =
  "AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_FEDERATED_TOKEN_FILE";

/** The start of @azure/identity's message for a claims challenge, from `az` and `azd` alike. */
const CLAIMS = "This credential doesn't support claims challenges.";

/** The starts of `AzureCliCredential`'s fixed messages (`azureCliPublicErrorMessages`). */
const AZURE_CLI = {
  notInstalled: "Azure CLI could not be found.",
  login: "Please run 'az login' from a command prompt",
};

/** The starts of `AzureDeveloperCliCredential`'s (`azureDeveloperCliPublicErrorMessages`). */
const AZURE_DEVELOPER_CLI = {
  notInstalled: "Azure Developer CLI couldn't be found.",
  login: "Please run 'azd auth login' from a command prompt",
};

/**
 * The start of `ManagedIdentityCredential`'s message when its endpoint gave no token: MSAL's
 * `network_error`, for a request that failed and for an answer it could not use alike.
 */
const MANAGED_IDENTITY_NO_TOKEN = "ManagedIdentityCredential: Network unreachable.";

/** A scope safe to show in a command: a URL of letters, digits and `:/._-` only. */
const SAFE_SCOPE = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9/._-]*$/;

/** The reasons of the chain that failed, by the error it failed with. */
const chainReasons = new WeakMap<object, readonly string[]>();
/** The reason of each source's error, by that error. */
const sourceReasons = new WeakMap<object, string>();

/** The message of an error @azure/identity names `CredentialUnavailableError`, or undefined. */
function unavailableMessage(error: unknown): string | undefined {
  return error instanceof Error && error.name === "CredentialUnavailableError"
    ? error.message
    : undefined;
}

/**
 * Explains a failure of `az` or `azd` from the start of its message.
 *
 * @param source - `SOURCE.azureCli` or `SOURCE.azureDeveloperCli`.
 * @param error - The error the credential threw.
 * @param scopes - The scopes the token was asked for.
 * @param options - The options of the token request, for the claims of a claims challenge.
 * @returns The reason.
 */
export function cliReason(
  source: typeof SOURCE.azureCli | typeof SOURCE.azureDeveloperCli,
  error: unknown,
  scopes: string | string[],
  options: GetTokenOptions | undefined,
): string {
  const message = unavailableMessage(error);
  const markers = source === SOURCE.azureCli ? AZURE_CLI : AZURE_DEVELOPER_CLI;
  const login = source === SOURCE.azureCli ? "az login" : "azd auth login";
  if (message?.startsWith(markers.notInstalled) === true) {
    return catalogMessage(ERRORS.sourceNotInstalled, { source });
  }
  if (message?.startsWith(markers.login) === true) {
    return catalogMessage(ERRORS.sourceNotSignedIn, { source, command: login });
  }
  if (message?.startsWith(CLAIMS) === true) {
    return catalogMessage(ERRORS.sourceClaimsChallenge, {
      source,
      command: claimsCommand(source, scopes, options?.claims),
    });
  }
  return catalogMessage(ERRORS.sourceUnknown, { source });
}

/**
 * The command that answers a claims challenge, without the tenant @azure/identity would add. For
 * `az`, it carries the challenge, Base64-encoded as @azure/identity encodes it, and the scope.
 */
function claimsCommand(
  source: typeof SOURCE.azureCli | typeof SOURCE.azureDeveloperCli,
  scopes: string | string[],
  claims: string | undefined,
): string {
  const scope = [scopes].flat()[0] ?? "";
  const scopeArgument = SAFE_SCOPE.test(scope) ? ` --scope ${scope}` : "";
  if (source === SOURCE.azureDeveloperCli) {
    return `azd auth login${scopeArgument}`;
  }
  const challenge =
    claims === undefined || claims.trim() === ""
      ? ""
      : ` --claims-challenge ${Buffer.from(claims, "utf8").toString("base64")}`;
  return `az login${challenge}${scopeArgument}`;
}

/**
 * Explains a failure of the managed identity.
 *
 * @param error - The error the credential threw.
 * @param timedOut - Whether the error is the plugin's own time limit.
 * @returns The reason.
 */
export function managedIdentityReason(error: unknown, timedOut: boolean): string {
  const source = SOURCE.managedIdentity;
  const message = unavailableMessage(error);
  if (timedOut || message?.startsWith(MANAGED_IDENTITY_NO_TOKEN) === true) {
    return catalogMessage(ERRORS.sourceUnreachable, { source });
  }
  return catalogMessage(ERRORS.sourceUnknown, { source });
}

/** Keeps the reason of a source's error, unless one is kept already. */
export function noteSourceReason(error: unknown, reason: string): void {
  if (typeof error === "object" && error !== null && !sourceReasons.has(error)) {
    sourceReasons.set(error, reason);
  }
}

/**
 * Keeps the reasons of a failed chain: `before`, then the reason of each error the chain
 * collected, in its order, then `after`.
 *
 * @param error - The error the chain failed with.
 * @param before - The reasons of the sources left out before the first source in the chain.
 * @param after - The reasons of the sources left out after the last one.
 */
export function noteChainReasons(
  error: unknown,
  before: readonly string[],
  after: readonly string[],
): void {
  if (typeof error !== "object" || error === null) {
    return;
  }
  const errors: unknown = Reflect.get(error, "errors");
  const collected = Array.isArray(errors)
    ? errors.flatMap((item: unknown) => {
        const reason =
          typeof item === "object" && item !== null ? sourceReasons.get(item) : undefined;
        return reason === undefined ? [] : [reason];
      })
    : [];
  chainReasons.set(error, [...before, ...collected, ...after]);
}

/**
 * The reasons of the chain that failed with `error`, to put in `azure.credential.none`.
 *
 * @param error - The error a Key Vault or Log Analytics call failed with.
 * @returns ` By source: `, the reasons separated by `; `, and a full stop, or an empty string when
 *   no reason is known for this error.
 */
export function credentialReasons(error: unknown): string {
  const reasons = typeof error === "object" && error !== null ? chainReasons.get(error) : undefined;
  return reasons === undefined || reasons.length === 0 ? "" : ` By source: ${reasons.join("; ")}.`;
}
