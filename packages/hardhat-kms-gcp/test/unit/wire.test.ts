import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authFailure,
  crc32cMatches,
  credentialFailure,
  int64Value,
  keyProject,
  networkErrorCode,
  statusOf,
} from "../../src/internal/wire.ts";
import {
  gaxiosError,
  projectLookupRefused,
  SECRET_PROJECT_NUMBER,
  tokenExchangeRefused,
} from "../helpers/auth-errors.ts";

const withCode = (code: unknown) => Object.assign(new Error("x"), { code });
const withCause = (cause: unknown) => Object.assign(new Error("x"), { cause });

describe("Google Cloud KMS wire formats", () => {
  it("reads Int64Value checksums in every form the SDK uses", () => {
    // protobufjs's Long prints itself in decimal.
    const long = { toString: () => "4294967295" };
    assert.equal(int64Value({ value: 123 }), 123);
    assert.equal(int64Value({ value: "4294967295" }), 4_294_967_295);
    assert.equal(int64Value({ value: 7n }), 7);
    assert.equal(int64Value({ value: long }), 4_294_967_295);
    for (const bad of [
      undefined,
      null,
      "123",
      {},
      { value: null },
      { value: -1 },
      { value: "1e3" },
      { value: "" },
      { value: 1.5 },
      { value: "99999999999999999" },
      { value: {} },
      { value: { toString: () => 5 } },
    ]) {
      assert.equal(int64Value(bad), undefined, JSON.stringify(bad));
    }
  });

  it("matches CRC32C only when the checksum is present and right", () => {
    const bytes = new TextEncoder().encode("123456789");
    assert.ok(crc32cMatches(bytes, { value: "3808858755" }));
    assert.ok(!crc32cMatches(bytes, { value: "3808858754" }));
    assert.ok(!crc32cMatches(bytes, undefined));
    assert.ok(!crc32cMatches(bytes, null));
  });

  it("names gRPC statuses from the SDK's numeric codes", () => {
    assert.equal(statusOf(withCode(9)), "FAILED_PRECONDITION");
    assert.equal(statusOf(withCode(16)), "UNAUTHENTICATED");
    assert.equal(statusOf(withCode(17)), undefined);
    assert.equal(statusOf(withCode("9")), undefined);
    assert.equal(statusOf(withCode(1.5)), undefined);
    assert.equal(statusOf(new Error("x")), undefined);
    assert.equal(statusOf({ code: 9 }), undefined);
  });

  it("reads the network error code under an SDK error, and nothing else", () => {
    assert.equal(networkErrorCode(withCause({ code: "ECONNREFUSED" })), "ECONNREFUSED");
    assert.equal(networkErrorCode(withCause({ code: "ENOTFOUND" })), "ENOTFOUND");
    for (const bad of [
      withCause({ code: "connect ECONNREFUSED 10.0.0.1:443" }),
      withCause({ code: 111 }),
      withCause("ECONNREFUSED"),
      withCause(undefined),
      new Error("x"),
      { cause: { code: "ECONNREFUSED" } },
    ]) {
      assert.equal(networkErrorCode(bad), undefined);
    }
  });

  it("recognises google-auth-library's credentials failures, and nothing else", () => {
    assert.equal(
      credentialFailure(new Error("Could not load the default credentials. Browse to …")),
      "noCredentials",
    );
    assert.equal(
      credentialFailure(
        new Error(
          "Unable to read the credential file specified by the GOOGLE_APPLICATION_CREDENTIALS environment variable: Unexpected token",
        ),
      ),
      "credentialsFile",
    );
    for (const other of [
      new Error("socket hang up"),
      "Could not load the default credentials",
      { message: "Could not load the default credentials" },
      undefined,
    ]) {
      assert.equal(credentialFailure(other), undefined);
    }
  });

  it("reads the project from a key version name, by id, number or domain-scoped id", () => {
    const rest = "locations/global/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1";
    for (const project of ["my-project", "123456789012", "example.com:my-project"]) {
      assert.equal(keyProject(`projects/${project}/${rest}`), project);
    }
    for (const bad of [
      "",
      `projects//${rest}`,
      `projects/./${rest}`,
      `projects/../${rest}`,
      `projects/a b/${rest}`,
      `folders/f/${rest}`,
      "projects/p",
    ]) {
      assert.equal(keyProject(bad), undefined, bad);
    }
  });

  it("recognises a refused token exchange by its OAuth error code only", () => {
    assert.deepEqual(authFailure(tokenExchangeRefused()), {
      kind: "tokenExchange",
      code: "invalid_grant",
    });
    assert.deepEqual(authFailure(tokenExchangeRefused("unauthorized_client")), {
      kind: "tokenExchange",
      code: "unauthorized_client",
    });
    // Over REST the SDK wraps it, with a gRPC status taken from the HTTP status.
    const wrapped = Object.assign(new Error("Error code invalid_grant: …"), {
      code: 3,
      cause: tokenExchangeRefused(),
    });
    assert.deepEqual(authFailure(Object.assign(new Error("x"), { code: 3, cause: wrapped })), {
      kind: "tokenExchange",
      code: "invalid_grant",
    });
    // An answer without an OAuth error gives "Error code undefined": the status and endpoint then.
    assert.deepEqual(authFailure(tokenExchangeRefused("undefined")), {
      kind: "endpoint",
      endpoint: "the token exchange (sts.googleapis.com)",
      status: 400,
    });
  });

  it("names the endpoint and the status of a refused auth request, never its path", () => {
    const lookup = authFailure(projectLookupRefused());
    assert.deepEqual(lookup, {
      kind: "endpoint",
      endpoint: "the project lookup (cloudresourcemanager.googleapis.com)",
      status: 403,
    });
    assert.doesNotMatch(JSON.stringify(lookup), new RegExp(SECRET_PROJECT_NUMBER));
    const cases: Array<[string, string]> = [
      ["https://sts.googleapis.com/v1/token", "the token exchange (sts.googleapis.com)"],
      [
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/a@b.iam.gserviceaccount.com:generateAccessToken",
        "service account impersonation (iamcredentials.googleapis.com)",
      ],
      ["https://oauth2.googleapis.com/token", "the OAuth token endpoint (oauth2.googleapis.com)"],
    ];
    for (const [url, endpoint] of cases) {
      for (const asString of [false, true]) {
        assert.deepEqual(authFailure(gaxiosError(url, 401, asString)), {
          kind: "endpoint",
          endpoint,
          status: 401,
        });
      }
    }
    // The status on the response only, as some gaxios errors carry it.
    const responseOnly = Object.assign(new Error("x"), {
      config: { url: "https://sts.googleapis.com/v1/token" },
      response: { status: 503 },
    });
    assert.equal(authFailure(responseOnly)?.kind, "endpoint");
  });

  it("leaves every other error to the caller", () => {
    for (const other of [
      // Cloud KMS's and Cloud Logging's own answers keep their usual handling.
      gaxiosError("https://cloudkms.googleapis.com/v1/projects/p/x:asymmetricSign", 403),
      gaxiosError("https://logging.googleapis.com/v2/entries:list", 403),
      gaxiosError("http://127.0.0.1:8080/v1/token", 403),
      // A label that names an object's inherited property, not an endpoint.
      gaxiosError("https://constructor.googleapis.com/x", 403),
      // No status, or no URL.
      Object.assign(new Error("x"), { config: { url: "https://sts.googleapis.com/v1/token" } }),
      Object.assign(new Error("x"), { config: { url: "not a url" }, status: 403 }),
      Object.assign(new Error("x"), { config: null, status: 403 }),
      Object.assign(new Error("x"), { status: 403 }),
      new Error("Error code Invalid_Grant: upper case is not an OAuth code"),
      new Error("an error code invalid_grant that does not start the message"),
      "Error code invalid_grant",
      { message: "Error code invalid_grant" },
      undefined,
    ]) {
      assert.equal(
        authFailure(other),
        undefined,
        other instanceof Error ? other.message : typeof other,
      );
    }
    // A cause chain is followed only so far.
    let deep: Error = tokenExchangeRefused();
    for (let depth = 0; depth < 4; depth++) {
      deep = Object.assign(new Error("x"), { cause: deep });
    }
    assert.equal(authFailure(deep), undefined);
  });
});
