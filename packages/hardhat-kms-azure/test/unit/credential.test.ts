import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { format } from "node:util";

import {
  createHttpHeaders,
  createPipelineRequest,
  type HttpClient,
} from "@azure/core-rest-pipeline";
import type { AccessToken, GetTokenOptions, TokenCredential } from "@azure/identity";
import * as identity from "@azure/identity";
import type { DebugValue, KmsDebugLogger } from "hardhat-kms/provider-utils";

import {
  type AzureEnvironment,
  type AzureIdentitySdk,
  createAzureCredential,
} from "../../src/internal/credential.ts";
import { fakeTimers } from "../helpers/fake-timers.ts";

class CredentialUnavailableError extends Error {
  public override readonly name = "CredentialUnavailableError";
}

/**
 * How each fake source answers: a token (once `after` settles, if given), "unavailable", or
 * never.
 */
type Behaviour = { token: string; after?: Promise<void> } | "unavailable" | "hang" | "fail";

/** Does nothing: the placeholder until a gate's promise hands over its resolver. */
function noop(): void {}

/** A promise the test settles by hand, so no test waits on the clock. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open = noop;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Lets every pending promise callback run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

interface Recorded {
  /** Sources in the order the chain got them. */
  order: string[];
  /** Sources asked for a token, in order. */
  asked: string[];
  /** The options the managed identity was created with. */
  managedIdentityOptions: { clientId?: string; httpClient: HttpClient } | undefined;
  /** The options each source got. */
  options: Array<GetTokenOptions | undefined>;
  /** The service principal credentials built, with their constructor arguments. */
  built: Array<{ name: string; args: unknown[] }>;
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
    built: [],
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
        if (behaviour.after !== undefined) {
          await behaviour.after;
        }
        return { token: behaviour.token, expiresOnTimestamp: Date.now() + 3_600_000 };
      }
    };
  const Secret = source("secret");
  const Certificate = source("certificate");
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
    ClientSecretCredential: class extends Secret {
      public constructor(...args: [string, string, string, object]) {
        super();
        recorded.built.push({ name: "secret", args });
      }
    },
    ClientCertificateCredential: class extends Certificate {
      public constructor(...args: [string, string, object, object]) {
        super();
        recorded.built.push({ name: "certificate", args });
      }
    },
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
const TENANT = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";
const IDS = { AZURE_TENANT_ID: TENANT, AZURE_CLIENT_ID: CLIENT };

describe("Azure credential chain", () => {
  it("is assembled from the real @azure/identity", () => {
    // The real classes fit the shape, and building the chain makes no request, nor reads the
    // certificate file.
    assert.ok(createAzureCredential(identity, {}));
    assert.ok(createAzureCredential(identity, { AZURE_CLIENT_ID: CLIENT }));
    assert.ok(createAzureCredential(identity, { ...IDS, AZURE_CLIENT_SECRET: "secret" }));
    assert.ok(
      createAzureCredential(identity, {
        ...IDS,
        AZURE_CLIENT_CERTIFICATE_PATH: "/nonexistent/certificate.pem",
        AZURE_CLIENT_CERTIFICATE_PASSWORD: "password",
        AZURE_ADDITIONALLY_ALLOWED_TENANTS: "*",
        AZURE_CLIENT_SEND_CERTIFICATE_CHAIN: "true",
      }),
    );
  });

  it("tries the service principal, workload identity, az, azd, then the managed identity", async () => {
    const { sdk, recorded } = fakeIdentity({ managedIdentity: { token: "mi" } }, true);
    const credential = createAzureCredential(sdk, { ...IDS, AZURE_CLIENT_SECRET: "secret" });

    // The wrapped service principal and the managed identity's time limit have no source name.
    assert.deepEqual(recorded.order, [
      "timeout",
      "workload",
      "azureCli",
      "azureDeveloperCli",
      "timeout",
    ]);
    await assert.rejects(credential.getToken(SCOPE), { name: "AuthenticationError" });
    assert.deepEqual(recorded.asked, ["secret"]);

    const plain = fakeIdentity({ managedIdentity: { token: "mi" } }, true);
    const chain = createAzureCredential(plain.sdk, {});
    assert.equal((await chain.getToken(SCOPE))?.token, "mi");
    assert.deepEqual(plain.recorded.asked, [
      "workload",
      "azureCli",
      "azureDeveloperCli",
      "managedIdentity",
    ]);
  });

  it("cancels the managed identity time limit when the token comes in time", async () => {
    const mi = gate();
    const { sdk } = fakeIdentity({ managedIdentity: { token: "mi", after: mi.opened } });
    const timers = fakeTimers();
    const token = createAzureCredential(sdk, {}, { timers }).getToken(SCOPE);

    await settle();
    assert.deepEqual(timers.delays(), [10_000]);
    mi.open();
    assert.equal((await token)?.token, "mi");
    assert.equal(timers.pending(), 0);
  });

  it("leaves workload identity out when its variables are not set", async () => {
    const { sdk, recorded } = fakeIdentity({ azureCli: { token: "cli" } });
    const credential = createAzureCredential(sdk, {});

    assert.equal((await credential.getToken(SCOPE))?.token, "cli");
    assert.deepEqual(recorded.asked, ["azureCli"]);
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
    assert.throws(() => createAzureCredential(broken, {}), /invalid tenant id/);
  });

  it("selects a user-assigned managed identity with AZURE_CLIENT_ID", () => {
    const user = fakeIdentity({});
    createAzureCredential(user.sdk, { AZURE_CLIENT_ID: " 11111111-2222-3333-4444-555555555555 " });
    assert.equal(
      user.recorded.managedIdentityOptions?.clientId,
      "11111111-2222-3333-4444-555555555555",
    );

    for (const clientId of [undefined, "", "  "]) {
      const system = fakeIdentity({});
      createAzureCredential(
        system.sdk,
        clientId === undefined ? {} : { AZURE_CLIENT_ID: clientId },
      );
      assert.ok(system.recorded.managedIdentityOptions !== undefined);
      assert.ok(!("clientId" in system.recorded.managedIdentityOptions));
    }
  });

  it("stops at a source that fails for another reason than being unavailable", async () => {
    const { sdk, recorded } = fakeIdentity({ workload: "fail", azureCli: { token: "cli" } }, true);
    await assert.rejects(createAzureCredential(sdk, {}).getToken(SCOPE), {
      name: "AuthenticationError",
    });
    assert.deepEqual(recorded.asked, ["workload"]);
  });

  it("gives up on the managed identity after the time limit, as unavailable", async () => {
    const { sdk, recorded } = fakeIdentity({ managedIdentity: "hang" });
    const timers = fakeTimers();
    let settled = false;
    const token = createAzureCredential(sdk, {}, { timers }).getToken(SCOPE);
    token.then(
      () => (settled = true),
      () => (settled = true),
    );

    await settle();
    // The chain waits on the managed identity, with the default 10 s limit.
    assert.equal(recorded.asked.at(-1), "managedIdentity");
    assert.deepEqual(timers.delays(), [10_000]);
    assert.equal(settled, false);
    assert.equal(recorded.options.at(-1)?.abortSignal?.aborted, false);

    timers.fire();
    await assert.rejects(token, { name: "AggregateAuthenticationError" });
    // The managed identity's own call was aborted, so it stops retrying.
    assert.equal(recorded.options.at(-1)?.abortSignal?.aborted, true);
  });

  it("lets one caller give up without failing another that waits for the same token", async () => {
    const az = gate();
    const { sdk, recorded } = fakeIdentity({ azureCli: { token: "cli", after: az.opened } });
    const credential = createAzureCredential(sdk, {});
    const controller = new AbortController();

    const first = credential.getToken(SCOPE, { abortSignal: controller.signal });
    let secondSettled = false;
    const second = credential.getToken(SCOPE, { abortSignal: new AbortController().signal });
    second.then(
      () => (secondSettled = true),
      () => (secondSettled = true),
    );
    controller.abort();
    await assert.rejects(first, { name: "AbortError" });
    // The token is still on its way: the second caller keeps waiting for it.
    await settle();
    assert.equal(secondSettled, false);
    az.open();
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
    createAzureCredential(sdk, {}, { httpClient, requestTimeoutMs: 1234 });
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
    const credential = createAzureCredential(unavailable, { AZURE_CLIENT_ID: "client" });
    await assert.rejects(credential.getToken(SCOPE), { name: "AggregateAuthenticationError" });
    assert.deepEqual(recorded.order, ["azureCli", "azureDeveloperCli"]);

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
    assert.throws(
      () => createAzureCredential(broken, { AZURE_CLIENT_ID: "client" }),
      /only one of/,
    );
  });

  it("shares one token between clients, per scope and tenant", async () => {
    const { sdk, recorded } = fakeIdentity({ azureCli: { token: "cli" } });
    const credential = createAzureCredential(sdk, {});

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
      {},
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
      {},
    );

    await assert.rejects(credential.getToken(SCOPE), /transient/);
    assert.equal(await credential.getToken(SCOPE), null);
    assert.equal((await credential.getToken(SCOPE))?.token, "t");
    assert.equal(calls, 3);
  });
});

/** Values planted in the user variables and the secrets: no message or debug line may hold them. */
const CANARY = {
  user: "canary-user-5b1f0c",
  password: "canary-password-8e2d47",
  secret: "canary-secret-3a9c61",
  certificatePassword: "canary-certificate-password-71d0",
};

/** A debug logger that records its lines, formatted as the real one formats them. */
function debugLines(): { debug: KmsDebugLogger; lines: string[] } {
  const lines: string[] = [];
  const write = (text: string, ...values: DebugValue[]): void => {
    lines.push(format(text, ...values));
  };
  return { debug: Object.assign(write, { enabled: true }), lines };
}

/** Builds the chain on a fake SDK with `env`, and returns what it recorded and logged. */
function build(env: AzureEnvironment, behaviours: Partial<Record<string, Behaviour>> = {}) {
  const fake = fakeIdentity(behaviours);
  const { debug, lines } = debugLines();
  const credential = createAzureCredential(fake.sdk, env, {}, debug);
  return { credential, recorded: fake.recorded, lines };
}

/** Builds the chain with `env` and returns the error it fails with. */
function buildError(env: AzureEnvironment): { error: Error; lines: string[]; asked: string[] } {
  const fake = fakeIdentity({ workload: { token: "wi" }, azureCli: { token: "cli" } }, true);
  const { debug, lines } = debugLines();
  let thrown: unknown;
  try {
    createAzureCredential(fake.sdk, env, {}, debug);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "the chain was built");
  return { error: thrown, lines, asked: fake.recorded.asked };
}

/** Fails if any canary value appears in `texts`. */
function assertNoCanary(...texts: string[]): void {
  for (const text of texts) {
    for (const value of Object.values(CANARY)) {
      assert.ok(!text.includes(value), `${value} leaked into: ${text}`);
    }
  }
}

const USER_AND_PASSWORD = { AZURE_USERNAME: CANARY.user, AZURE_PASSWORD: CANARY.password };
const REFUSAL =
  /^azure: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_USERNAME and AZURE_PASSWORD are set, with no client secret or certificate, which selects username and password sign-in\. hardhat-kms refuses it, because that sign-in cannot do multifactor authentication\./;

describe("the service principal from the environment", () => {
  it("never names EnvironmentCredential or UsernamePasswordCredential in the source", () => {
    const root = fileURLToPath(new URL("../../src", import.meta.url));
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) =>
      file.endsWith(".ts"),
    );
    assert.ok(files.includes("internal/credential.ts".split("/").join(path.sep)));
    for (const file of files) {
      const text = readFileSync(path.join(root, file), "utf8");
      assert.doesNotMatch(text, /EnvironmentCredential|UsernamePasswordCredential/, file);
    }
  });

  it("builds ClientSecretCredential from the tenant, the client and the secret", async () => {
    const { credential, recorded, lines } = build(
      { ...IDS, AZURE_CLIENT_SECRET: CANARY.secret },
      { secret: { token: "sp" }, azureCli: { token: "cli" } },
    );
    assert.deepEqual(recorded.built, [
      { name: "secret", args: [TENANT, CLIENT, CANARY.secret, { sendCertificateChain: false }] },
    ]);
    assert.equal((await credential.getToken(SCOPE))?.token, "sp");
    assert.deepEqual(recorded.asked, ["secret"]);
    assert.deepEqual(lines, []);
  });

  it("prefers the secret when a certificate is set too", () => {
    const { recorded } = build({
      ...IDS,
      AZURE_CLIENT_SECRET: CANARY.secret,
      AZURE_CLIENT_CERTIFICATE_PATH: "/certs/sp.pem",
    });
    assert.deepEqual(
      recorded.built.map((item) => item.name),
      ["secret"],
    );
  });

  it("builds ClientCertificateCredential from the path, with the password when it is set", () => {
    const file = "/certs/sp.pem";
    const withPassword = build({
      ...IDS,
      AZURE_CLIENT_CERTIFICATE_PATH: file,
      AZURE_CLIENT_CERTIFICATE_PASSWORD: CANARY.certificatePassword,
    });
    assert.deepEqual(withPassword.recorded.built, [
      {
        name: "certificate",
        args: [
          TENANT,
          CLIENT,
          { certificatePath: file, certificatePassword: CANARY.certificatePassword },
          { sendCertificateChain: false },
        ],
      },
    ]);
    for (const password of [undefined, ""]) {
      const env: AzureEnvironment = {
        ...IDS,
        AZURE_CLIENT_SECRET: "",
        AZURE_CLIENT_CERTIFICATE_PATH: file,
        ...(password === undefined ? {} : { AZURE_CLIENT_CERTIFICATE_PASSWORD: password }),
      };
      assert.deepEqual(build(env).recorded.built, [
        {
          name: "certificate",
          args: [TENANT, CLIENT, { certificatePath: file }, { sendCertificateChain: false }],
        },
      ]);
    }
  });

  it("sends the certificate chain for true or 1, in any case", () => {
    const cases: Array<[string | undefined, boolean]> = [
      ["true", true],
      ["TRUE", true],
      ["True", true],
      ["1", true],
      ["false", false],
      ["yes", false],
      ["0", false],
      [" true", false],
      ["", false],
      [undefined, false],
    ];
    for (const [value, expected] of cases) {
      for (const source of [
        { AZURE_CLIENT_SECRET: "secret" },
        { AZURE_CLIENT_CERTIFICATE_PATH: "/certs/sp.pem" },
      ]) {
        const { recorded } = build({
          ...IDS,
          ...source,
          ...(value === undefined ? {} : { AZURE_CLIENT_SEND_CERTIFICATE_CHAIN: value }),
        });
        assert.deepEqual(
          recorded.built[0]?.args[3],
          { sendCertificateChain: expected },
          `${String(value)}, ${Object.keys(source).join()}`,
        );
      }
    }
  });

  it("passes AZURE_ADDITIONALLY_ALLOWED_TENANTS as additionallyAllowedTenants", () => {
    for (const source of [
      { AZURE_CLIENT_SECRET: "secret" },
      { AZURE_CLIENT_CERTIFICATE_PATH: "/certs/sp.pem" },
    ]) {
      const allowed = build({ ...IDS, ...source, AZURE_ADDITIONALLY_ALLOWED_TENANTS: "a;b" });
      assert.deepEqual(allowed.recorded.built[0]?.args[3], {
        additionallyAllowedTenants: ["a", "b"],
        sendCertificateChain: false,
      });
      const all = build({ ...IDS, ...source, AZURE_ADDITIONALLY_ALLOWED_TENANTS: "*" });
      assert.deepEqual(all.recorded.built[0]?.args[3], {
        additionallyAllowedTenants: ["*"],
        sendCertificateChain: false,
      });
      for (const value of [undefined, ""]) {
        const { recorded } = build({
          ...IDS,
          ...source,
          ...(value === undefined ? {} : { AZURE_ADDITIONALLY_ALLOWED_TENANTS: value }),
        });
        const options = recorded.built[0]?.args[3];
        assert.ok(typeof options === "object" && options !== null);
        assert.ok(!("additionallyAllowedTenants" in options), String(value));
      }
    }
  });

  it("builds no service principal when the tenant or the client is missing or empty", async () => {
    const partial: AzureEnvironment[] = [
      { AZURE_CLIENT_ID: CLIENT, AZURE_CLIENT_SECRET: "secret" },
      { AZURE_TENANT_ID: TENANT, AZURE_CLIENT_SECRET: "secret" },
      { AZURE_TENANT_ID: "", AZURE_CLIENT_ID: CLIENT, AZURE_CLIENT_SECRET: "secret" },
      { AZURE_TENANT_ID: TENANT, AZURE_CLIENT_ID: "", AZURE_CLIENT_SECRET: "secret" },
      { ...IDS, AZURE_CLIENT_SECRET: "", AZURE_CLIENT_CERTIFICATE_PATH: "" },
      IDS,
    ];
    for (const env of partial) {
      const fake = fakeIdentity({ workload: { token: "wi" } }, true);
      const credential = createAzureCredential(fake.sdk, env);
      assert.deepEqual(fake.recorded.built, []);
      assert.equal(fake.recorded.order[0], "workload");
      assert.equal((await credential.getToken(SCOPE))?.token, "wi");
    }
  });

  it("refuses username and password sign-in before any source is asked", () => {
    const refused: AzureEnvironment[] = [
      { ...IDS, ...USER_AND_PASSWORD },
      { ...IDS, ...USER_AND_PASSWORD, AZURE_CLIENT_SECRET: "", AZURE_CLIENT_CERTIFICATE_PATH: "" },
      {
        ...IDS,
        ...USER_AND_PASSWORD,
        // Workload identity would sign, and so would az; the refusal comes first.
        AZURE_FEDERATED_TOKEN_FILE: "/var/run/token",
        AZURE_CLIENT_CERTIFICATE_PASSWORD: CANARY.certificatePassword,
      },
    ];
    for (const env of refused) {
      const { error, lines, asked } = buildError(env);
      assert.match(error.message, REFUSAL);
      assert.match(error.message, /AZURE_CLIENT_SECRET or AZURE_CLIENT_CERTIFICATE_PATH/);
      assert.deepEqual(asked, []);
      assertNoCanary(error.message, error.stack ?? "", ...lines);
    }
  });

  it("signs with the secret or the certificate when the user variables are set too", async () => {
    for (const source of [
      { AZURE_CLIENT_SECRET: CANARY.secret },
      { AZURE_CLIENT_CERTIFICATE_PATH: "/certs/sp.pem" },
    ]) {
      const name = "AZURE_CLIENT_SECRET" in source ? "secret" : "certificate";
      const { credential, recorded, lines } = build(
        { ...IDS, ...source, ...USER_AND_PASSWORD },
        { [name]: { token: "sp" } },
      );
      assert.equal((await credential.getToken(SCOPE))?.token, "sp");
      assert.deepEqual(
        recorded.built.map((item) => item.name),
        [name],
      );
      assert.deepEqual(lines, [
        "ignored AZURE_USERNAME and AZURE_PASSWORD: hardhat-kms does not sign in with a username and password",
      ]);
      assertNoCanary(...lines);
    }
  });

  it("ignores an incomplete set of user variables, and az signs", async () => {
    const incomplete: Array<[AzureEnvironment, string]> = [
      [{ AZURE_USERNAME: CANARY.user }, "AZURE_USERNAME"],
      [{ ...IDS, AZURE_USERNAME: CANARY.user }, "AZURE_USERNAME"],
      [{ AZURE_PASSWORD: CANARY.password }, "AZURE_PASSWORD"],
      [{ ...IDS, AZURE_PASSWORD: CANARY.password }, "AZURE_PASSWORD"],
      [{ ...IDS, AZURE_USERNAME: CANARY.user, AZURE_PASSWORD: "" }, "AZURE_USERNAME"],
      [USER_AND_PASSWORD, "AZURE_USERNAME and AZURE_PASSWORD"],
      [{ AZURE_TENANT_ID: TENANT, ...USER_AND_PASSWORD }, "AZURE_USERNAME and AZURE_PASSWORD"],
      [{ AZURE_CLIENT_ID: CLIENT, ...USER_AND_PASSWORD }, "AZURE_USERNAME and AZURE_PASSWORD"],
    ];
    for (const [env, named] of incomplete) {
      const { credential, recorded, lines } = build(env, { azureCli: { token: "cli" } });
      assert.equal((await credential.getToken(SCOPE))?.token, "cli");
      assert.deepEqual(recorded.built, []);
      assert.deepEqual(recorded.asked, ["azureCli"]);
      assert.deepEqual(lines, [
        `ignored ${named}: hardhat-kms does not sign in with a username and password`,
      ]);
      assertNoCanary(...lines);
    }
  });

  it("writes no debug line when no user variable is set", () => {
    for (const env of [{}, IDS, { ...IDS, AZURE_CLIENT_SECRET: "s" }, { AZURE_USERNAME: "" }]) {
      assert.deepEqual(build(env).lines, []);
    }
  });

  it("stops the chain when the selected service principal fails, for any reason", async () => {
    for (const behaviour of ["unavailable", "fail"] as const) {
      for (const source of [
        { AZURE_CLIENT_SECRET: CANARY.secret },
        { AZURE_CLIENT_CERTIFICATE_PATH: "/certs/sp.pem" },
      ]) {
        const name = "AZURE_CLIENT_SECRET" in source ? "secret" : "certificate";
        const { credential, recorded } = build(
          { ...IDS, ...source },
          { [name]: behaviour, azureCli: { token: "cli" } },
        );
        const error: unknown = await credential.getToken(SCOPE).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        assert.ok(error instanceof Error);
        assert.equal(error.name, "AuthenticationError");
        assert.equal(error.message, "the service principal from the environment could not sign in");
        // The inner error is not kept, not even as the cause: its text can carry request details.
        assert.equal(error.cause, undefined);
        // az is not asked: the chain does not fall through to another identity.
        assert.deepEqual(recorded.asked, [name]);
        assertNoCanary(error.message);
      }
    }
  });

  it("fails on an invalid AZURE_TENANT_ID when the chain is built", () => {
    const tenant = "tenant/with space";
    for (const env of [
      { AZURE_TENANT_ID: tenant },
      { AZURE_TENANT_ID: tenant, AZURE_CLIENT_ID: CLIENT, AZURE_CLIENT_SECRET: "secret" },
      { AZURE_TENANT_ID: tenant, AZURE_CLIENT_ID: CLIENT, ...USER_AND_PASSWORD },
    ]) {
      const { error, asked } = buildError(env);
      assert.equal(
        error.message,
        "azure: AZURE_TENANT_ID is not a tenant id: it may hold only letters, digits, hyphens (-) and dots (.)",
      );
      assert.ok(!error.message.includes(tenant));
      assert.deepEqual(asked, []);
    }
    // Letters, digits, - and . pass, such as a domain name.
    assert.ok(build({ AZURE_TENANT_ID: "contoso.onmicrosoft.com" }).credential);
  });
});
