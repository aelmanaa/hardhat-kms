import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keyIdentity } from "../../../src/internal/config/key-identity.ts";
import type {
  AwsKmsKeyConfig,
  AzureKmsKeyConfig,
  GcpKmsKeyConfig,
  KmsIdentifier,
} from "../../../src/types.ts";

const identifier = (value: string): KmsIdentifier => ({
  get: async () => value,
  display: value,
});

const common = { name: "k", displayId: "k", timeoutMs: 30_000 };

function aws(
  keyId: string,
  where: { region?: string; profile?: string; endpoint?: string } = {},
): AwsKmsKeyConfig {
  return {
    ...common,
    provider: "aws",
    keyId: identifier(keyId),
    ...(where.region === undefined ? {} : { region: identifier(where.region) }),
    ...(where.profile === undefined ? {} : { profile: identifier(where.profile) }),
    ...(where.endpoint === undefined ? {} : { endpoint: where.endpoint }),
  };
}

function gcp(keyVersionName: string): GcpKmsKeyConfig {
  return { ...common, provider: "gcp", keyVersionName: identifier(keyVersionName) };
}

function azure(keyId: string): AzureKmsKeyConfig {
  return { ...common, provider: "azure", keyId: identifier(keyId) };
}

const ALIAS_ARN = "arn:aws:kms:eu-west-1:111122223333:alias/deployer";
const KEY_ARN = "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";

describe("keyIdentity", () => {
  it("gives the same identity to the same AWS alias in the same place", async () => {
    const where = { region: "eu-west-1", profile: "ops", endpoint: "http://localhost:4566" };

    assert.equal(
      await keyIdentity(aws("alias/deployer", where)),
      await keyIdentity(aws("alias/deployer", where)),
    );
  });

  for (const [setting, a, b] of [
    ["region", { region: "eu-west-1" }, { region: "us-east-1" }],
    ["profile", { profile: "ops" }, { profile: "dev" }],
    ["endpoint", { endpoint: "http://localhost:4566" }, { endpoint: "http://localhost:4567" }],
    ["region, set or not", { region: "eu-west-1" }, {}],
    ["profile, set or not", { profile: "ops" }, {}],
    ["endpoint, set or not", { endpoint: "http://localhost:4566" }, {}],
  ] as const) {
    it(`tells apart one AWS alias looked up with a different ${setting}`, async () => {
      assert.notEqual(
        await keyIdentity(aws("alias/deployer", a)),
        await keyIdentity(aws("alias/deployer", b)),
      );
    });
  }

  it("ignores the region, profile and endpoint of an AWS ARN, which names its own place", async () => {
    for (const arn of [ALIAS_ARN, KEY_ARN]) {
      assert.equal(
        await keyIdentity(aws(arn, { region: "us-east-1", profile: "ops" })),
        await keyIdentity(aws(arn, { endpoint: "http://localhost:4566" })),
      );
    }
  });

  it("tells apart an AWS alias and the ARN of that alias", async () => {
    assert.notEqual(
      await keyIdentity(aws("alias/deployer", { region: "eu-west-1" })),
      await keyIdentity(aws(ALIAS_ARN)),
    );
  });

  it("tells apart two Google Cloud key versions, and two Azure keys", async () => {
    const version = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions";
    assert.equal(await keyIdentity(gcp(`${version}/1`)), await keyIdentity(gcp(`${version}/1`)));
    assert.notEqual(await keyIdentity(gcp(`${version}/1`)), await keyIdentity(gcp(`${version}/2`)));

    const vault = "https://v.vault.azure.net/keys";
    assert.equal(await keyIdentity(azure(`${vault}/a`)), await keyIdentity(azure(`${vault}/a`)));
    assert.notEqual(await keyIdentity(azure(`${vault}/a`)), await keyIdentity(azure(`${vault}/b`)));
  });

  it("tells apart providers that share an identifier", async () => {
    const id = "https://v.vault.azure.net/keys/a";
    assert.notEqual(await keyIdentity(azure(id)), await keyIdentity(gcp(id)));
  });
});
