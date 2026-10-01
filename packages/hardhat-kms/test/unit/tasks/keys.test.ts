import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";

import hardhatKms from "../../../src/index.ts";
import {
  findTaskKey,
  type TaskKey,
  taskKeys,
  withTaskSigners,
} from "../../../src/internal/tasks/keys.ts";
import { fakeAdapter } from "../../helpers/fake-adapter.ts";
import { vaultKey } from "../../helpers/vault-key.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const SECRET_KEYS: Record<string, string> = {
  deployer: HARDHAT_ACCOUNT_0.secretKey,
  ops: COW_ACCOUNT.secretKey,
};

const savedKeyId = process.env.AWS_KMS_KEY_ID;
afterEach(() => {
  if (savedKeyId === undefined) {
    Reflect.deleteProperty(process.env, "AWS_KMS_KEY_ID");
  } else {
    process.env.AWS_KMS_KEY_ID = savedKeyId;
  }
});

/** A runtime with two named keys used by two networks, one inline key, and `--kms aws`. */
async function runtime() {
  process.env.AWS_KMS_KEY_ID = "alias/from-env";
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms],
      kms: { keys: { deployer: vaultKey("deployer"), ops: vaultKey("ops") } },
      networks: {
        first: { type: "edr-simulated", kmsAccounts: ["ops", vaultKey("inline")] },
        second: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["deployer", "ops"] },
      },
    },
    { kms: "aws" },
  );
  const closed: string[] = [];
  let created = 0;
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      const secret = SECRET_KEYS[key.name];
      if (secret === undefined) {
        return await next(context, key);
      }
      created++;
      const adapter = fakeAdapter({ secretKey: hex(secret) });
      adapter.close = async () => {
        closed.push(key.name);
      };
      return adapter;
    },
  });
  return { hre, closed, created: () => created };
}

const summary = (keys: TaskKey[]) => keys.map(({ name, source }) => `${source} ${name}`);

describe("task keys", () => {
  it("lists each key once: kms.keys, inline network keys, then --kms keys", async () => {
    const { hre } = await runtime();

    assert.deepEqual(summary(taskKeys(hre)), [
      "kms.keys deployer",
      "kms.keys ops",
      "kmsAccounts first.kmsAccounts[1]",
      "--kms AWS_KMS_KEY_ID",
    ]);
  });

  it("finds a key by name and returns the resolved key", async () => {
    const { hre } = await runtime();

    assert.equal(findTaskKey(hre, "ops"), hre.config.kms.keys.ops);
    assert.equal(
      findTaskKey(hre, "first.kmsAccounts[1]").displayId,
      "myvault:first.kmsAccounts[1]",
    );
    assert.equal(findTaskKey(hre, "AWS_KMS_KEY_ID").displayId, "aws:<AWS_KMS_KEY_ID>");
    assert.throws(
      () => findTaskKey(hre, "Deployer"),
      (error: unknown) =>
        error instanceof HardhatPluginError &&
        error.message.includes(
          'unknown key "Deployer". Known keys: deployer, ops, first.kmsAccounts[1], AWS_KMS_KEY_ID.',
        ),
    );
  });

  it("opens one signer per key and closes them all, also when the task fails", async () => {
    const { hre, closed, created } = await runtime();
    const deployer = findTaskKey(hre, "deployer");
    const ops = findTaskKey(hre, "ops");

    const addresses = await withTaskSigners(hre, async (signerFor) => [
      await (await signerFor(deployer)).getAddress(),
      await (await signerFor(ops)).getAddress(),
      await (await signerFor(deployer)).getAddress(),
    ]);
    assert.deepEqual(addresses, [
      HARDHAT_ACCOUNT_0.address,
      COW_ACCOUNT.address,
      HARDHAT_ACCOUNT_0.address,
    ]);
    assert.equal(created(), 2);
    assert.deepEqual(closed.toSorted(), ["deployer", "ops"]);

    closed.length = 0;
    await assert.rejects(
      withTaskSigners(hre, async (signerFor) => {
        await signerFor(ops);
        throw new Error("task failed");
      }),
      /task failed/,
    );
    assert.deepEqual(closed, ["ops"]);
  });
});
