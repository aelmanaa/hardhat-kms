import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";

import hardhatKms from "../../src/index.ts";
import type { KmsKeyUserConfig } from "../../src/types.ts";
import { type FakeAdapter, fakeAdapter, type FakeAdapterOptions } from "../helpers/fake-adapter.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const ACCOUNT_0_PUBLIC_KEY = `0x${Buffer.from(
  secp256k1.getPublicKey(hex(HARDHAT_ACCOUNT_0.secretKey), false),
).toString("hex")}`;

const savedKeyId = process.env.AWS_KMS_KEY_ID;
afterEach(() => {
  if (savedKeyId === undefined) {
    Reflect.deleteProperty(process.env, "AWS_KMS_KEY_ID");
  } else {
    process.env.AWS_KMS_KEY_ID = savedKeyId;
  }
});

/** A fake adapter that counts how often it was closed. */
type ClosableAdapter = FakeAdapter & { closed: number };

function closableAdapter(
  options: Partial<FakeAdapterOptions> & { announce?: string } = {},
): ClosableAdapter {
  const adapter = Object.assign(
    fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey), ...options }),
    { closed: 0 },
  );
  adapter.close = async () => {
    adapter.closed++;
  };
  const { announce } = options;
  const getPublicKey = adapter.getPublicKey?.bind(adapter);
  if (announce !== undefined && getPublicKey !== undefined) {
    // A status line, as an adapter waiting on a slow KMS or an approval shows one.
    adapter.getPublicKey = async (ctx) => {
      await ctx.displayMessage(announce);
      return await getPublicKey(ctx);
    };
  }
  return adapter;
}

/**
 * A runtime with the given `kms.keys`, a `local` network with `kmsAccounts`, and a `kms` hook
 * handler that serves every key named in `adapters` with a closable fake adapter.
 */
async function runtime(
  options: {
    keys?: Record<string, KmsKeyUserConfig>;
    kmsAccounts?: Array<string | KmsKeyUserConfig>;
    adapters?: Record<string, () => ClosableAdapter>;
    kms?: string;
  } = {},
) {
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms],
      kms: { keys: options.keys ?? {} },
      networks: { local: { type: "edr-simulated", kmsAccounts: options.kmsAccounts ?? [] } },
    },
    options.kms === undefined ? {} : { kms: options.kms },
  );
  const created: ClosableAdapter[] = [];
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      const make = options.adapters?.[key.name];
      if (make === undefined) {
        return await next(context, key);
      }
      const adapter = make();
      created.push(adapter);
      return adapter;
    },
  });
  return { hre, created };
}

/** Runs a `kms` task and returns its result and what it printed on each stream. */
async function run(
  hre: Awaited<ReturnType<typeof runtime>>["hre"],
  name: "address" | "public-key",
  key: string,
): Promise<{ result: unknown; printed: string; stderr: string }> {
  let printed = "";
  let stderr = "";
  const write = mock.method(process.stdout, "write", (chunk: unknown) => {
    printed += String(chunk);
    return true;
  });
  const writeError = mock.method(process.stderr, "write", (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const result: unknown = await hre.tasks.getTask(["kms", name]).run({ key });
    return { result, printed, stderr };
  } finally {
    write.mock.restore();
    writeError.mock.restore();
  }
}

async function assertKmsError(
  promise: Promise<unknown>,
  includes: string[],
  excludes: string[] = [],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    for (const part of includes) {
      assert.ok(error.message.includes(part), `"${error.message}" should include "${part}"`);
    }
    for (const part of excludes) {
      assert.ok(!error.message.includes(part), `"${error.message}" should not include "${part}"`);
    }
    return true;
  });
}

describe("kms tasks", () => {
  it("defines the kms namespace as an empty task", async () => {
    const { hre } = await runtime();

    assert.equal(hre.tasks.getTask("kms").isEmpty, true);
    assert.deepEqual([...hre.tasks.getTask("kms").subtasks.keys()].toSorted(), [
      "address",
      "public-key",
    ]);
  });

  describe("kms address", () => {
    it("prints the EIP-55 address of a key in kms.keys, and closes its signer", async () => {
      const { hre, created } = await runtime({
        keys: { deployer: vaultKey("deployer") },
        adapters: { deployer: () => closableAdapter() },
      });

      const { result, printed } = await run(hre, "address", "deployer");

      assert.equal(printed, `${HARDHAT_ACCOUNT_0.address}\n`);
      assert.equal(result, HARDHAT_ACCOUNT_0.address);
      assert.equal(created.length, 1);
      assert.equal(created[0]?.calls.getPublicKey, 1);
      assert.equal(created[0]?.closed, 1);
    });

    it("asks the KMS even when the key has an address pin, and accepts a matching pin", async () => {
      const { hre, created } = await runtime({
        keys: { deployer: vaultKey("deployer", HARDHAT_ACCOUNT_0.address.toLowerCase()) },
        adapters: { deployer: () => closableAdapter() },
      });

      const { printed } = await run(hre, "address", "deployer");

      assert.equal(printed, `${HARDHAT_ACCOUNT_0.address}\n`);
      assert.equal(created[0]?.calls.getPublicKey, 1);
    });

    it("prints both addresses when the pin does not match, and still closes the signer", async () => {
      const { hre, created } = await runtime({
        keys: { deployer: vaultKey("deployer", COW_ACCOUNT.address) },
        adapters: { deployer: () => closableAdapter() },
      });

      await assertKmsError(run(hre, "address", "deployer"), [
        `the key derives to ${HARDHAT_ACCOUNT_0.address}, but the configured address is ${COW_ACCOUNT.address}`,
        "rotated",
      ]);
      assert.equal(created[0]?.closed, 1);
    });

    it("names an inline key by its network and index", async () => {
      const { hre } = await runtime({
        kmsAccounts: [vaultKey("inline")],
        adapters: { "local.kmsAccounts[0]": () => closableAdapter() },
      });

      const { printed } = await run(hre, "address", "local.kmsAccounts[0]");

      assert.equal(printed, `${HARDHAT_ACCOUNT_0.address}\n`);
    });

    it("names a --kms key by its variable", async () => {
      process.env.AWS_KMS_KEY_ID = "alias/from-env";
      const { hre } = await runtime({
        kms: "aws",
        adapters: { AWS_KMS_KEY_ID: () => closableAdapter() },
      });

      const { printed } = await run(hre, "address", "AWS_KMS_KEY_ID");

      assert.equal(printed, `${HARDHAT_ACCOUNT_0.address}\n`);
    });

    it("refuses an unknown key, listing the known names and no key ids", async () => {
      process.env.AWS_KMS_KEY_ID = "alias/env-secret-id";
      const { hre, created } = await runtime({
        keys: {
          deployer: { provider: "aws", keyId: "alias/config-secret-id" },
          ops: vaultKey("ops"),
        },
        kmsAccounts: ["deployer", { provider: "aws", keyId: "alias/inline-secret-id" }],
        kms: "aws",
      });

      await assertKmsError(
        run(hre, "address", "deployr"),
        [
          'unknown key "deployr"',
          "Known keys: deployer, ops, local.kmsAccounts[1], AWS_KMS_KEY_ID.",
        ],
        ["secret-id", "Did you mean"],
      );
      assert.equal(created.length, 0);
    });

    it("suggests the key whose name differs only in case", async () => {
      const { hre } = await runtime({
        keys: { deployer: vaultKey("deployer"), ops: vaultKey("ops") },
      });

      await assertKmsError(run(hre, "address", "Deployer"), [
        'unknown key "Deployer". Did you mean "deployer"? Known keys: deployer, ops.',
      ]);
    });

    it("prints adapter status messages on standard error, so standard output holds only the result", async () => {
      const { hre } = await runtime({
        keys: { deployer: vaultKey("deployer") },
        adapters: { deployer: () => closableAdapter({ announce: "waiting for the KMS" }) },
      });

      for (const task of ["address", "public-key"] as const) {
        const { printed, stderr } = await run(hre, task, "deployer");

        assert.match(printed, /^0x[0-9a-fA-F]+\n$/);
        assert.equal(stderr, "[hardhat-kms] waiting for the KMS\n");
      }
    });

    it("asks an address-only provider for the address even when the key has a pin", async () => {
      const { hre, created } = await runtime({
        keys: {
          matching: vaultKey("matching", HARDHAT_ACCOUNT_0.address),
          other: vaultKey("other", COW_ACCOUNT.address),
        },
        adapters: {
          matching: () => closableAdapter({ identity: "address" }),
          other: () => closableAdapter({ identity: "address" }),
        },
      });

      const { printed, stderr } = await run(hre, "address", "matching");
      assert.equal(printed, `${HARDHAT_ACCOUNT_0.address}\n`);
      assert.equal(stderr, "");
      assert.equal(created[0]?.calls.getAddress, 1);

      await assertKmsError(run(hre, "address", "other"), [
        `the key derives to ${HARDHAT_ACCOUNT_0.address}, but the configured address is ${COW_ACCOUNT.address}`,
      ]);
      assert.deepEqual(
        created.map((adapter) => adapter.closed),
        [1, 1],
      );
    });

    it("prints the pin with a note when the provider cannot report the address", async () => {
      const { hre, created } = await runtime({
        keys: { deployer: vaultKey("deployer", COW_ACCOUNT.address) },
        adapters: { deployer: () => closableAdapter({ identity: "none" }) },
      });

      const { printed, stderr } = await run(hre, "address", "deployer");

      assert.equal(printed, `${COW_ACCOUNT.address}\n`);
      assert.match(
        stderr,
        /^\[hardhat-kms\] deployer: the provider cannot report this key's address, so this is the configured `address` pin, not checked yet\./,
      );
      assert.equal(created[0]?.closed, 1);
    });

    it("says how to add a key when none is configured", async () => {
      const { hre } = await runtime();

      await assertKmsError(run(hre, "address", "deployer"), [
        'unknown key "deployer". No KMS keys are configured',
        "--kms",
      ]);
    });

    it("refuses a name that a key in kms.keys and a --kms key share", async () => {
      process.env.AWS_KMS_KEY_ID = "alias/from-env";
      const { hre } = await runtime({ keys: { AWS_KMS_KEY_ID: vaultKey("vault") }, kms: "aws" });

      await assertKmsError(run(hre, "address", "AWS_KMS_KEY_ID"), [
        '"AWS_KMS_KEY_ID" names more than one key, from kms.keys and --kms; rename the key in kms.keys',
      ]);
    });

    it("opens new signers on each run, separate from the network's", async () => {
      const { hre, created } = await runtime({
        keys: { deployer: vaultKey("deployer") },
        kmsAccounts: ["deployer"],
        // Not one of the simulated network's own accounts, so the KMS lists it.
        adapters: { deployer: () => closableAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }) },
      });
      const connection = await hre.network.create("local");
      try {
        const accounts = await connection.provider.request({ method: "eth_accounts" });
        assert.ok(Array.isArray(accounts) && accounts.includes(COW_ACCOUNT.address));

        await run(hre, "address", "deployer");
        await run(hre, "address", "deployer");

        // One adapter for the connection, which stays open, and one per task run.
        assert.deepEqual(
          created.map((adapter) => adapter.closed),
          [0, 1, 1],
        );
      } finally {
        await connection.close();
      }
    });
  });

  describe("kms public-key", () => {
    it("prints the 65-byte uncompressed public key, and closes its signer", async () => {
      const { hre, created } = await runtime({
        keys: { deployer: vaultKey("deployer") },
        adapters: { deployer: () => closableAdapter() },
      });

      const { result, printed } = await run(hre, "public-key", "deployer");

      assert.equal(printed, `${ACCOUNT_0_PUBLIC_KEY}\n`);
      assert.equal(result, ACCOUNT_0_PUBLIC_KEY);
      assert.match(ACCOUNT_0_PUBLIC_KEY, /^0x04[0-9a-f]{128}$/);
      assert.equal(created[0]?.closed, 1);
    });

    it("checks the address pin before printing", async () => {
      const { hre } = await runtime({
        keys: { deployer: vaultKey("deployer", COW_ACCOUNT.address) },
        adapters: { deployer: () => closableAdapter() },
      });

      await assertKmsError(run(hre, "public-key", "deployer"), [
        `the key derives to ${HARDHAT_ACCOUNT_0.address}, but the configured address is ${COW_ACCOUNT.address}`,
      ]);
    });

    it("explains that a provider that returns only an address has no public key to print", async () => {
      const { hre, created } = await runtime({
        keys: { deployer: vaultKey("deployer") },
        adapters: { deployer: () => closableAdapter({ identity: "address" }) },
      });

      assert.equal(
        (await run(hre, "address", "deployer")).printed,
        `${HARDHAT_ACCOUNT_0.address}\n`,
      );
      await assertKmsError(run(hre, "public-key", "deployer"), [
        "get public key",
        "the provider returns only the key's address, not its public key",
      ]);
      assert.deepEqual(
        created.map((adapter) => adapter.closed),
        [1, 1],
      );
    });
  });
});
