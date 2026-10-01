import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { NetworkConnection } from "hardhat/types/network";

import hardhatKms from "../../src/index.ts";
import { createKeyAdapter } from "../../src/internal/providers/create-adapter.ts";
import type { KmsAccountUserConfig, KmsKeyConfig } from "../../src/types.ts";
import { fakeAdapter } from "../helpers/fake-adapter.ts";
import { HARDHAT_ACCOUNT_0, PERSONAL_SIGN_VECTORS } from "../helpers/vectors.ts";

const secretKey = new Uint8Array(Buffer.from(HARDHAT_ACCOUNT_0.secretKey, "hex"));
const KEY_ID_VARIABLE = "HARDHAT_KMS_TEST_OVERRIDE_KEY_ID";

/**
 * A runtime whose `remote` network (http, unreachable: the plugin answers signing requests itself)
 * has the given KMS accounts. The `kms` hook serves AWS keys with a fake adapter that reads the key
 * id, as the AWS adapter does, and counts the adapters and `getPublicKey` calls.
 */
async function runtime(kmsAccounts: KmsAccountUserConfig[]) {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms],
    kms: {
      keys: {
        deployer: { provider: "aws", keyId: "alias/deployer", region: "us-east-1" },
        fromVariable: {
          provider: "aws",
          keyId: configVariable(KEY_ID_VARIABLE),
          region: "us-east-1",
        },
      },
    },
    networks: { remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts } },
  });
  const counts = { adapters: 0, getPublicKey: 0 };
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      if (key.provider !== "aws") {
        return await next(context, key);
      }
      await key.keyId.get();
      counts.adapters++;
      const adapter = fakeAdapter({ secretKey });
      return {
        ...adapter,
        getPublicKey: async (ctx) => {
          counts.getPublicKey++;
          return await (adapter.getPublicKey?.(ctx) ?? Promise.reject(new Error("no key")));
        },
      };
    },
  });
  return { hre, counts };
}

async function personalSign(connection: NetworkConnection<string>): Promise<unknown> {
  const vector = PERSONAL_SIGN_VECTORS[0];
  return await connection.provider.request({
    method: "personal_sign",
    params: [`0x${vector.message}`, HARDHAT_ACCOUNT_0.address],
  });
}

function firstKey(connection: NetworkConnection<string>): KmsKeyConfig {
  const { networkConfig } = connection;
  assert.equal(networkConfig.type, "http");
  const key = networkConfig.kmsAccounts[0];
  assert.ok(key);
  return key;
}

describe("override connections", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, KEY_ID_VARIABLE);
  });

  it("share the signer of a plain connection, so the key is looked up once", async () => {
    const { hre, counts } = await runtime(["deployer"]);
    const plain = await hre.network.create("remote");
    const override = await hre.network.create({ network: "remote", override: { timeout: 5000 } });
    assert.notEqual(firstKey(plain), firstKey(override), "Hardhat resolved the key again");

    const vector = PERSONAL_SIGN_VECTORS[0];
    assert.equal(await personalSign(plain), vector.signature);
    assert.equal(await personalSign(override), vector.signature);
    assert.equal(counts.adapters, 1);
    assert.equal(counts.getPublicKey, 1);
    await plain.close();
    await override.close();
  });

  it("get a signer of their own when the override changes the key's profile", async () => {
    const inline = { provider: "aws", keyId: "alias/deployer", region: "us-east-1" } as const;
    const { hre, counts } = await runtime([inline]);
    const plain = await hre.network.create("remote");
    const override = await hre.network.create({
      network: "remote",
      override: { kmsAccounts: [{ ...inline, profile: "other" }] },
    });

    await personalSign(plain);
    await personalSign(override);
    assert.equal(counts.adapters, 2);
    await plain.close();
    await override.close();
  });

  it("fail with the usual error while a key's variable is unset, and retry once it is set", async () => {
    Reflect.deleteProperty(process.env, KEY_ID_VARIABLE);
    const { hre, counts } = await runtime(["fromVariable"]);
    const plain = await hre.network.create("remote");
    const override = await hre.network.create({ network: "remote", override: { timeout: 5000 } });

    // The error the adapter's creation raises without the cache.
    const expected = await createKeyAdapter(hre, firstKey(plain)).then(
      () => assert.fail("the variable is unset"),
      (error: unknown) => error,
    );
    assert.ok(expected instanceof Error);
    assert.ok(expected.message.includes(KEY_ID_VARIABLE), expected.message);
    await assert.rejects(personalSign(override), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, expected.message);
      return true;
    });

    process.env[KEY_ID_VARIABLE] = "alias/deployer";
    assert.equal(await personalSign(override), PERSONAL_SIGN_VECTORS[0].signature);
    assert.equal(await personalSign(plain), PERSONAL_SIGN_VECTORS[0].signature);
    assert.equal(counts.adapters, 1);
    assert.equal(counts.getPublicKey, 1);
    await plain.close();
    await override.close();
  });
});
