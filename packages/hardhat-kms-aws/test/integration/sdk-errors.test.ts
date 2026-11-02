import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { AwsKmsKeyConfig, KmsIdentifier } from "hardhat-kms/types";
import { HardhatPluginError } from "hardhat/plugins";

import { createAwsKeyAdapter } from "../../src/internal/adapter.ts";
import { isolateAwsEnvironment } from "../helpers/aws-env.ts";
import { KEY_ARN } from "../helpers/fake-aws-kms.ts";
import { type KmsServer, startKmsServer } from "../helpers/kms-server.ts";

/*
 * The errors the adapter explains, raised by the real AWS SDK: its credential chain, configured
 * through temporary config files and the environment, and a local KMS endpoint that answers with
 * AWS error types. Offline: the instance metadata service is disabled, the container and web
 * identity sources are unset, and every credential failure below is raised before any request.
 *
 * If a credential test fails after a Dependabot bump, the SDK changed a message the adapter reads:
 * find the new fixed phrase in the credential provider packages and update CREDENTIAL_MARKERS in
 * src/internal/adapter.ts.
 */

const secretKey = secp256k1.utils.randomSecretKey();
const sdk = { KMSClient, GetPublicKeyCommand, SignCommand };
/** A profile name that no message may show. */
const PROFILE = "team-profile-name";
const ACCOUNT = "111122223333";

/** Credential sources other than the environment and the profile, unset so none is tried. */
const OTHER_SOURCES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
];

const context = () => ({
  signal: new AbortController().signal,
  displayMessage: async () => {},
  requestId: "r1",
});

function literal(value: string): KmsIdentifier {
  return { get: async () => await Promise.resolve(value), display: value };
}

/** A key that sends to the local endpoint. */
function awsKey(
  server: KmsServer,
  keyId: string,
  settings: { region?: string; profile?: string } = {},
): AwsKmsKeyConfig {
  return {
    provider: "aws",
    name: "deployer",
    keyId: literal(keyId),
    timeoutMs: 1000,
    displayId: `aws:${keyId}`,
    endpoint: server.url,
    ...(settings.region === undefined ? {} : { region: literal(settings.region) }),
    ...(settings.profile === undefined ? {} : { profile: literal(settings.profile) }),
  };
}

/** Looks the key up through the adapter and returns what it threw. */
async function failure(key: AwsKmsKeyConfig): Promise<unknown> {
  const adapter = await createAwsKeyAdapter(key, sdk, "hardhat-kms/test");
  try {
    await adapter.getPublicKey?.(context());
    return assert.fail("the lookup did not fail");
  } catch (error) {
    return error;
  } finally {
    await adapter.close?.();
  }
}

/** Asserts a catalogued error with the expected text that shows none of the hidden details. */
function assertExplained(error: unknown, includes: string, hidden: string[]): void {
  assert.ok(error instanceof HardhatPluginError, `not explained: ${String(error)}`);
  assert.ok(error.message.includes(includes), `"${error.message}" should include "${includes}"`);
  for (const detail of hidden) {
    assert.ok(!error.message.includes(detail), `"${error.message}" shows "${detail}"`);
  }
}

describe("AWS SDK errors the adapter explains (real SDK, local endpoint)", () => {
  let directory = "";
  let restore: (() => void) | undefined;
  let server: KmsServer | undefined;

  beforeEach(() => {
    restore = isolateAwsEnvironment();
    directory = mkdtempSync(path.join(tmpdir(), "hardhat-kms-aws-errors-"));
    for (const name of OTHER_SOURCES) {
      Reflect.deleteProperty(process.env, name);
    }
    // The SSO token cache is under the home directory; the `aws login` cache has its own setting.
    process.env.HOME = directory;
    process.env.AWS_LOGIN_CACHE_DIRECTORY = path.join(directory, "login");
    process.env.AWS_CONFIG_FILE = path.join(directory, "config");
    process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(directory, "credentials");
    writeFileSync(
      process.env.AWS_SHARED_CREDENTIALS_FILE,
      "[source]\naws_access_key_id = AKIASOURCEFAKEKEYAA\naws_secret_access_key = source-secret\n",
    );
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    restore?.();
    rmSync(directory, { recursive: true, force: true });
  });

  /** The running endpoint. */
  function endpoint(): KmsServer {
    assert.ok(server !== undefined, "no endpoint is running");
    return server;
  }

  /** Writes the AWS config file. */
  function config(text: string): void {
    writeFileSync(path.join(directory, "config"), text);
  }

  /** An SSO token in the SDK's cache, expired an hour ago. */
  function expiredSsoToken(cacheKey: string): void {
    const cache = path.join(directory, ".aws", "sso", "cache");
    mkdirSync(cache, { recursive: true });
    const name = `${createHash("sha1").update(cacheKey).digest("hex")}.json`;
    const expiresAt = new Date(Date.now() - 3_600_000).toISOString();
    writeFileSync(path.join(cache, name), JSON.stringify({ accessToken: "token", expiresAt }));
  }

  describe("credentials, before any request", () => {
    beforeEach(async () => {
      server = await startKmsServer(secretKey);
    });
    afterEach(() => {
      assert.equal(server?.requests.length, 0, "a request reached the endpoint");
    });

    it("no credentials anywhere", async () => {
      const error = await failure(awsKey(endpoint(), "alias/deployer", { region: "us-east-1" }));
      assertExplained(error, "connect, key aws:alias/deployer: no AWS credentials were found", [
        directory,
      ]);
    });

    it("an SSO profile whose token was never cached (legacy sso_start_url)", async () => {
      config(
        `[profile ${PROFILE}]\nsso_start_url = https://example.awsapps.com/start\nsso_region = us-east-1\nsso_account_id = ${ACCOUNT}\nsso_role_name = signer\n`,
      );
      const error = await failure(
        awsKey(endpoint(), "alias/deployer", { region: "us-east-1", profile: PROFILE }),
      );
      assertExplained(error, "SSO) session has expired or has not started", [PROFILE, directory]);
    });

    it("an SSO profile whose cached token expired (legacy sso_start_url)", async () => {
      const startUrl = "https://example.awsapps.com/start";
      config(
        `[profile ${PROFILE}]\nsso_start_url = ${startUrl}\nsso_region = us-east-1\nsso_account_id = ${ACCOUNT}\nsso_role_name = signer\n`,
      );
      expiredSsoToken(startUrl);
      const error = await failure(
        awsKey(endpoint(), "alias/deployer", { region: "us-east-1", profile: PROFILE }),
      );
      assertExplained(error, "SSO) session has expired or has not started", [PROFILE, directory]);
    });

    it("an sso-session profile whose token was never cached", async () => {
      config(
        `[profile ${PROFILE}]\nsso_session = team\nsso_account_id = ${ACCOUNT}\nsso_role_name = signer\n[sso-session team]\nsso_start_url = https://example.awsapps.com/start\nsso_region = us-east-1\n`,
      );
      const error = await failure(
        awsKey(endpoint(), "alias/deployer", { region: "us-east-1", profile: PROFILE }),
      );
      assertExplained(error, "SSO) session has expired or has not started", [PROFILE, directory]);
    });

    it("an sso-session profile whose expired token cannot be refreshed", async () => {
      config(
        `[profile ${PROFILE}]\nsso_session = team\nsso_account_id = ${ACCOUNT}\nsso_role_name = signer\n[sso-session team]\nsso_start_url = https://example.awsapps.com/start\nsso_region = us-east-1\n`,
      );
      // No refresh token in the cache, so the SDK refuses to refresh instead of calling AWS.
      expiredSsoToken("team");
      const error = await failure(
        awsKey(endpoint(), "alias/deployer", { region: "us-east-1", profile: PROFILE }),
      );
      assertExplained(error, "SSO) session has expired or has not started", [PROFILE, directory]);
    });

    it("an `aws login` profile with no cached token", async () => {
      config(`[profile ${PROFILE}]\nlogin_session = arn:aws:iam::${ACCOUNT}:user/signer\n`);
      const error = await failure(
        awsKey(endpoint(), "alias/deployer", { region: "us-east-1", profile: PROFILE }),
      );
      assertExplained(error, "the `aws login` session has no usable token", [
        PROFILE,
        directory,
        ACCOUNT,
      ]);
    });

    it("a role profile that requires MFA", async () => {
      process.env.AWS_PROFILE = PROFILE;
      config(
        `[profile ${PROFILE}]\nrole_arn = arn:aws:iam::${ACCOUNT}:role/signer\nsource_profile = source\nmfa_serial = arn:aws:iam::${ACCOUNT}:mfa/signer\n`,
      );
      const error = await failure(awsKey(endpoint(), "alias/deployer", { region: "us-east-1" }));
      assertExplained(error, "assumes a role that needs an MFA code", [PROFILE, ACCOUNT]);
    });

    it("still says when no region is configured", async () => {
      process.env.AWS_ACCESS_KEY_ID = "test";
      process.env.AWS_SECRET_ACCESS_KEY = "test";
      const error = await failure(awsKey(endpoint(), "alias/deployer"));
      assertExplained(error, "no AWS region is configured", []);
    });
  });

  describe("AWS KMS answers", () => {
    beforeEach(() => {
      process.env.AWS_ACCESS_KEY_ID = "test";
      process.env.AWS_SECRET_ACCESS_KEY = "test";
    });

    const cases: Array<[type: string, message: string]> = [
      ["DisabledException", "get public key, key aws:alias/deployer: the key is disabled"],
      ["KMSInvalidStateException", "the key's state does not allow the call"],
      ["KeyUnavailableException", "AWS KMS could not use the key just now"],
      ["ExpiredTokenException", "the session token has expired"],
    ];
    for (const [type, message] of cases) {
      it(type, async () => {
        server = await startKmsServer(secretKey, type);
        const error = await failure(awsKey(server, "alias/deployer", { region: "us-east-1" }));
        assertExplained(error, message, [ACCOUNT]);
      });
    }

    it("NotFoundException names the region the SDK resolved from AWS_REGION", async () => {
      process.env.AWS_REGION = "ap-southeast-2";
      server = await startKmsServer(secretKey, "NotFoundException");
      const error = await failure(awsKey(server, "alias/deployer"));
      assertExplained(error, "AWS KMS has no such key in region ap-southeast-2", [ACCOUNT]);
    });

    it("AccessDeniedException names the region of the key ARN", async () => {
      server = await startKmsServer(secretKey, "AccessDeniedException");
      const error = await failure(awsKey(server, KEY_ARN, { region: "us-east-1" }));
      // The key id itself is in the prefix; the server's message, with the ARN, is not shown.
      assertExplained(error, "AWS KMS refused the call in region eu-west-1", [
        "AccessDeniedException for",
      ]);
    });

    it("passes other KMS errors on unchanged", async () => {
      server = await startKmsServer(secretKey, "InvalidKeyUsageException");
      const error = await failure(awsKey(server, "alias/deployer", { region: "us-east-1" }));
      assert.ok(!(error instanceof HardhatPluginError), String(error));
      assert.ok(error instanceof Error && error.name === "InvalidKeyUsageException", String(error));
    });
  });
});
