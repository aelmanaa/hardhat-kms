import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AccessToken, GetTokenOptions, TokenCredential } from "@azure/identity";
import * as identity from "@azure/identity";

import { type AzureIdentitySdk, createAzureCredential } from "../../src/internal/credential.ts";

class CredentialUnavailableError extends Error {
  public override readonly name = "CredentialUnavailableError";
}

/** How each fake source answers: a token, "unavailable", or never. */
type Behaviour = { token: string } | "unavailable" | "hang" | "fail";

interface Recorded {
  /** Sources in the order the chain got them. */
  order: string[];
  /** Sources asked for a token, in order. */
  asked: string[];
  /** The client id the managed identity was created with. */
  managedIdentityClientId: string | undefined;
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
    managedIdentityClientId: undefined,
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
      public constructor(clientId?: string) {
        super();
        recorded.managedIdentityClientId = clientId;
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
    assert.equal(user.recorded.managedIdentityClientId, "11111111-2222-3333-4444-555555555555");

    for (const clientId of [undefined, "", "  "]) {
      const system = fakeIdentity({});
      createAzureCredential(system.sdk, clientId);
      assert.equal(system.recorded.managedIdentityClientId, undefined);
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
    await assert.rejects(createAzureCredential(sdk, undefined, 50).getToken(SCOPE), {
      name: "AggregateAuthenticationError",
    });
    assert.ok(Date.now() - started < 5000);
    // The managed identity's own call was aborted, so it stops retrying.
    assert.equal(recorded.options.at(-1)?.abortSignal?.aborted, true);
  });

  it("aborts the managed identity when the caller gives up", async () => {
    const { sdk, recorded } = fakeIdentity({ managedIdentity: "hang" });
    const controller = new AbortController();
    const pending = createAzureCredential(sdk, undefined, 60_000).getToken(SCOPE, {
      abortSignal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, /aborted/);
    assert.equal(recorded.options.at(-1)?.abortSignal?.aborted, true);
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
