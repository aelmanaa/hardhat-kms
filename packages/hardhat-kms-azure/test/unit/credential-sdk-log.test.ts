// Builds the credential chain with the real @azure/identity while @azure/logger captures every
// line at `warning` and above. The source scan in credential.test.ts catches the name of a
// password credential; this catches a path to one through any other class, since
// @azure/identity warns whenever it builds username and password sign-in. Building the chain
// sends no request, so the test stays offline. Node runs each test file in its own process, so
// the log level set here reaches no other test.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as identity from "@azure/identity";
import { AzureLogger, getLogLevel, setLogLevel } from "@azure/logger";

import { type AzureEnvironment, createAzureCredential } from "../../src/internal/credential.ts";

const CANARY = {
  user: "canary-user-e41b07",
  password: "canary-password-2f6d93",
  secret: "canary-secret-9c05ea",
  certificatePassword: "canary-certificate-password-58b1",
};

const IDS = {
  AZURE_TENANT_ID: "11111111-1111-1111-1111-111111111111",
  AZURE_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
};
const USER_AND_PASSWORD = { AZURE_USERNAME: CANARY.user, AZURE_PASSWORD: CANARY.password };

/** The deprecation @azure/identity logs for its own clients, which the plugin cannot avoid. */
const ALLOWED_DEPRECATION = /The baseUri option for SDK Clients has been deprecated/;

const lines: string[] = [];
const originalLog = AzureLogger.log;
const originalLevel = getLogLevel();

/** Builds the chain with `env`, and returns the log lines it wrote and the error it threw. */
function buildLogged(env: AzureEnvironment): { logged: string[]; error: unknown } {
  lines.length = 0;
  let error: unknown;
  try {
    createAzureCredential(identity, env);
  } catch (thrown) {
    error = thrown;
  }
  return { logged: [...lines], error };
}

function assertNoCanary(logged: string[]): void {
  for (const line of logged) {
    for (const value of Object.values(CANARY)) {
      assert.ok(!line.includes(value), `${value} was logged: ${line}`);
    }
  }
}

describe("the real @azure/identity log while the chain is built", () => {
  before(() => {
    setLogLevel("warning");
    AzureLogger.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
  });

  after(() => {
    AzureLogger.log = originalLog;
    setLogLevel(originalLevel);
  });

  it("logs no deprecation and no value when username and password sign-in is refused", () => {
    const { logged, error } = buildLogged({ ...IDS, ...USER_AND_PASSWORD });
    assert.ok(error instanceof Error);
    assert.match(error.message, /AZURE_USERNAME and AZURE_PASSWORD are set/);
    assert.deepEqual(
      logged.filter((line) => /deprecated/i.test(line)),
      [],
    );
    // Nothing at all: in 4.13.3 a UsernamePasswordCredential or ClientSecretCredential logs the
    // baseUri warning when it is built, so an empty log also shows that neither was built.
    assert.deepEqual(logged, []);
    assertNoCanary(logged);
  });

  it("logs only the upstream baseUri deprecation when a secret or certificate signs", () => {
    for (const env of [
      { ...IDS, ...USER_AND_PASSWORD, AZURE_CLIENT_SECRET: CANARY.secret },
      {
        ...IDS,
        ...USER_AND_PASSWORD,
        AZURE_CLIENT_CERTIFICATE_PATH: "/nonexistent/certificate.pem",
        AZURE_CLIENT_CERTIFICATE_PASSWORD: CANARY.certificatePassword,
        AZURE_CLIENT_SEND_CERTIFICATE_CHAIN: "1",
        AZURE_ADDITIONALLY_ALLOWED_TENANTS: "a;b",
      },
    ]) {
      const { logged, error } = buildLogged(env);
      assert.equal(error, undefined);
      const deprecations = logged.filter((line) => /deprecated/i.test(line));
      assert.deepEqual(
        deprecations.filter((line) => !ALLOWED_DEPRECATION.test(line)),
        [],
      );
      assertNoCanary(logged);
    }
  });
});
