import { createDefaultHttpClient, type HttpClient } from "@azure/core-rest-pipeline";
import type { AccessToken, GetTokenOptions, TokenCredential } from "@azure/identity";
import {
  catalogError,
  catalogMessage,
  kmsDebug,
  type KmsDebugLogger,
} from "hardhat-kms/provider-utils";

import { ERRORS } from "./error-catalog.ts";

/**
 * How long the managed identity may take to return a token. Outside Azure, the managed identity
 * endpoint can accept a connection and never answer, and the SDK retries it for over a minute.
 */
const MANAGED_IDENTITY_TIMEOUT_MS = 10_000;

/**
 * How long each managed identity HTTP request may take. @azure/identity does not pass the caller's
 * abort signal on to the request, so only a request timeout ends a request to an endpoint that
 * never answers; without it, the process stays alive long after the token was given up on.
 */
const MANAGED_IDENTITY_REQUEST_TIMEOUT_MS = 3_000;

/** A token is fetched again when it has less than this left, so no request carries a stale one. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** The characters @azure/identity accepts in a tenant id (`checkTenantId`). */
const TENANT_ID = /^[0-9a-zA-Z-.]+$/;

const log = kmsDebug("azure");

/** Timer functions, injectable so tests can control time. */
export interface Timers {
  /**
   * Schedules `callback` after `ms` milliseconds.
   *
   * @returns A function that cancels the timer.
   */
  setTimeout(callback: () => void, ms: number): () => void;
}

const systemTimers: Timers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

/** The environment the chain reads its variables from: `process.env`, or a fake in tests. */
export type AzureEnvironment = Readonly<Record<string, string | undefined>>;

/** The options the plugin gives a service principal from the environment. */
interface ServicePrincipalOptions {
  /** Tenants other than `AZURE_TENANT_ID` the credential may get tokens for. */
  additionallyAllowedTenants?: string[];
  /** Whether to send the certificate chain, for subject name and issuer authentication. */
  sendCertificateChain: boolean;
}

/** The certificate of a service principal, from a file. */
interface CertificateFile {
  certificatePath: string;
  certificatePassword?: string;
}

/** The parts of @azure/identity the credential chain uses; tests pass fakes with the same shape. */
export interface AzureIdentitySdk {
  ChainedTokenCredential: new (...sources: TokenCredential[]) => TokenCredential;
  ClientSecretCredential: new (
    tenantId: string,
    clientId: string,
    clientSecret: string,
    options: ServicePrincipalOptions,
  ) => TokenCredential;
  ClientCertificateCredential: new (
    tenantId: string,
    clientId: string,
    certificate: CertificateFile,
    options: ServicePrincipalOptions,
  ) => TokenCredential;
  WorkloadIdentityCredential: new () => TokenCredential;
  AzureCliCredential: new () => TokenCredential;
  AzureDeveloperCliCredential: new () => TokenCredential;
  ManagedIdentityCredential: new (options: {
    clientId?: string;
    httpClient: HttpClient;
  }) => TokenCredential;
  CredentialUnavailableError: new (message: string) => Error;
}

/**
 * Fails a credential that does not return a token in time, with `CredentialUnavailableError`, so
 * a chain reports it with the other sources that had no token.
 */
class TimeoutCredential implements TokenCredential {
  readonly #inner: TokenCredential;
  readonly #timeoutMs: number;
  readonly #unavailable: AzureIdentitySdk["CredentialUnavailableError"];
  readonly #timers: Timers;

  public constructor(
    inner: TokenCredential,
    timeoutMs: number,
    unavailable: AzureIdentitySdk["CredentialUnavailableError"],
    timers: Timers,
  ) {
    this.#inner = inner;
    this.#timeoutMs = timeoutMs;
    this.#unavailable = unavailable;
    this.#timers = timers;
  }

  public async getToken(
    scopes: string | string[],
    options?: GetTokenOptions,
  ): Promise<AccessToken | null> {
    // Signal the inner call when the time is over. @azure/identity 4.13 does not pass this signal
    // on to its HTTP requests; the request timeout of the managed identity's HTTP client is what
    // ends them. The caller's own signal never reaches here: the shared token cache drops it.
    const controller = new AbortController();
    const timeout = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          reject(
            new this.#unavailable(
              catalogMessage(ERRORS.managedIdentityTimeout, { seconds: this.#timeoutMs / 1000 }),
            ),
          );
        },
        { once: true },
      );
    });
    const cancel = this.#timers.setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    try {
      return await Promise.race([
        this.#inner.getToken(scopes, { ...options, abortSignal: controller.signal }),
        timeout,
      ]);
    } finally {
      cancel();
    }
  }
}

/**
 * Stops the chain at a service principal from the environment that fails, for any reason, as the
 * chain did with @azure/identity's environment credential: every error becomes one named
 * `AuthenticationError`. The inner credential can fail with `CredentialUnavailableError`, for
 * example for a tenant that is not allowed, and the chain would then go on to `az login` and
 * sign as another identity.
 */
class FailureStopsChain implements TokenCredential {
  readonly #inner: TokenCredential;

  public constructor(inner: TokenCredential) {
    this.#inner = inner;
  }

  public async getToken(
    scopes: string | string[],
    options?: GetTokenOptions,
  ): Promise<AccessToken | null> {
    try {
      return await this.#inner.getToken(scopes, options);
    } catch {
      // The inner error is dropped: its text can carry request details.
      const error = new Error(catalogMessage(ERRORS.environmentFailed, {}));
      error.name = "AuthenticationError";
      throw error;
    }
  }
}

/**
 * Reads a variable. Empty counts as unset, as in @azure/identity's own checks.
 *
 * @returns The value, or `undefined` when it is unset or empty.
 */
function variable(env: AzureEnvironment, name: string): string | undefined {
  const value = env[name];
  return value === "" ? undefined : value;
}

/**
 * Builds the service principal from the environment, with the rules of @azure/identity's
 * environment credential in 4.13.3, except that it never signs a user in with a password:
 *
 * 1. `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`: `ClientSecretCredential`.
 * 2. Otherwise those two ids and `AZURE_CLIENT_CERTIFICATE_PATH`: `ClientCertificateCredential`,
 *    with `AZURE_CLIENT_CERTIFICATE_PASSWORD` when it is set.
 * 3. Otherwise, if those two ids, `AZURE_USERNAME` and `AZURE_PASSWORD` are all set, it fails
 *    with `azure.credential.username-password`. This is the one case where @azure/identity's
 *    environment credential would sign the user in with the password alone, without
 *    multifactor authentication.
 * 4. Otherwise: no credential, and the chain starts with workload identity.
 *
 * `AZURE_USERNAME` and `AZURE_PASSWORD` in any other case are ignored, with one debug line that
 * names them. `AZURE_AUTHORITY_HOST` is read by the credentials themselves.
 *
 * @param identity - The @azure/identity module.
 * @param env - The environment.
 * @param debug - The debug logger.
 * @returns The credential, or `undefined` when the environment selects none.
 * @throws A `HardhatPluginError` (`azure.credential.tenant-id`) when `AZURE_TENANT_ID` holds a
 *   character a tenant id cannot have, or (`azure.credential.username-password`) in step 3.
 */
function servicePrincipal(
  identity: AzureIdentitySdk,
  env: AzureEnvironment,
  debug: KmsDebugLogger,
): TokenCredential | undefined {
  const tenantId = variable(env, "AZURE_TENANT_ID");
  const clientId = variable(env, "AZURE_CLIENT_ID");
  // @azure/identity's environment credential checks the tenant whenever it is set, before it
  // picks a source.
  if (tenantId !== undefined && !TENANT_ID.test(tenantId)) {
    throw catalogError(ERRORS.tenantId, {}, { provider: "azure" });
  }
  const userVariables = ["AZURE_USERNAME", "AZURE_PASSWORD"].filter(
    (name) => variable(env, name) !== undefined,
  );
  const credential =
    tenantId === undefined || clientId === undefined
      ? undefined
      : fromClientIds(identity, env, tenantId, clientId, userVariables.length === 2);
  if (userVariables.length > 0) {
    debug(
      "ignored %s: hardhat-kms does not sign in with a username and password",
      userVariables.join(" and "),
    );
  }
  return credential === undefined ? undefined : new FailureStopsChain(credential);
}

/**
 * Steps 1 to 3 of {@link servicePrincipal}, once the tenant and client ids are set.
 *
 * @returns The credential, or `undefined` when no secret or certificate is set.
 * @throws A `HardhatPluginError` (`azure.credential.username-password`) when no secret or
 *   certificate is set and `userAndPassword` is true.
 */
function fromClientIds(
  identity: AzureIdentitySdk,
  env: AzureEnvironment,
  tenantId: string,
  clientId: string,
  userAndPassword: boolean,
): TokenCredential | undefined {
  const allowed = variable(env, "AZURE_ADDITIONALLY_ALLOWED_TENANTS");
  const sendChain = (env.AZURE_CLIENT_SEND_CERTIFICATE_CHAIN ?? "").toLowerCase();
  const options: ServicePrincipalOptions = {
    ...(allowed === undefined ? {} : { additionallyAllowedTenants: allowed.split(";") }),
    sendCertificateChain: sendChain === "true" || sendChain === "1",
  };
  const secret = variable(env, "AZURE_CLIENT_SECRET");
  if (secret !== undefined) {
    return new identity.ClientSecretCredential(tenantId, clientId, secret, options);
  }
  const certificatePath = variable(env, "AZURE_CLIENT_CERTIFICATE_PATH");
  if (certificatePath !== undefined) {
    const certificatePassword = variable(env, "AZURE_CLIENT_CERTIFICATE_PASSWORD");
    return new identity.ClientCertificateCredential(
      tenantId,
      clientId,
      certificatePassword === undefined
        ? { certificatePath }
        : { certificatePath, certificatePassword },
      options,
    );
  }
  if (userAndPassword) {
    // Only here would @azure/identity's environment credential sign the user in with the password.
    throw catalogError(ERRORS.usernamePassword, {}, { provider: "azure" });
  }
  return undefined;
}

/**
 * Shares tokens between the Key Vault clients of all keys, so a run asks the chain once per scope
 * and tenant (for `az login`, one `az` process) instead of once per client.
 */
class SharedTokenCredential implements TokenCredential {
  readonly #inner: TokenCredential;
  readonly #tokens = new Map<string, AccessToken>();
  readonly #pending = new Map<string, Promise<AccessToken | null>>();

  public constructor(inner: TokenCredential) {
    this.#inner = inner;
  }

  public async getToken(
    scopes: string | string[],
    options?: GetTokenOptions,
  ): Promise<AccessToken | null> {
    if (options?.claims !== undefined) {
      // A claims challenge asks for a fresh token with extra claims: never answer it from cache.
      return await this.#inner.getToken(scopes, options);
    }
    const cacheKey = JSON.stringify([[scopes].flat(), options?.tenantId ?? ""]);
    const cached = this.#tokens.get(cacheKey);
    if (cached !== undefined && cached.expiresOnTimestamp - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return cached;
    }
    let pending = this.#pending.get(cacheKey);
    if (pending === undefined) {
      // The shared call runs without any caller's abort signal: one key's timeout must not fail
      // another key that waits for the same token. Each caller stops waiting on its own signal.
      const { abortSignal: _abortSignal, ...shared } = options ?? {};
      pending = this.#fetch(cacheKey, scopes, shared);
      this.#pending.set(cacheKey, pending);
    }
    return await waitFor(pending, options?.abortSignal);
  }

  async #fetch(
    cacheKey: string,
    scopes: string | string[],
    options: GetTokenOptions,
  ): Promise<AccessToken | null> {
    try {
      const token = await this.#inner.getToken(scopes, options);
      if (token !== null) {
        this.#tokens.set(cacheKey, token);
      }
      return token;
    } finally {
      this.#pending.delete(cacheKey);
    }
  }
}

/** The error a caller gets when it stops waiting, named as the Azure SDK names its own. */
function aborted(): Error {
  const error = new Error(catalogMessage(ERRORS.aborted, {}));
  error.name = "AbortError";
  return error;
}

/** Waits for `pending`, or rejects with an `AbortError` as soon as `signal` aborts. */
async function waitFor<T>(pending: Promise<T>, signal: GetTokenOptions["abortSignal"]): Promise<T> {
  if (signal === undefined) {
    return await pending;
  }
  if (signal.aborted) {
    throw aborted();
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(aborted());
        };
        signal.addEventListener("abort", onAbort);
      }),
    ]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Gives every request of `inner` a timeout of at most `timeoutMs`. */
function withRequestTimeout(inner: HttpClient, timeoutMs: number): HttpClient {
  return {
    sendRequest: async (request) => {
      request.timeout = request.timeout > 0 ? Math.min(request.timeout, timeoutMs) : timeoutMs;
      return await inner.sendRequest(request);
    },
  };
}

/**
 * Builds a credential, or returns `undefined` if its constructor says it is unavailable here.
 *
 * @returns The credential, or `undefined`.
 */
function unlessUnavailable(
  identity: AzureIdentitySdk,
  create: () => TokenCredential,
): TokenCredential | undefined {
  try {
    return create();
  } catch (error) {
    if (error instanceof identity.CredentialUnavailableError) {
      return undefined;
    }
    throw error;
  }
}

/** Settings of the managed identity; tests shorten the times and pass their own HTTP client. */
export interface ManagedIdentitySettings {
  /** The time limit for a token. Default: 10 s. */
  timeoutMs?: number;
  /** The time limit for each HTTP request. Default: 3 s. */
  requestTimeoutMs?: number;
  /** The HTTP client its requests go through, before the request timeout is added. */
  httpClient?: HttpClient;
  /** The timers that run the time limit. Default: the global timers. */
  timers?: Timers;
}

/**
 * Builds the credential for Key Vault requests. The sources are tried in this order, the first
 * that returns a token wins, and a source that fails with anything other than "unavailable"
 * stops the chain:
 *
 * 1. A service principal from the environment: `AZURE_TENANT_ID` and `AZURE_CLIENT_ID` with
 *    `AZURE_CLIENT_SECRET`, or with `AZURE_CLIENT_CERTIFICATE_PATH`. Any failure of it stops the
 *    chain. The plugin never signs a user in with `AZURE_USERNAME` and `AZURE_PASSWORD`: when
 *    they would have been used, building the chain fails.
 * 2. `WorkloadIdentityCredential`, when `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and
 *    `AZURE_FEDERATED_TOKEN_FILE` are set (AKS workload identity).
 * 3. `AzureCliCredential` (`az login`, or the `azure/login` GitHub Action), then
 *    `AzureDeveloperCliCredential` (`azd auth login`).
 * 4. `ManagedIdentityCredential`, user-assigned when `AZURE_CLIENT_ID` is set, with a time limit
 *    and a timeout on each of its HTTP requests. Where it cannot be used with a client id (Cloud
 *    Shell, Service Fabric), it is left out, as the proposed Foundry signer does.
 *
 * This is the order of the Azure Key Vault signer proposed for Foundry in foundry-rs/foundry#17120,
 * which no Foundry release includes yet: developer tools come before the managed identity, so a
 * local login is not delayed by the managed identity endpoint.
 *
 * @param identity - The @azure/identity module.
 * @param env - The environment the plugin reads its variables from; the hook handler passes
 *   `process.env`. The SDK's own credentials still read theirs, such as `AZURE_AUTHORITY_HOST`
 *   and the workload identity's, from `process.env`.
 * @param managedIdentity - Time limits and HTTP client of the managed identity.
 * @param debug - The debug logger; tests pass one that records its lines.
 * @returns The credential, shared by every Azure key of a Hardhat runtime.
 * @throws A `HardhatPluginError` when `AZURE_TENANT_ID` is not a tenant id, or when the
 *   environment selects username and password sign-in.
 */
export function createAzureCredential(
  identity: AzureIdentitySdk,
  env: AzureEnvironment,
  managedIdentity: ManagedIdentitySettings = {},
  debug: KmsDebugLogger = log,
): TokenCredential {
  const sources: TokenCredential[] = [];
  const environment = servicePrincipal(identity, env, debug);
  if (environment !== undefined) {
    sources.push(environment);
  }
  // Its constructor fails when its variables are not set: then it is not part of the chain.
  const workload = unlessUnavailable(identity, () => new identity.WorkloadIdentityCredential());
  if (workload !== undefined) {
    sources.push(workload);
  }
  sources.push(new identity.AzureCliCredential(), new identity.AzureDeveloperCliCredential());
  const id = env.AZURE_CLIENT_ID?.trim() ?? "";
  const httpClient = withRequestTimeout(
    managedIdentity.httpClient ?? createDefaultHttpClient(),
    managedIdentity.requestTimeoutMs ?? MANAGED_IDENTITY_REQUEST_TIMEOUT_MS,
  );
  // Its constructor fails in Cloud Shell and Service Fabric when given a client id.
  const managed = unlessUnavailable(
    identity,
    () =>
      new identity.ManagedIdentityCredential(
        id === "" ? { httpClient } : { clientId: id, httpClient },
      ),
  );
  if (managed !== undefined) {
    sources.push(
      new TimeoutCredential(
        managed,
        managedIdentity.timeoutMs ?? MANAGED_IDENTITY_TIMEOUT_MS,
        identity.CredentialUnavailableError,
        managedIdentity.timers ?? systemTimers,
      ),
    );
  }
  return new SharedTokenCredential(new identity.ChainedTokenCredential(...sources));
}
