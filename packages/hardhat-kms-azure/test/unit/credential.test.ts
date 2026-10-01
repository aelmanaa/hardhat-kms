import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createHttpHeaders,
  createPipelineRequest,
  type HttpClient,
} from "@azure/core-rest-pipeline";
import type { AccessToken, GetTokenOptions, TokenCredential } from "@azure/identity";
import * as identity from "@azure/identity";

import { type AzureIdentitySdk, createAzureCredential } from "../../src/internal/credential.ts";

class CredentialUnavailableError extends Error {
  public override readonly name = "CredentialUnavailableError";
}

/** How each fake source answers: a token, "unavailable", or never. */
type Behaviour = { token: string; delayMs?: number } | "unavailable" | "hang" | "fail";

interface Recorded {
  /** Sources in the order the chain got them. */
  order: string[];
  /** Sources asked for a token, in order. */
  asked: string[];
  /** The options the managed identity was created with. */
  managedIdentityOptions: { clientId?: string; httpClient: HttpClient } | undefined;
  /** The options each source got. */
  options: Array<GetTokenOptions | undefined>;
}

/**
 * A fake @azure/identity whose sources answer as `behaviours` says, with a chain that works like
 * the real ChainedTokenCredential: unavailable sources are skipped, other errors stop it.
 */
function fakeIdentity(
  behaviours: Partial<Record<string, Behaviour>>,
  workloadConfigured = false,
): { sdk: AzureIdentitySdk; recorded: Recorded } {
  const recorded: Recorded = {
    order: [],
    asked: [],
    managedIdentityOptions: undefined,
    options: [],
  };
  const source = (name: string) =>
    class {
      public readonly sourceName = name;
      public async getToken(
        _scopes: string | string[],
        options?: GetTokenOptions,
      ): Promise<AccessToken | null> {
        recorded.asked.push(name);
        recorded.options.push(options);
        const behaviour = behaviours[name] ?? "unavailable";
        if (behaviour === "hang") {
          return await new Promise<never>((_resolve, reject) => {
            if (options?.abortSignal?.aborted === true) {
              reject(new Error("aborted"));
            }
            options?.abortSignal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          });
        }
        if (behaviour === "unavailable") {
          throw new CredentialUnavailableError(`${name} unavailable`);
        }
        if (behaviour === "fail") {
          const error = new Error("AuthenticationError");
          error.name = "AuthenticationError";
          throw error;
        }
        if (behaviour.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
        }
        return { token: behaviour.token, expiresOnTimestamp: Date.now() + 3_600_000 };
      }
    };
  const Workload = source("workload");
  const ManagedIdentity = source("managedIdentity");
  const sdk: AzureIdentitySdk = {
    ChainedTokenCredential: class implements TokenCredential {
      readonly #sources: TokenCredential[];
      public constructor(...sources: TokenCredential[]) {
        this.#sources = sources;
        recorded.order = sources.map((item) =>
          String(Reflect.get(item, "sourceName") ?? "timeout"),
        );
      }
      public async getToken(scopes: string | string[], options?: GetTokenOptions) {
        for (const item of this.#sources) {
          try {
            return await item.getToken(scopes, options);
          } catch (error) {
            if (!(error instanceof CredentialUnavailableError)) {
              throw error;
            }
          }
        }
        const error = new Error("ChainedTokenCredential authentication failed.");
        error.name = "AggregateAuthenticationError";
        throw error;
      }
    },
    EnvironmentCredential: source("environment"),
    WorkloadIdentityCredential: class extends Workload {
      public constructor() {
        super();
        if (!workloadConfigured) {
          throw new CredentialUnavailableError("WorkloadIdentityCredential: is unavailable.");
        }
      }
    },
    AzureCliCredential: source("azureCli"),
    AzureDeveloperCliCredential: source("azureDeveloperCli"),
    ManagedIdentityCredential: class extends ManagedIdentity {
      public constructor(options: { clientId?: string; httpClient: HttpClient }) {
        super();
        recorded.managedIdentityOptions = options;
      }
    },
    CredentialUnavailableError,
  };
  return { sdk, recorded };
}

const SCOPE = "https://vault.azure.net/.default";

describe("Azure credential chain", () => {
  it("is assembled from the real @azure/identity", () => {
    // The real classes fit the shape, and building the chain makes no request.
    assert.ok(createAzureCredential(identity, undefined));
    assert.ok(createAzureCredential(identity, "00000000-0000-0000-0000-000000000000"));
  });

  it("tries the environment, workload identity, az, azd, then the managed identity", async () => {
    const { sdk, recorded } = fakeIdentity({ managedIdentity: { token: "mi" } }, true);
    const credential = createAzureCredential(sdk, undefined);

    assert.equal((await credential.getToken(SCOPE))?.token, "mi");
    assert.deepEqual(recorded.asked, [
      "environment",
      "workload",
      "azureCli",
      "azureDeveloperCli",
      "managedIdentity",
    ]);
  });

  it("leaves workload identity out when its variables are not set", async () => {
    const { sdk, recorded } = fakeIdentity({ azureCli: { token: "cli" } });
    const credential = createAzureCredential(sdk, undefined);

    assert.equal((await credential.getToken(SCOPE))?.token, "cli");
    assert.deepEqual(recorded.asked, ["environment", "azureCli"]);
  });

  it("fails on a workload identity that is configured but broken", () => {
    const { sdk } = fakeIdentity({});
    const broken: AzureIdentitySdk = {
      ...sdk,
      WorkloadIdentityCredential: class {
        public constructor() {
          throw new TypeError("invalid tenant id");
        }
        public async getToken(): Promise<null> {
          return await Promise.resolve(null);
        }
      },
    };
    assert.throws(() => createAzureCredential(broken, undefined), /invalid tenant id/);
  });

  it("selects a user-assigned managed identity with AZURE_CLIENT_ID", () => {
    const user = fakeIdentity({});
    createAzureCredential(user.sdk, " 11111111-2222-3333-4444-555555555555 ");
    assert.equal(
      user.recorded.managedIdentityOptions?.clientId,
      "11111111-2222-3333-4444-555555555555",
    );

    for (const clientId of [undefined, "", "  "]) {
      const system = fakeIdentity({});
      createAzureCredential(system.sdk, clientId);
      assert.ok(system.recorded.managedIdentityOptions !== undefined);
      assert.ok(!("clientId" in system.recorded.managedIdentityOptions));
    }
  });

  it("stops at a source that fails for another reason than being unavailable", async () => {
    const { sdk, recorded } = fakeIdentity({ environment: "fail", azureCli: { token: "cli" } });
    await assert.rejects(createAzureCredential(sdk, undefined).getToken(SCOPE), {
      name: "AuthenticationError",
    });
    assert.deepEqual(recorded.asked, ["environment"]);
  });

  it("gives up on the managed identity after the time limit, as unavailable", async () => {
    const { sdk, recorded } = fakeIdentity({ managedIdentity: "hang" });
    const started = Date.now();
    await assert.rejects(createAzureCredential(sdk, undefined, { timeoutMs: 50 }).getToken(SCOPE), {
      name: "AggregateAuthenticationError",
    });
    assert.ok(Date.now() - started < 5000);
    // The managed identity's own call was aborted, so it stops retrying.
    assert.equal(recorded.options.at(-1)?.abortSignal?.aborted, true);
  });

  it("lets one caller give up without failing another that waits for the same token", async () => {
    const { sdk, recorded } = fakeIdentity({ azureCli: { token: "cli", delayMs: 50 } });
    const credential = createAzureCredential(sdk, undefined);
    const controller = new AbortController();

    const first = credential.getToken(SCOPE, { abortSignal: controller.signal });
    const second = credential.getToken(SCOPE, { abortSignal: new AbortController().signal });
    controller.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal((await second)?.token, "cli");
    // The shared call never saw a caller's signal.
    assert.ok(recorded.options.every((options) => options?.abortSignal === undefined));
    // A caller whose signal is already aborted does not wait at all.
    await assert.rejects(credential.getToken("other", { abortSignal: AbortSignal.abort() }), {
      name: "AbortError",
    });
  });

  it("gives every managed identity request a timeout within the time limit", async () => {
    const seen: Array<number | undefined> = [];
    const httpClient: HttpClient = {
      sendRequest: async (request) => {
        seen.push(request.timeout);
        return await Promise.resolve({ request, status: 200, headers: createHttpHeaders() });
      },
    };
    const { sdk, recorded } = fakeIdentity({});
    createAzureCredential(sdk, undefined, { httpClient, requestTimeoutMs: 1234 });
    const wrapped = recorded.managedIdentityOptions?.httpClient;
    assert.ok(wrapped !== undefined);
    const url = "http://169.254.169.254/metadata/identity/oauth2/token";
    await wrapped.sendRequest(createPipelineRequest({ url }));
    await wrapped.sendRequest(createPipelineRequest({ url, timeout: 100 }));
    await wrapped.sendRequest(createPipelineRequest({ url, timeout: 9999 }));
    assert.deepEqual(seen, [1234, 100, 1234]);
  });

  it("leaves out a managed identity that cannot be used here", async () => {
    const { sdk, recorded } = fakeIdentity({});
    const unavailable: AzureIdentitySdk = {
      ...sdk,
      ManagedIdentityCredential: class {
        public constructor() {
          throw new CredentialUnavailableError("not supported for CloudShell");
        }
        public async getToken(): Promise<null> {
          return await Promise.resolve(null);
        }
      },
    };
    const credential = createAzureCredential(unavailable, "client");
    await assert.rejects(credential.getToken(SCOPE), { name: "AggregateAuthenticationError" });
    assert.deepEqual(recorded.order, ["environment", "azureCli", "azureDeveloperCli"]);

    const broken: AzureIdentitySdk = {
      ...sdk,
      ManagedIdentityCredential: class {
        public constructor() {
          throw new TypeError("only one of clientId, resourceId or objectId");
        }
        public async getToken(): Promise<null> {
          return await Promise.resolve(null);
        }
      },
    };
    assert.throws(() => createAzureCredential(broken, "client"), /only one of/);
  });

  it("leaves out the real managed identity in Cloud Shell when AZURE_CLIENT_ID is set", () => {
    // MSI_ENDPOINT alone is how MSAL recognises Cloud Shell, where a client id is refused.
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../fixtures/cloud-shell.ts", import.meta.url))],
      {
        encoding: "utf8",
        env: { ...process.env, MSI_ENDPOINT: "http://127.0.0.1:50342/oauth2/token" },
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "direct: CredentialUnavailableError; chain: built");
  });

  it("shares one token between clients, per scope and tenant", async () => {
    const { sdk, recorded } = fakeIdentity({ azureCli: { token: "cli" } });
    const credential = createAzureCredential(sdk, undefined);

    // Two clients ask at once, then again: the chain runs once.
    await Promise.all([credential.getToken(SCOPE), credential.getToken([SCOPE])]);
    await credential.getToken(SCOPE);
    assert.equal(recorded.asked.filter((name) => name === "azureCli").length, 1);

    // Another tenant, another scope, or a claims challenge asks again.
    await credential.getToken(SCOPE, { tenantId: "other" });
    await credential.getToken("https://managedhsm.azure.net/.default");
    await credential.getToken(SCOPE, { claims: "{}" });
    assert.equal(recorded.asked.filter((name) => name === "azureCli").length, 4);
  });

  it("asks again for a token that is about to expire", async () => {
    let expires = Date.now() + 60_000;
    let calls = 0;
    const { sdk } = fakeIdentity({});
    const credential = createAzureCredential(
      {
        ...sdk,
        ChainedTokenCredential: class {
          public async getToken(): Promise<AccessToken | null> {
            calls += 1;
            return await Promise.resolve({ token: `t${calls}`, expiresOnTimestamp: expires });
          }
        },
      },
      undefined,
    );

    assert.equal((await credential.getToken(SCOPE))?.token, "t1");
    // One minute left is inside the refresh margin.
    expires = Date.now() + 3_600_000;
    assert.equal((await credential.getToken(SCOPE))?.token, "t2");
    assert.equal((await credential.getToken(SCOPE))?.token, "t2");
    assert.equal(calls, 2);
  });

  it("does not cache failures or empty answers", async () => {
    let calls = 0;
    const { sdk } = fakeIdentity({});
    const credential = createAzureCredential(
      {
        ...sdk,
        ChainedTokenCredential: class {
          public async getToken(): Promise<AccessToken | null> {
            calls += 1;
            if (calls === 1) {
              throw new Error("transient");
            }
            return await Promise.resolve(
              calls === 2 ? null : { token: "t", expiresOnTimestamp: Date.now() + 3_600_000 },
            );
          }
        },
      },
      undefined,
    );

    await assert.rejects(credential.getToken(SCOPE), /transient/);
    assert.equal(await credential.getToken(SCOPE), null);
    assert.equal((await credential.getToken(SCOPE))?.token, "t");
    assert.equal(calls, 3);
  });
});
