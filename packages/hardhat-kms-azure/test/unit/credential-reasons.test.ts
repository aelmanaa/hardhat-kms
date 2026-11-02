// Checks the reason each source of the credential chain gives in `azure.credential.none`, with the
// real @azure/identity: `az` and `azd` are shell scripts in a temporary directory that is the
// whole PATH, and the managed identity's requests go to an HTTP client of the test that never
// answers. No request leaves the process. Node runs each test file in its own process, so the PATH and the variables
// changed here reach no other test.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { HttpClient } from "@azure/core-rest-pipeline";
import * as identity from "@azure/identity";
import type { TokenCredential } from "@azure/identity";

import {
  cliReason,
  credentialReasons,
  managedIdentityReason,
  noteChainReasons,
  SOURCE,
} from "../../src/internal/credential-reasons.ts";
import { createAzureCredential } from "../../src/internal/credential.ts";
import { fakeTimers } from "../helpers/fake-timers.ts";

const SCOPE = "https://vault.azure.net/.default";

/** A tenant planted in the tools' output: no reason may hold it. */
const CANARY_TENANT = "canary-tenant-6f02d1";

/** Variables that would give the chain another way to a token, or change the endpoint. */
const AZURE_VARIABLES = /^(AZURE_|MSI_|IDENTITY_|IMDS_|AZD_|IDENTITY_ENDPOINT)/;

/** `az` and `azd` as shell scripts are not run on Windows, where @azure/identity runs `.cmd`s. */
const NO_SHELL = process.platform === "win32" ? "the fake az and azd are shell scripts" : false;

/** What the fake `az` and `azd` print, by the mode in HHKMS_FAKE_CLI. */
const FAKE_CLI = `#!/bin/sh
case "$HHKMS_FAKE_CLI" in
  login) echo "ERROR: Please run 'az login' to setup account." >&2 ;;
  azd-login) echo "ERROR: not logged in, run \\\`azd auth login\\\` to login" >&2 ;;
  mfa) echo "ERROR: AADSTS50076: you must use multi-factor authentication to access '${CANARY_TENANT}'" >&2 ;;
  *) echo "ERROR: AADSTS700016: application not found in the directory '${CANARY_TENANT}'" >&2 ;;
esac
exit 1
`;

let empty = "";
let tools = "";
const saved = { ...process.env };

before(() => {
  for (const name of Object.keys(process.env)) {
    if (AZURE_VARIABLES.test(name)) {
      delete process.env[name];
    }
  }
  empty = mkdtempSync(path.join(tmpdir(), "hhkms-no-cli-"));
  tools = mkdtempSync(path.join(tmpdir(), "hhkms-fake-cli-"));
  for (const name of ["az", "azd"]) {
    writeFileSync(path.join(tools, name), FAKE_CLI);
    chmodSync(path.join(tools, name), 0o755);
  }
});

after(() => {
  process.env = saved;
  rmSync(empty, { recursive: true, force: true });
  rmSync(tools, { recursive: true, force: true });
});

/** Runs the tools in `directory`, in `mode`. */
function useTools(directory: string, mode = ""): void {
  process.env.PATH = directory;
  process.env.HHKMS_FAKE_CLI = mode;
}

/** The error `credential` fails with. */
async function failure(credential: TokenCredential, claims?: string): Promise<unknown> {
  let thrown: unknown;
  let answered = false;
  try {
    await credential.getToken(SCOPE, claims === undefined ? {} : { claims });
    answered = true;
  } catch (error) {
    thrown = error;
  }
  assert.ok(!answered, "the credential returned a token");
  return thrown;
}

/** The reason the real `az` or `azd` credential gives, run in `mode` from `directory`. */
async function cli(
  source: typeof SOURCE.azureCli | typeof SOURCE.azureDeveloperCli,
  directory: string,
  mode = "",
  claims?: string,
): Promise<string> {
  useTools(directory, mode);
  const credential =
    source === SOURCE.azureCli
      ? new identity.AzureCliCredential()
      : new identity.AzureDeveloperCliCredential();
  const error = await failure(credential, claims);
  assert.equal(error instanceof Error && error.name, "CredentialUnavailableError");
  const reason = cliReason(source, error, SCOPE, claims === undefined ? {} : { claims });
  assert.ok(!reason.includes(CANARY_TENANT), reason);
  return reason;
}

/**
 * An HTTP client that never answers. MSAL keeps the HTTP client of the first managed identity
 * that asks for a token for the whole process, so every test here uses this one;
 * managed-identity-reason.test.ts has one that fails.
 */
const silent: HttpClient = {
  sendRequest: async () => await new Promise<never>(() => {}),
};

/**
 * The error the real chain fails with, the managed identity's endpoint never answering until the
 * test fires its time limit.
 */
async function chainFailure(env: Record<string, string> = {}): Promise<unknown> {
  const timers = fakeTimers();
  const state = { settled: false };
  const token = failure(
    createAzureCredential(identity, env, { httpClient: silent, timers }),
  ).finally(() => {
    state.settled = true;
  });
  // The sources before it run first; the managed identity then waits for its time limit, unless
  // it failed by itself.
  for (let tries = 0; timers.pending() === 0 && !state.settled && tries < 1000; tries += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  timers.fire();
  return await token;
}

describe("the reason of the Azure CLI", { skip: NO_SHELL }, () => {
  it("is not installed when az is not on PATH", async () => {
    assert.equal(await cli(SOURCE.azureCli, empty), "Azure CLI: not installed");
  });

  it("is not signed in when az says to run az login", async () => {
    assert.equal(
      await cli(SOURCE.azureCli, tools, "login"),
      "Azure CLI: not signed in, run `az login`",
    );
  });

  it("is a claims challenge, with the command that answers it and no tenant", async () => {
    const claims = '{"access_token":{"acrs":{"essential":true,"value":"c1"}}}';
    const encoded = Buffer.from(claims).toString("base64");
    assert.equal(
      await cli(SOURCE.azureCli, tools, "login", claims),
      `Azure CLI: the vault asks for a new sign-in (a claims challenge), run \`az login --claims-challenge ${encoded} --scope ${SCOPE}\``,
    );
  });

  it("leaves out of the command a scope it cannot show, and a challenge it did not get", async () => {
    useTools(tools);
    const error = await failure(new identity.AzureCliCredential(), "{}");
    const start = "Azure CLI: the vault asks for a new sign-in (a claims challenge), run";
    assert.equal(
      cliReason(SOURCE.azureCli, error, ["https://vault.azure.net/.default x"], { claims: "{}" }),
      `${start} \`az login --claims-challenge e30=\``,
    );
    assert.equal(cliReason(SOURCE.azureCli, error, [], { claims: " " }), `${start} \`az login\``);
    assert.equal(
      cliReason(SOURCE.azureCli, error, SCOPE, undefined),
      `${start} \`az login --scope ${SCOPE}\``,
    );
  });

  it("is unknown for any other output, which it does not show", async () => {
    assert.equal(
      await cli(SOURCE.azureCli, tools, "other"),
      "Azure CLI: no token, for a reason hardhat-kms does not show",
    );
  });
});

describe("the reason of the Azure Developer CLI", { skip: NO_SHELL }, () => {
  it("is not installed when azd is not on PATH", async () => {
    assert.equal(await cli(SOURCE.azureDeveloperCli, empty), "Azure Developer CLI: not installed");
  });

  it("is not signed in when azd says so", async () => {
    assert.equal(
      await cli(SOURCE.azureDeveloperCli, tools, "azd-login"),
      "Azure Developer CLI: not signed in, run `azd auth login`",
    );
  });

  it("is a claims challenge when azd needs multifactor authentication", async () => {
    assert.equal(
      await cli(SOURCE.azureDeveloperCli, tools, "mfa"),
      `Azure Developer CLI: the vault asks for a new sign-in (a claims challenge), run \`azd auth login --scope ${SCOPE}\``,
    );
  });

  it("is unknown for any other output, which it does not show", async () => {
    assert.equal(
      await cli(SOURCE.azureDeveloperCli, tools, "other"),
      "Azure Developer CLI: no token, for a reason hardhat-kms does not show",
    );
  });
});

describe("the reason of the managed identity", () => {
  it("is unknown for another message, or an error that is not unavailable", () => {
    const unknown = "managed identity: no token, for a reason hardhat-kms does not show";
    const authentication = new Error("ManagedIdentityCredential: Authentication failed. Message x");
    authentication.name = "CredentialUnavailableError";
    assert.equal(managedIdentityReason(authentication, false), unknown);
    // The marker alone is not enough: the error must be the SDK's unavailable error.
    const renamed = new Error("ManagedIdentityCredential: Network unreachable. Message: x");
    assert.equal(managedIdentityReason(renamed, false), unknown);
    assert.equal(managedIdentityReason("not an error", false), unknown);
  });
});

describe("the reasons of azure.credential.none", () => {
  it("name each source in the order of the chain", { skip: NO_SHELL }, async () => {
    useTools(tools, "login");
    const error = await chainFailure();

    assert.equal(error instanceof Error && error.name, "AggregateAuthenticationError");
    assert.equal(
      credentialReasons(error),
      " By source: service principal from the environment: not set up, it needs AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET or AZURE_CLIENT_CERTIFICATE_PATH;" +
        " workload identity: not set up, it needs AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_FEDERATED_TOKEN_FILE;" +
        " Azure CLI: not signed in, run `az login`;" +
        " Azure Developer CLI: no token, for a reason hardhat-kms does not show;" +
        " managed identity: its endpoint gave no token, as happens outside Azure.",
    );
  });

  it("give the reason of a configured workload identity that fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hhkms-workload-"));
    try {
      // An empty token file makes the real WorkloadIdentityCredential unavailable at its first
      // token request.
      const tokenFile = path.join(directory, "token");
      writeFileSync(tokenFile, "");
      process.env.AZURE_TENANT_ID = "11111111-1111-1111-1111-111111111111";
      process.env.AZURE_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
      process.env.AZURE_FEDERATED_TOKEN_FILE = tokenFile;
      useTools(empty);
      const error = await chainFailure({ AZURE_TENANT_ID: process.env.AZURE_TENANT_ID });
      assert.equal(error instanceof Error && error.name, "AggregateAuthenticationError");
      const reasons = credentialReasons(error);
      assert.match(
        reasons,
        /; workload identity: no token, for a reason hardhat-kms does not show; Azure CLI: not installed;/,
      );
      assert.ok(!reasons.includes(tokenFile), reasons);
    } finally {
      delete process.env.AZURE_TENANT_ID;
      delete process.env.AZURE_CLIENT_ID;
      delete process.env.AZURE_FEDERATED_TOKEN_FILE;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("are empty for an error the chain did not note", () => {
    assert.equal(credentialReasons(new Error("other")), "");
    assert.equal(credentialReasons("not an object"), "");
    assert.equal(credentialReasons(undefined), "");
    // A chain error with no source errors and no source left out has no reasons either.
    const bare = new Error("bare");
    noteChainReasons(bare, [], []);
    assert.equal(credentialReasons(bare), "");
    noteChainReasons("not an object", ["x"], []);
  });

  it("skip a collected error the chain did not explain", () => {
    const error = Object.assign(new Error("chain"), { errors: [new Error("foreign"), "text"] });
    noteChainReasons(error, ["first: reason"], ["last: reason"]);
    assert.equal(credentialReasons(error), " By source: first: reason; last: reason.");
  });
});
