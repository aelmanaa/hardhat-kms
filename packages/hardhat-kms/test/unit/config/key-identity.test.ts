import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  keyIdentity,
  listBypassIdentity,
  sameListBypassIdentity,
} from "../../../src/internal/config/key-identity.ts";
import type {
  AwsKmsKeyConfig,
  KmsKeyConfig,
  AzureKmsKeyConfig,
  GcpKmsKeyConfig,
  KmsIdentifier,
  TurnkeyKmsKeyConfig,
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

function turnkey(
  organizationId: string,
  address: string,
  apiPrivateKey = "TURNKEY_API_PRIVATE_KEY",
): TurnkeyKmsKeyConfig {
  return {
    ...common,
    provider: "turnkey",
    address,
    organizationId: identifier(organizationId),
    apiPrivateKey: identifier(apiPrivateKey),
    transactionSigning: "transaction",
  };
}

const ORGANIZATION = "f81d4fae-7dec-11d0-a765-00a0c91e6bf6";
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER_ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

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

  it("gives one identity to a Turnkey account, whatever the API key or the case of the organization", async () => {
    assert.equal(
      await keyIdentity(turnkey(ORGANIZATION, ACCOUNT, "FIRST_KEY")),
      await keyIdentity(turnkey(ORGANIZATION.toUpperCase(), ACCOUNT, "SECOND_KEY")),
    );
  });

  it("tells apart two Turnkey accounts, and one account in two organizations", async () => {
    assert.notEqual(
      await keyIdentity(turnkey(ORGANIZATION, ACCOUNT)),
      await keyIdentity(turnkey(ORGANIZATION, OTHER_ACCOUNT)),
    );
    assert.notEqual(
      await keyIdentity(turnkey(ORGANIZATION, ACCOUNT)),
      await keyIdentity(turnkey("00000000-0000-0000-0000-000000000000", ACCOUNT)),
    );
  });
});

const KEY_ID = "1234abcd-12ab-34cd-56ef-1234567890ab";
const MRK_ID = "mrk-1234abcd12ab34cd56ef1234567890ab";
const VAULT = "https://v.vault.azure.net";

/** Whether the list-bypass check takes `a` and `b` for the same KMS key, both ways round. */
async function sameForListCheck(a: KmsKeyConfig, b: KmsKeyConfig): Promise<boolean> {
  const [first, second] = [await listBypassIdentity(a), await listBypassIdentity(b)];
  const same = sameListBypassIdentity(first, second);
  assert.equal(sameListBypassIdentity(second, first), same);
  return same;
}

describe("listBypassIdentity", () => {
  for (const [written, a, b] of [
    ["regions", { region: "eu-west-1" }, { region: "us-east-1" }],
    ["profiles", { profile: "ops" }, { profile: "dev" }],
    ["endpoints", { endpoint: "http://localhost:4566" }, { endpoint: "http://localhost:4567" }],
    ["a region set on one key only", { region: "eu-west-1" }, {}],
    ["a profile set on one key only", { profile: "ops" }, {}],
    ["an endpoint set on one key only", { endpoint: "http://localhost:4566" }, {}],
  ] as const) {
    it(`matches one AWS alias, and one key id, with ${written} (#589)`, async () => {
      assert.ok(await sameForListCheck(aws("alias/deployer", a), aws("alias/deployer", b)));
      assert.ok(await sameForListCheck(aws(KEY_ID, a), aws(KEY_ID, b)));
      assert.ok(await sameForListCheck(aws(MRK_ID, a), aws(MRK_ID, b)));
    });
  }

  it("matches an AWS ARN with the key id or alias name in it, in any region or account", async () => {
    assert.ok(await sameForListCheck(aws(KEY_ARN), aws(KEY_ID, { region: "us-east-1" })));
    assert.ok(await sameForListCheck(aws(ALIAS_ARN), aws("alias/deployer")));
    assert.ok(
      await sameForListCheck(
        aws(ALIAS_ARN),
        aws("arn:aws-us-gov:kms:us-gov-west-1:444455556666:alias/deployer"),
      ),
    );
  });

  it("matches an AWS key id or alias written in another case", async () => {
    assert.ok(await sameForListCheck(aws("alias/Deployer"), aws("alias/deployer")));
    assert.ok(await sameForListCheck(aws(KEY_ID.toUpperCase()), aws(KEY_ARN)));
  });

  it("tells apart two AWS keys, and a key id from an alias", async () => {
    assert.ok(!(await sameForListCheck(aws("alias/deployer"), aws("alias/sponsor"))));
    assert.ok(!(await sameForListCheck(aws("alias/key/deployer"), aws("alias/deployer"))));
    assert.ok(!(await sameForListCheck(aws(KEY_ID), aws(MRK_ID))));
    // Only the KMS knows which key an alias points to.
    assert.ok(!(await sameForListCheck(aws(KEY_ARN), aws("alias/deployer"))));
    assert.ok(!(await sameForListCheck(aws(KEY_ID), aws(ALIAS_ARN))));
  });

  it("gives an AWS key its key id or alias name in lowercase", async () => {
    assert.deepEqual(await listBypassIdentity(aws(KEY_ARN, { region: "eu-west-1" })), {
      key: `aws\0${KEY_ID}`,
    });
    assert.deepEqual(await listBypassIdentity(aws("alias/Deployer")), {
      key: "aws\0alias/deployer",
    });
  });

  it("matches one Azure key whatever the case, a trailing slash or a missing version", async () => {
    assert.ok(
      await sameForListCheck(
        azure("https://V.vault.azure.net/keys/Deployer/"),
        azure(`${VAULT}/keys/deployer`),
      ),
    );
    assert.ok(
      await sameForListCheck(azure(`${VAULT}/keys/deployer`), azure(`${VAULT}/keys/deployer/abc1`)),
    );
    assert.ok(
      await sameForListCheck(
        azure(`${VAULT}/keys/deployer/ABC1/`),
        azure(`${VAULT}/keys/deployer/abc1`),
      ),
    );
  });

  it("tells apart two Azure keys, two vaults and two versions of one key", async () => {
    assert.ok(!(await sameForListCheck(azure(`${VAULT}/keys/a`), azure(`${VAULT}/keys/b`))));
    assert.ok(
      !(await sameForListCheck(
        azure(`${VAULT}/keys/a`),
        azure("https://w.vault.azure.net/keys/a"),
      )),
    );
    assert.ok(
      !(await sameForListCheck(azure(`${VAULT}/keys/a/abc1`), azure(`${VAULT}/keys/a/abc2`))),
    );
  });

  it("gives an Azure key its lowercase key URL and version", async () => {
    assert.deepEqual(await listBypassIdentity(azure("https://V.vault.azure.net/keys/A/B1")), {
      key: "azure\0https://v.vault.azure.net/keys/a",
      version: "b1",
    });
    assert.deepEqual(await listBypassIdentity(azure("https://V.vault.azure.net/keys/A")), {
      key: "azure\0https://v.vault.azure.net/keys/a",
    });
  });

  it("compares an identifier it cannot parse as written", async () => {
    assert.deepEqual(await listBypassIdentity(azure("Not-A-Key")), { key: "azure\0Not-A-Key" });
  });

  it("compares Google Cloud and Turnkey keys as keyIdentity does", async () => {
    const version = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions";
    assert.deepEqual(await listBypassIdentity(gcp(`${version}/1`)), {
      key: await keyIdentity(gcp(`${version}/1`)),
    });
    assert.ok(!(await sameForListCheck(gcp(`${version}/1`), gcp(`${version}/2`))));
    assert.deepEqual(await listBypassIdentity(turnkey(ORGANIZATION, ACCOUNT)), {
      key: await keyIdentity(turnkey(ORGANIZATION, ACCOUNT)),
    });
  });

  it("tells apart providers that share an identifier", async () => {
    assert.ok(!(await sameForListCheck(azure("alias/a"), aws("alias/a"))));
  });

  it("matches nothing to a key without an identity, such as a third-party provider's", () => {
    assert.ok(!sameListBypassIdentity(undefined, undefined));
    assert.ok(!sameListBypassIdentity({ key: "aws\0alias/a" }, undefined));
    assert.ok(!sameListBypassIdentity(undefined, { key: "aws\0alias/a" }));
  });
});
