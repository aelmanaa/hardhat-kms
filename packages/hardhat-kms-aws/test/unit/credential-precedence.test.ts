import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";

import {
  GetPublicKeyCommand,
  KMSClient,
  type KMSClientConfig,
  SignCommand,
} from "@aws-sdk/client-kms";
import type { AwsKmsKeyConfig, KmsIdentifier } from "hardhat-kms/types";

import { createAwsKeyAdapter } from "../../src/internal/adapter.ts";
import { isolateAwsEnvironment } from "../helpers/aws-env.ts";

/*
 * Pins the AWS SDK for JavaScript's credential precedence that the docs describe: a profile, from a
 * key's `profile` or from AWS_PROFILE, makes the default chain skip AWS_ACCESS_KEY_ID and
 * AWS_SECRET_ACCESS_KEY. The SDK's own warning says a future version may prefer the environment
 * keys instead. If a Dependabot bump flips it, this test fails, and these docs need updating in
 * the same pull request:
 *
 * - docs/user/reference/configuration.md, "Never set a profile and environment keys together"
 * - docs/user/guides/aws-kms-setup.md, the Credentials paragraph and "One config for a laptop and CI"
 * - docs/user/guides/migrate-from-foundry.md, the AWS credentials paragraph
 *
 * Offline: the profile holds static keys in a temporary credentials file, the instance metadata
 * service is disabled and the container and web identity sources are unset, so nothing reaches the
 * network.
 */

const PROFILE_KEY_ID = "AKIAPROFILEFAKEKEYAA";
const ENV_KEY_ID = "AKIAENVIRONFAKEKEYBB";
const KEY_ARN = "arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";

const SDK_CHANGED =
  "The AWS SDK's credential precedence changed. Update the profile rule in " +
  'docs/user/reference/configuration.md ("Never set a profile and environment keys together"), ' +
  "docs/user/guides/aws-kms-setup.md and docs/user/guides/migrate-from-foundry.md, then this test.";

/** Credential sources other than the environment and the profile, unset so none is tried. */
const OTHER_SOURCES = [
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
];

/** The AWS KMS SDK the plugin loads, with a client class that records each client built. */
function recordingSdk() {
  const built: KMSClient[] = [];
  class RecordingKmsClient extends KMSClient {
    public constructor(config: KMSClientConfig) {
      super(config);
      built.push(this);
    }
  }
  return { sdk: { KMSClient: RecordingKmsClient, GetPublicKeyCommand, SignCommand }, built };
}

/** A literal setting, as hardhat-kms resolves one. */
function literal(value: string): KmsIdentifier {
  return { get: async () => await Promise.resolve(value), display: value };
}

/** A key as hardhat-kms passes it to the adapter. */
function awsKey(profile?: string): AwsKmsKeyConfig {
  return {
    provider: "aws",
    name: "deployer",
    keyId: literal(KEY_ARN),
    timeoutMs: 1000,
    displayId: `aws:${KEY_ARN}`,
    ...(profile === undefined ? {} : { profile: literal(profile) }),
  };
}

/** Builds the KMS client through the adapter, as the plugin does, and resolves its credentials. */
async function resolvedAccessKeyId(profile?: string): Promise<string> {
  const { sdk, built } = recordingSdk();
  await createAwsKeyAdapter(awsKey(profile), sdk, "hardhat-kms/test");
  const client = built[0];
  assert.ok(client !== undefined, "the adapter built no KMS client");
  try {
    const credentials = await client.config.credentials();
    return credentials.accessKeyId;
  } finally {
    client.destroy();
  }
}

describe("AWS credential precedence (pins the SDK behaviour the docs describe)", () => {
  let directory = "";
  let restore: (() => void) | undefined;

  before(() => {
    directory = mkdtempSync(path.join(tmpdir(), "hardhat-kms-aws-precedence-"));
    writeFileSync(
      path.join(directory, "credentials"),
      `[p]\naws_access_key_id = ${PROFILE_KEY_ID}\naws_secret_access_key = profile-secret\n`,
    );
    writeFileSync(path.join(directory, "config"), "[profile p]\nregion = us-east-1\n");
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  beforeEach(() => {
    restore = isolateAwsEnvironment();
    process.env.AWS_ACCESS_KEY_ID = ENV_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = "environment-secret";
    process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(directory, "credentials");
    process.env.AWS_CONFIG_FILE = path.join(directory, "config");
    process.env.AWS_EC2_METADATA_DISABLED = "true";
    for (const name of OTHER_SOURCES) {
      Reflect.deleteProperty(process.env, name);
    }
    // The SDK warns once per process when a profile and environment keys are both set.
    mock.method(console, "warn", () => {});
  });

  afterEach(() => {
    mock.restoreAll();
    restore?.();
  });

  it("uses the profile, not the environment keys, when AWS_PROFILE is set", async () => {
    process.env.AWS_PROFILE = "p";
    assert.equal(await resolvedAccessKeyId(), PROFILE_KEY_ID, SDK_CHANGED);
  });

  it("uses the profile, not the environment keys, when the key sets `profile`", async () => {
    assert.equal(await resolvedAccessKeyId("p"), PROFILE_KEY_ID, SDK_CHANGED);
  });

  // With the container and instance sources on, the chain tries them next (the docs say so); this
  // file turns them off, so the chain ends in an error.
  it("fails, without trying the environment keys, when the profile does not exist", async () => {
    await assert.rejects(
      resolvedAccessKeyId("missing"),
      (error: unknown) => {
        assert.ok(error instanceof Error, SDK_CHANGED);
        assert.equal(error.name, "CredentialsProviderError", SDK_CHANGED);
        return true;
      },
      SDK_CHANGED,
    );
  });

  it("uses the environment keys when no profile is set (control)", async () => {
    assert.equal(
      await resolvedAccessKeyId(),
      ENV_KEY_ID,
      "Without a profile the SDK should use the environment keys; the test's environment isolation is broken.",
    );
  });
});
