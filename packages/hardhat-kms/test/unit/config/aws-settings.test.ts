// An AWS key's `profile` and `region`, and `kms.defaults.aws.region`, from configuration variables.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatError } from "@nomicfoundation/hardhat-errors";
import type { HardhatUserConfig } from "hardhat/config";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type {
  ConfigurationVariable,
  ConfigurationVariableResolver,
  ResolvedConfigurationVariable,
} from "hardhat/types/config";

import hardhatKms from "../../../src/index.ts";
import { keyIdentity } from "../../../src/internal/config/key-identity.ts";
import { resolveKmsConfig } from "../../../src/internal/config/resolve.ts";
import { signerIdentity } from "../../../src/internal/signer/signer-identity.ts";
import type { AwsKmsKeyConfig, AwsKmsKeyUserConfig, KmsKeyConfig } from "../../../src/types.ts";
import { assertError, validate } from "../../helpers/config-validation.ts";
import { fakeResolver } from "../../helpers/config-variables.ts";

const KEY_ARN = "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";

const withKey = (key: Record<string, unknown>): unknown => ({
  kms: { keys: { a: { provider: "aws", keyId: "alias/a", ...key } } },
});

/** A resolver that counts the reads of its variables (not of literals); each holds `value`. */
function countingResolver(value = "x"): {
  resolver: ConfigurationVariableResolver;
  reads: () => number;
} {
  let count = 0;
  const resolver: ConfigurationVariableResolver = (variable) => {
    const get = async (): Promise<string> => {
      if (typeof variable === "string") {
        return await Promise.resolve(variable);
      }
      count++;
      return await Promise.resolve(value);
    };
    const resolved: ResolvedConfigurationVariable = {
      _type: "ResolvedConfigurationVariable",
      format: "{variable}",
      get,
      getUrl: get,
      getBigInt: async () => BigInt(await get()),
      getHexString: get,
    };
    return resolved;
  };
  return { resolver, reads: () => count };
}

function isAws(key: KmsKeyConfig | undefined): key is AwsKmsKeyConfig {
  return key?.provider === "aws";
}

/** Resolves `kms.keys.a`, an AWS key, with the given variable values. */
function resolveAws(
  key: Omit<AwsKmsKeyUserConfig, "provider" | "keyId"> & {
    keyId?: AwsKmsKeyUserConfig["keyId"];
  },
  values: Record<string, string> | ConfigurationVariableResolver = {},
  defaultRegion?: AwsKmsKeyUserConfig["region"],
  name = "a",
): AwsKmsKeyConfig {
  const config: HardhatUserConfig = {
    kms: {
      ...(defaultRegion === undefined ? {} : { defaults: { aws: { region: defaultRegion } } }),
      keys: { [name]: { provider: "aws", keyId: "alias/a", ...key } },
    },
  };
  const resolver = typeof values === "function" ? values : fakeResolver(values);
  const resolved = resolveKmsConfig(config, resolver).keys[name];
  assert.ok(isAws(resolved));
  return resolved;
}

const PROFILE: ConfigurationVariable = configVariable("AWS_KMS_PROFILE");
const REGION: ConfigurationVariable = configVariable("AWS_KMS_REGION");

const withDefaultRegion = (region: unknown): unknown => ({
  kms: { defaults: { aws: { region } } },
});

/** The region of a key whose `region` is `AWS_KMS_REGION`, read with the given values. */
async function regionOf(
  values: Record<string, string>,
  defaultRegion?: AwsKmsKeyUserConfig["region"],
): Promise<string | undefined> {
  return await resolveAws({ region: REGION }, values, defaultRegion).region?.get();
}

/** Asserts that reading the key id fails on the ARN region check, naming the region variable. */
async function rejectsConflict(key: AwsKmsKeyConfig, secret: string): Promise<void> {
  await assert.rejects(key.keyId.get(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /kms\.keys\.a\.keyId/);
    assert.match(error.message, /conflicts with `region` \(<AWS_KMS_REGION>\)/);
    assert.ok(!error.message.includes(secret), error.message);
    return true;
  });
}

/** The signer identity of a key with this profile, where both test variables hold `dev`. */
function profileIdentity(profile: ConfigurationVariable): string | undefined {
  return signerIdentity(resolveAws({ profile }, { A: "dev", B: "dev" }));
}

describe("AWS settings from configuration variables", () => {
  describe("validation", () => {
    it("accepts a variable for profile, region and kms.defaults.aws.region", () => {
      assert.deepEqual(validate(withKey({ profile: PROFILE, region: REGION })), []);
      assert.deepEqual(validate({ kms: { defaults: { aws: { region: REGION } } } }), []);
      assert.deepEqual(
        validate(withKey({ profile: configVariable("P", { default: "" }) })),
        [],
        "the pattern that makes the profile optional",
      );
    });

    it("still rejects an empty or padded literal, in every field", () => {
      for (const field of ["profile", "region"]) {
        assertError(withKey({ [field]: "" }), `kms.keys.a.${field}`, "non-empty", 1);
        assertError(withKey({ [field]: " x" }), `kms.keys.a.${field}`, "whitespace", 1);
      }
      assertError(withDefaultRegion(""), "kms.defaults.aws.region", "non-empty", 1);
      assertError(withDefaultRegion("eu-west-1 "), "kms.defaults.aws.region", "whitespace", 1);
    });

    it("rejects any other type with a message that names both forms", () => {
      for (const value of [1, true, ["eu-west-1"], null]) {
        assertError(
          withKey({ region: value }),
          "kms.keys.a.region",
          "Expected a string or a Configuration Variable",
          1,
        );
      }
      // An object is checked as a configuration variable.
      assertError(
        withKey({ profile: { name: "P" } }),
        "kms.keys.a.profile._type",
        "ConfigurationVariable",
        1,
      );
    });

    it("leaves the ARN region check to first use when the region is a variable", () => {
      assert.deepEqual(validate(withKey({ keyId: KEY_ARN, region: REGION })), []);
    });
  });

  describe("resolution", () => {
    it("reads no variable to build the config or the signer identity", async () => {
      const { resolver, reads } = countingResolver();
      const key = resolveAws(
        { keyId: configVariable("KEY"), profile: PROFILE, region: REGION },
        resolver,
        configVariable("DEFAULT_REGION"),
      );

      assert.equal(key.profile?.display, "<AWS_KMS_PROFILE>");
      assert.equal(key.region?.display, "<AWS_KMS_REGION> or <DEFAULT_REGION>");
      assert.equal(typeof signerIdentity(key), "string");
      // Let any read that was started but not awaited run before counting.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(reads(), 0);
      assert.equal(await key.profile?.get(), "x", "the counter sees a read");
      assert.equal(reads(), 1);
    });

    it("reads a profile when asked, trimmed, and an empty one means no profile", async () => {
      assert.equal(
        await resolveAws({ profile: PROFILE }, { AWS_KMS_PROFILE: " dev " }).profile?.get(),
        "dev",
      );
      assert.equal(
        await resolveAws({ profile: PROFILE }, { AWS_KMS_PROFILE: "  " }).profile?.get(),
        "",
      );
    });

    it("orders regions: the key's variable, then kms.defaults.aws.region, then none", async () => {
      assert.equal(await regionOf({ AWS_KMS_REGION: "ap-south-1" }, "us-east-1"), "ap-south-1");
      assert.equal(await regionOf({ AWS_KMS_REGION: "" }, "us-east-1"), "us-east-1");
      assert.equal(
        await regionOf({ AWS_KMS_REGION: "", DEFAULT: "eu-north-1" }, configVariable("DEFAULT")),
        "eu-north-1",
      );
      assert.equal(
        await regionOf({ AWS_KMS_REGION: "", DEFAULT: " " }, configVariable("DEFAULT")),
        "",
      );
      assert.equal(await regionOf({ AWS_KMS_REGION: "" }), "");
    });

    it("reads kms.defaults.aws.region only when the key's own region is empty", async () => {
      let defaultReads = 0;
      const resolver: ConfigurationVariableResolver = (variable) => {
        const resolved = fakeResolver({ AWS_KMS_REGION: "ap-south-1", DEFAULT: "us-east-1" })(
          variable,
        );
        return typeof variable !== "string" && variable.name === "DEFAULT"
          ? {
              ...resolved,
              get: async () => {
                defaultReads++;
                return await resolved.get();
              },
            }
          : resolved;
      };
      const key = resolveAws({ region: REGION }, resolver, configVariable("DEFAULT"));

      assert.equal(await key.region?.get(), "ap-south-1");
      assert.equal(defaultReads, 0);
    });

    it("keeps a literal region over kms.defaults.aws.region, and shows it alone", async () => {
      const key = resolveAws({ region: "eu-central-1" }, {}, configVariable("DEFAULT"));

      assert.equal(key.region?.display, "eu-central-1");
      assert.equal(await key.region.get(), "eu-central-1");
    });

    it("uses kms.defaults.aws.region from a variable for a key without a region", async () => {
      const key = resolveAws({}, { DEFAULT: "us-west-2" }, configVariable("DEFAULT"));

      assert.equal(key.region?.display, "<DEFAULT>");
      assert.equal(await key.region.get(), "us-west-2");
    });

    it("lets a literal key ARN's region win, without reading a region variable", async () => {
      const key = resolveAws(
        { keyId: KEY_ARN, region: REGION },
        { AWS_KMS_REGION: "eu-west-1" },
        "us-east-1",
      );

      assert.equal(key.region?.display, "eu-west-1");
      assert.equal(await key.region.get(), "eu-west-1");
    });
  });

  describe("the ARN region check at first use", () => {
    it("fails a literal ARN whose region a variable contradicts, naming the variable", async () => {
      await rejectsConflict(
        resolveAws({ keyId: KEY_ARN, region: REGION }, { AWS_KMS_REGION: "ap-south-1" }),
        "ap-south-1",
      );
    });

    it("fails an ARN from a variable that a region variable contradicts", async () => {
      await rejectsConflict(
        resolveAws(
          { keyId: configVariable("KEY"), region: REGION },
          { KEY: KEY_ARN, AWS_KMS_REGION: "ap-south-1" },
        ),
        "ap-south-1",
      );
    });

    it("accepts a matching or empty region variable", async () => {
      for (const value of ["eu-west-1", "", "  "]) {
        const key = resolveAws({ keyId: KEY_ARN, region: REGION }, { AWS_KMS_REGION: value });
        assert.equal(await key.keyId.get(), KEY_ARN);
      }
    });

    it("reads no region for a key id that is not an ARN", async () => {
      const { resolver, reads } = countingResolver();
      const key = resolveAws({ region: REGION }, resolver);
      assert.equal(await key.keyId.get(), "alias/a");
      assert.equal(reads(), 0);
    });
  });

  describe("identities", () => {
    it("gives the signer identity variable names, never values", () => {
      assert.notEqual(profileIdentity(configVariable("A")), profileIdentity(configVariable("B")));
      assert.equal(profileIdentity(configVariable("A")), profileIdentity(configVariable("A")));
      assert.ok(!(profileIdentity(configVariable("A")) ?? "").includes("dev"));
    });

    it("gives a variable and a literal that hold the same profile and region one key identity", async () => {
      const values = { AWS_KMS_PROFILE: "dev", AWS_KMS_REGION: "" };
      const fromVariables = resolveAws({ profile: PROFILE, region: REGION }, values, "us-east-1");
      const literal = resolveAws({ profile: "dev" }, values, "us-east-1");
      const other = resolveAws({ profile: "ops" }, values, "us-east-1");

      assert.equal(await keyIdentity(fromVariables), await keyIdentity(literal));
      assert.notEqual(await keyIdentity(fromVariables), await keyIdentity(other));
    });

    it("treats an empty profile as no profile", async () => {
      const empty = resolveAws({ profile: configVariable("P") }, { P: "" });
      assert.equal(await keyIdentity(empty), await keyIdentity(resolveAws({}, {})));
    });
  });

  describe("an unset variable", () => {
    it("loads the config, then fails at first use with Hardhat's error naming the variable", async () => {
      Reflect.deleteProperty(process.env, "HHKMS_TEST_UNSET_PROFILE");
      const hre = await createHardhatRuntimeEnvironment({
        plugins: [hardhatKms],
        kms: {
          keys: {
            a: {
              provider: "aws",
              keyId: "alias/a",
              profile: configVariable("HHKMS_TEST_UNSET_PROFILE"),
              region: configVariable("HHKMS_TEST_UNSET_REGION", { default: "" }),
            },
          },
        },
      });
      const key = hre.config.kms.keys.a;
      assert.ok(isAws(key));

      await assert.rejects(key.profile?.get() ?? Promise.resolve(), (error: unknown) => {
        assert.ok(
          HardhatError.isHardhatError(error, HardhatError.ERRORS.CORE.GENERAL.ENV_VAR_NOT_FOUND),
        );
        assert.match(error.message, /HHKMS_TEST_UNSET_PROFILE/);
        return true;
      });
      assert.equal(await key.region?.get(), "");
    });
  });
});
