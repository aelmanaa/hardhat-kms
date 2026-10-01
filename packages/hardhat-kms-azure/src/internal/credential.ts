import type { AccessToken, GetTokenOptions, TokenCredential } from "@azure/identity";

/**
 * How long the managed identity may take to return a token. Outside Azure, the managed identity
 * endpoint can accept a connection and never answer, and the SDK retries it for over a minute.
 */
const MANAGED_IDENTITY_TIMEOUT_MS = 10_000;

/** A token is fetched again when it has less than this left, so no request carries a stale one. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** The parts of @azure/identity the credential chain uses; tests pass fakes with the same shape. */
export interface AzureIdentitySdk {
  ChainedTokenCredential: new (...sources: TokenCredential[]) => TokenCredential;
  EnvironmentCredential: new () => TokenCredential;
  WorkloadIdentityCredential: new () => TokenCredential;
  AzureCliCredential: new () => TokenCredential;
  AzureDeveloperCliCredential: new () => TokenCredential;
  ManagedIdentityCredential: {
    new (): TokenCredential;
    new (clientId: string): TokenCredential;
  };
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

  public constructor(
    inner: TokenCredential,
    timeoutMs: number,
    unavailable: AzureIdentitySdk["CredentialUnavailableError"],
  ) {
    this.#inner = inner;
    this.#timeoutMs = timeoutMs;
    this.#unavailable = unavailable;
  }

  public async getToken(
    scopes: string | string[],
    options?: GetTokenOptions,
  ): Promise<AccessToken | null> {
    // Abort the inner call when the caller gives up or the time is over, so it stops retrying.
    const controller = new AbortController();
    const outer = options?.abortSignal;
    const forward = (): void => {
      controller.abort();
    };
    if (outer?.aborted === true) {
      controller.abort();
    }
    outer?.addEventListener("abort", forward);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new this.#unavailable(
            `ManagedIdentityCredential: no token within ${this.#timeoutMs / 1000} s`,
          ),
        );
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([
        this.#inner.getToken(scopes, { ...options, abortSignal: controller.signal }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", forward);
    }
  }
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
      pending = this.#inner.getToken(scopes, options);
      this.#pending.set(cacheKey, pending);
    }
    try {
      const token = await pending;
      if (token !== null) {
        this.#tokens.set(cacheKey, token);
      }
      return token;
    } finally {
      this.#pending.delete(cacheKey);
    }
  }
}

/**
 * Builds the credential for Key Vault requests. The sources are tried in this order, the first
 * that returns a token wins, and a source that fails with anything other than "unavailable"
 * stops the chain:
 *
 * 1. `EnvironmentCredential`: a service principal from `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and
 *    `AZURE_CLIENT_SECRET` (or `AZURE_CLIENT_CERTIFICATE_PATH`).
 * 2. `WorkloadIdentityCredential`, when `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and
 *    `AZURE_FEDERATED_TOKEN_FILE` are set (AKS workload identity, GitHub Actions OIDC).
 * 3. `AzureCliCredential` (`az login`), then `AzureDeveloperCliCredential` (`azd auth login`).
 * 4. `ManagedIdentityCredential`, user-assigned when `clientId` is given, with a time limit.
 *
 * This is the order of Foundry's Azure Key Vault signer: developer tools come before the managed
 * identity, so a local login is not delayed by the managed identity endpoint.
 *
 * @param identity - The @azure/identity module.
 * @param clientId - `AZURE_CLIENT_ID`, which selects a user-assigned managed identity.
 * @param managedIdentityTimeoutMs - The managed identity's time limit.
 * @returns The credential, shared by every Azure key of a Hardhat runtime.
 */
export function createAzureCredential(
  identity: AzureIdentitySdk,
  clientId: string | undefined,
  managedIdentityTimeoutMs: number = MANAGED_IDENTITY_TIMEOUT_MS,
): TokenCredential {
  const sources: TokenCredential[] = [new identity.EnvironmentCredential()];
  try {
    sources.push(new identity.WorkloadIdentityCredential());
  } catch (error) {
    // Its constructor fails when its variables are not set: then it is not part of the chain.
    if (!(error instanceof identity.CredentialUnavailableError)) {
      throw error;
    }
  }
  sources.push(new identity.AzureCliCredential(), new identity.AzureDeveloperCliCredential());
  const managedIdentity =
    clientId === undefined || clientId.trim() === ""
      ? new identity.ManagedIdentityCredential()
      : new identity.ManagedIdentityCredential(clientId.trim());
  sources.push(
    new TimeoutCredential(
      managedIdentity,
      managedIdentityTimeoutMs,
      identity.CredentialUnavailableError,
    ),
  );
  return new SharedTokenCredential(new identity.ChainedTokenCredential(...sources));
}
