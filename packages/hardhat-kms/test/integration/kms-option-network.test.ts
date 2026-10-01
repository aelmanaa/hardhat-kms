import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import { addr } from "micro-eth-signer";

import hardhatKms from "../../src/index.ts";
import type { KmsKeyUserConfig } from "../../src/types.ts";
import { fakeAdapter } from "../helpers/fake-adapter.ts";
import { COW_ACCOUNT, PERSONAL_SIGN_VECTORS } from "../helpers/vectors.ts";

const VARIABLES = [
  "AWS_KMS_KEY_ID",
  "AWS_KMS_KEY_IDS",
  "GCP_PROJECT_ID",
  "GCP_LOCATION",
  "GCP_KEY_RING",
  "GCP_KEY_NAME",
  "GCP_KEY_VERSION",
  "AZURE_KEY_VAULT_KEY_ID",
] as const;
const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of VARIABLES) {
    const value = saved[name];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
});

// Each key signs with its own private key, chosen by the key's name.
const SECRET_KEYS: Record<string, string> = {
  config: COW_ACCOUNT.secretKey,
  AWS_KMS_KEY_ID: "11".repeat(32),
  "AWS_KMS_KEY_IDS[0]": "22".repeat(32),
  "AWS_KMS_KEY_IDS[1]": "33".repeat(32),
};
const addressOf = (name: string): string => addr.fromSecretKey(SECRET_KEYS[name] ?? "");

/** A runtime with one config key on `local` and `other`, started with `--kms aws`. */
async function runtime(network?: string) {
  const configKey: KmsKeyUserConfig = { provider: "aws", keyId: "alias/config" };
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms],
      kms: { keys: { config: configKey } },
      networks: {
        local: { type: "edr-simulated", kmsAccounts: ["config"] },
        other: { type: "edr-simulated", kmsAccounts: ["config"] },
        bare: { type: "edr-simulated" },
      },
    },
    { kms: "aws", ...(network === undefined ? {} : { network }) },
  );
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      const secret = SECRET_KEYS[key.name];
      return secret === undefined
        ? await next(context, key)
        : fakeAdapter({ secretKey: new Uint8Array(Buffer.from(secret, "hex")) });
    },
  });
  return hre;
}

async function kmsAccounts(hre: Awaited<ReturnType<typeof runtime>>, network: string) {
  const { provider } = await hre.network.create(network);
  const accounts = await provider.request({ method: "eth_accounts" });
  assert.ok(Array.isArray(accounts));
  // The 20 simulated accounts come first.
  return { provider, kms: accounts.slice(20) };
}

describe("--kms on networks", () => {
  it("adds the keys to the selected network, after its config keys", async () => {
    process.env.AWS_KMS_KEY_IDS = "alias/a,alias/b";
    const hre = await runtime("local");

    const { kms } = await kmsAccounts(hre, "local");
    assert.deepEqual(kms, [
      addressOf("config"),
      addressOf("AWS_KMS_KEY_IDS[0]"),
      addressOf("AWS_KMS_KEY_IDS[1]"),
    ]);
  });

  it("signs with a key chosen only on the command line", async () => {
    process.env.AWS_KMS_KEY_ID = "alias/cli";
    const hre = await runtime("bare");
    const { provider, kms } = await kmsAccounts(hre, "bare");
    const vector = PERSONAL_SIGN_VECTORS[0];

    assert.deepEqual(kms, [addressOf("AWS_KMS_KEY_ID")]);
    const signature = await provider.request({
      method: "personal_sign",
      params: [`0x${vector.message}`, addressOf("AWS_KMS_KEY_ID")],
    });
    assert.match(String(signature), /^0x[0-9a-f]{130}$/);
  });

  it("leaves other networks with their config keys only", async () => {
    process.env.AWS_KMS_KEY_ID = "alias/cli";
    const hre = await runtime("local");

    assert.deepEqual((await kmsAccounts(hre, "other")).kms, [addressOf("config")]);
  });

  it("uses the default network when --network is not given, and warns about it", async () => {
    process.env.AWS_KMS_KEY_ID = "alias/cli";
    const warn = mock.method(console, "warn", () => {});
    try {
      const hre = await runtime();
      const { provider } = await hre.network.create();
      const accounts = await provider.request({ method: "eth_accounts" });

      assert.ok(Array.isArray(accounts) && accounts.includes(addressOf("AWS_KMS_KEY_ID")));
      assert.equal(
        warn.mock.calls.filter((call) => String(call.arguments[0]).includes("`default` network"))
          .length,
        1,
      );
    } finally {
      warn.mock.restore();
    }
  });

  it("refuses a command-line key that is already a config key, by name and without its value", async () => {
    process.env.AWS_KMS_KEY_ID = "alias/config";
    const hre = await runtime("local");
    const { provider } = await hre.network.create("local");

    await assert.rejects(provider.request({ method: "eth_accounts" }), (error: unknown) => {
      assert.ok(error instanceof HardhatPluginError, String(error));
      assert.match(
        error.message,
        /AWS_KMS_KEY_ID is already networks\.local\.kmsAccounts\[0\] \("config"\); use one of them/,
      );
      assert.ok(!error.message.includes("alias/config"), "the key id is not shown");
      return true;
    });
  });

  it("refuses a command-line key that derives to a config key's account", async () => {
    // Another id for the same key, as an alias and an ARN would be: caught by address.
    process.env.AWS_KMS_KEY_ID = "alias/other-name";
    SECRET_KEYS.AWS_KMS_KEY_ID = COW_ACCOUNT.secretKey;
    try {
      const hre = await runtime("local");
      const { provider } = await hre.network.create("local");

      await assert.rejects(
        provider.request({ method: "eth_accounts" }),
        /AWS_KMS_KEY_ID and config are the same account/,
      );
    } finally {
      SECRET_KEYS.AWS_KMS_KEY_ID = "11".repeat(32);
    }
  });

  it("refuses Google Cloud and Azure command-line keys that are already config keys", async () => {
    Object.assign(process.env, {
      GCP_PROJECT_ID: "p",
      GCP_LOCATION: "l",
      GCP_KEY_RING: "r",
      GCP_KEY_NAME: "k",
      GCP_KEY_VERSION: "1",
      AZURE_KEY_VAULT_KEY_ID: "https://v.vault.azure.net/keys/k",
    });
    for (const [option, configKey, name] of [
      [
        "gcp",
        {
          provider: "gcp",
          keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
        },
        "GCP_KEY_*",
      ],
      [
        "azure",
        { provider: "azure", keyId: "https://v.vault.azure.net/keys/k" },
        "AZURE_KEY_VAULT_KEY_ID",
      ],
    ] as const) {
      const hre = await createHardhatRuntimeEnvironment(
        {
          plugins: [hardhatKms],
          kms: { keys: { cloud: configKey } },
          networks: { local: { type: "edr-simulated", kmsAccounts: ["cloud"] } },
        },
        { kms: option, network: "local" },
      );
      const { provider } = await hre.network.create("local");

      // Caught by comparing the identifiers, before any adapter is needed.
      await assert.rejects(
        provider.request({ method: "eth_accounts" }),
        new RegExp(
          `${name.replace("*", "\\*")} is already networks\\.local\\.kmsAccounts\\[0\\] \\("cloud"\\)`,
        ),
        option,
      );
    }
  });

  it("names an inline config key by its path only", async () => {
    process.env.AWS_KMS_KEY_ID = "alias/inline";
    const hre = await createHardhatRuntimeEnvironment(
      {
        plugins: [hardhatKms],
        networks: {
          local: {
            type: "edr-simulated",
            kmsAccounts: [{ provider: "aws", keyId: "alias/inline" }],
          },
        },
      },
      { kms: "aws", network: "local" },
    );
    const { provider } = await hre.network.create("local");

    await assert.rejects(provider.request({ method: "eth_accounts" }), (error: unknown) => {
      assert.ok(error instanceof HardhatPluginError, String(error));
      assert.match(
        error.message,
        /AWS_KMS_KEY_ID is already networks\.local\.kmsAccounts\[0\]; use one of them/,
      );
      return true;
    });
  });

  it("does not mistake the same AWS alias in another region or profile for a duplicate", async () => {
    process.env.AWS_KMS_KEY_ID = "alias/deployer";
    const hre = await createHardhatRuntimeEnvironment(
      {
        plugins: [hardhatKms],
        kms: {
          defaults: { aws: { region: "eu-west-1" } },
          keys: {
            config: {
              provider: "aws",
              keyId: "alias/deployer",
              region: "us-east-1",
              profile: "prod",
            },
          },
        },
        networks: { local: { type: "edr-simulated", kmsAccounts: ["config"] } },
      },
      { kms: "aws", network: "local" },
    );
    hre.hooks.registerHandlers("kms", {
      createKeyAdapter: async (context, key, next) => {
        const secret = SECRET_KEYS[key.name];
        return secret === undefined
          ? await next(context, key)
          : fakeAdapter({ secretKey: new Uint8Array(Buffer.from(secret, "hex")) });
      },
    });

    assert.deepEqual((await kmsAccounts(hre, "local")).kms, [
      addressOf("config"),
      addressOf("AWS_KMS_KEY_ID"),
    ]);
  });

  it("does not read pinned config keys to look for duplicates", async () => {
    process.env.AWS_KMS_KEY_ID = "alias/cli";
    Reflect.deleteProperty(process.env, "HHKMS_TEST_UNSET_PINNED_ID");
    const hre = await createHardhatRuntimeEnvironment(
      {
        plugins: [hardhatKms],
        kms: {
          keys: {
            config: {
              provider: "aws",
              keyId: configVariable("HHKMS_TEST_UNSET_PINNED_ID"),
              address: addressOf("config"),
            },
          },
        },
        networks: { local: { type: "edr-simulated", kmsAccounts: ["config"] } },
      },
      { kms: "aws", network: "local" },
    );
    hre.hooks.registerHandlers("kms", {
      createKeyAdapter: async (context, key, next) => {
        const secret = SECRET_KEYS[key.name];
        return secret === undefined
          ? await next(context, key)
          : fakeAdapter({ secretKey: new Uint8Array(Buffer.from(secret, "hex")) });
      },
    });

    assert.deepEqual((await kmsAccounts(hre, "local")).kms, [
      addressOf("config"),
      addressOf("AWS_KMS_KEY_ID"),
    ]);
  });

  it("funds command-line keys on a simulated network with kms.simulatedBalance", async () => {
    process.env.AWS_KMS_KEY_ID = "alias/cli";
    const hre = await createHardhatRuntimeEnvironment(
      {
        plugins: [hardhatKms],
        kms: { simulatedBalance: 5n },
        networks: { bare: { type: "edr-simulated" } },
      },
      { kms: "aws", network: "bare" },
    );
    hre.hooks.registerHandlers("kms", {
      createKeyAdapter: async (context, key, next) => {
        const secret = SECRET_KEYS[key.name];
        return secret === undefined
          ? await next(context, key)
          : fakeAdapter({ secretKey: new Uint8Array(Buffer.from(secret, "hex")) });
      },
    });
    const { provider } = await hre.network.create("bare");

    assert.equal(
      await provider.request({
        method: "eth_getBalance",
        params: [addressOf("AWS_KMS_KEY_ID"), "latest"],
      }),
      "0x5",
    );
  });
});
