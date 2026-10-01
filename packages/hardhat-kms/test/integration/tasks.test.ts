import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it, mock } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import { getAddress, keccak256, recoverAddress, toHex, verifyMessage, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import hardhatKms from "../../src/index.ts";
import type { TypedData } from "../../src/internal/crypto/digests.ts";
import { KmsSigner } from "../../src/internal/signer/kms-signer.ts";
import type { KmsKeyUserConfig } from "../../src/types.ts";
import { type FakeAdapter, fakeAdapter, type FakeAdapterOptions } from "../helpers/fake-adapter.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import {
  COW_ACCOUNT,
  EIP712_MAIL,
  EIP712_MAIL_SIGNATURE,
  HARDHAT_ACCOUNT_0,
  PERSONAL_SIGN_VECTORS,
} from "../helpers/vectors.ts";

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
    network?: string;
    allowCrossChainTypedData?: boolean;
  } = {},
) {
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms],
      kms: {
        keys: options.keys ?? {},
        allowCrossChainTypedData: options.allowCrossChainTypedData ?? false,
      },
      networks: { local: { type: "edr-simulated", kmsAccounts: options.kmsAccounts ?? [] } },
    },
    {
      ...(options.kms === undefined ? {} : { kms: options.kms }),
      ...(options.network === undefined ? {} : { network: options.network }),
    },
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
      "sign",
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

/** The arguments of `kms sign`, with the defaults the CLI gives. */
interface SignArgs {
  key: string;
  message: string;
  data?: boolean;
  fromFile?: boolean;
  noHash?: boolean;
  chain?: string;
  allowCrossChain?: boolean;
}

/** What the last `kms sign` run printed, kept when the run fails. */
const signOutput = { printed: "", warned: "" };

/** Runs `kms sign` and returns its result and what it printed on stdout and stderr. */
async function runSign(
  hre: Awaited<ReturnType<typeof runtime>>["hre"],
  args: SignArgs,
): Promise<{ result: unknown; printed: string; warned: string }> {
  signOutput.printed = "";
  signOutput.warned = "";
  const write = mock.method(process.stdout, "write", (chunk: unknown) => {
    signOutput.printed += String(chunk);
    return true;
  });
  const writeError = mock.method(process.stderr, "write", (chunk: unknown) => {
    signOutput.warned += String(chunk);
    return true;
  });
  try {
    const result: unknown = await hre.tasks.getTask(["kms", "sign"]).run({
      data: false,
      fromFile: false,
      noHash: false,
      allowCrossChain: false,
      ...args,
    });
    return { result, ...signOutput };
  } finally {
    write.mock.restore();
    writeError.mock.restore();
  }
}

/** A runtime whose `deployer` key is {@link HARDHAT_ACCOUNT_0}, or `secretKey`. */
async function signRuntime(
  options: { secretKey?: string; network?: string; allowCrossChainTypedData?: boolean } = {},
) {
  return await runtime({
    keys: { deployer: vaultKey("deployer") },
    adapters: {
      deployer: () =>
        closableAdapter({ secretKey: hex(options.secretKey ?? HARDHAT_ACCOUNT_0.secretKey) }),
    },
    ...(options.network === undefined ? {} : { network: options.network }),
    ...(options.allowCrossChainTypedData === undefined
      ? {}
      : { allowCrossChainTypedData: options.allowCrossChainTypedData }),
  });
}

const ACCOUNT_0 = privateKeyToAccount(`0x${HARDHAT_ACCOUNT_0.secretKey}`);
const SIGNATURE = /^0x[0-9a-f]{128}(?:1b|1c)$/;
const DIGEST = keccak256(toHex("a digest the user computed"));

/** {@link EIP712_MAIL} for another chain. */
function mailOnChain(chainId: number | undefined): TypedData {
  const { chainId: _omitted, ...domain } = EIP712_MAIL.domain;
  return {
    ...EIP712_MAIL,
    types: {
      ...EIP712_MAIL.types,
      EIP712Domain: (EIP712_MAIL.types.EIP712Domain ?? []).filter(
        (field) => chainId !== undefined || field.name !== "chainId",
      ),
    },
    domain: chainId === undefined ? domain : { ...domain, chainId },
  };
}

async function verifiesMail(
  typedData: TypedData,
  signature: unknown,
  address: string,
): Promise<boolean> {
  assert.ok(typeof signature === "string" && SIGNATURE.test(signature), String(signature));
  return await verifyTypedData({
    address: getAddress(address),
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature: `0x${signature.slice(2)}`,
  });
}

describe("kms sign", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });
  function typedDataFile(typedData: unknown): string {
    directory ??= mkdtempSync(path.join(tmpdir(), "hardhat-kms-sign-"));
    const file = path.join(directory, "typed-data.json");
    writeFileSync(file, JSON.stringify(typedData));
    return file;
  }

  describe("messages", () => {
    it("signs UTF-8 text as an EIP-191 message, prints only the signature, and closes", async () => {
      const { hre, created } = await signRuntime();

      const { result, printed, warned } = await runSign(hre, {
        key: "deployer",
        message: "hello world",
      });

      assert.equal(printed, `${String(result)}\n`);
      assert.equal(warned, "");
      assert.equal(result, await ACCOUNT_0.signMessage({ message: "hello world" }));
      assert.ok(typeof result === "string" && SIGNATURE.test(result));
      assert.ok(
        await verifyMessage({
          address: ACCOUNT_0.address,
          message: "hello world",
          signature: result,
        }),
      );
      assert.equal(created[0]?.closed, 1);
    });

    it("signs a 0x value as bytes, as cast does, matching Geth and MetaMask", async () => {
      const { hre } = await signRuntime();

      for (const vector of PERSONAL_SIGN_VECTORS) {
        const { result } = await runSign(hre, {
          key: "deployer",
          message: `0x${vector.message}`,
        });

        assert.equal(result, vector.signature, vector.source);
        assert.ok(
          await verifyMessage({
            address: ACCOUNT_0.address,
            message: { raw: `0x${vector.message}` },
            signature: vector.signature,
          }),
        );
      }
    });

    it("signs a 0x value with no digits as the empty message", async () => {
      const { hre } = await signRuntime();

      const { result } = await runSign(hre, { key: "deployer", message: "0x" });

      assert.equal(result, await ACCOUNT_0.signMessage({ message: { raw: new Uint8Array() } }));
    });

    it("refuses a 0x value that is not whole bytes of hex, before any KMS call", async () => {
      const { hre, created } = await signRuntime();

      for (const message of ["0xzz", "0xabc"]) {
        await assertKmsError(runSign(hre, { key: "deployer", message }), [
          "the message is not 0x-prefixed hex with an even number of digits",
        ]);
      }
      assert.equal(created.length, 0);
    });

    it("refuses an unknown key before reading the message", async () => {
      const { hre } = await signRuntime();

      await assertKmsError(runSign(hre, { key: "nobody", message: "0xzz" }), [
        'unknown key "nobody"',
      ]);
    });
  });

  describe("--no-hash", () => {
    it("signs the 32 bytes as they are and warns on stderr", async () => {
      const { hre, created } = await signRuntime();

      const { result, printed, warned } = await runSign(hre, {
        key: "deployer",
        message: DIGEST,
        noHash: true,
      });

      assert.equal(printed, `${String(result)}\n`);
      assert.ok(typeof result === "string" && SIGNATURE.test(result));
      assert.equal(result, await ACCOUNT_0.sign({ hash: DIGEST }));
      assert.equal(
        await recoverAddress({ hash: DIGEST, signature: `0x${result.slice(2)}` }),
        ACCOUNT_0.address,
      );
      assert.match(warned, /^\[hardhat-kms\] --no-hash signs the 32 bytes as they are/);
      assert.equal(created[0]?.calls.signDigest, 1);
    });

    it("refuses anything but exactly 32 bytes, before any KMS call", async () => {
      const { hre, created } = await signRuntime();

      for (const [message, length] of [
        [DIGEST.slice(0, -2), 31],
        [`${DIGEST}00`, 33],
        ["0x", 0],
      ] as const) {
        await assertKmsError(runSign(hre, { key: "deployer", message, noHash: true }), [
          `--no-hash needs a 32-byte digest, got ${length} bytes`,
        ]);
      }
      await assertKmsError(
        runSign(hre, { key: "deployer", message: DIGEST.slice(2), noHash: true }),
        ["the --no-hash digest is not 0x-prefixed hex"],
      );
      assert.equal(created.length, 0);
    });
  });

  describe("--data", () => {
    it("signs typed data from a file, matching the EIP-712 specification's example", async () => {
      const { hre, created } = await signRuntime({ secretKey: COW_ACCOUNT.secretKey });

      const { result, printed } = await runSign(hre, {
        key: "deployer",
        message: typedDataFile(EIP712_MAIL),
        data: true,
        fromFile: true,
        chain: "1",
      });

      assert.equal(result, EIP712_MAIL_SIGNATURE);
      assert.equal(printed, `${EIP712_MAIL_SIGNATURE}\n`);
      assert.ok(await verifiesMail(EIP712_MAIL, result, COW_ACCOUNT.address));
      assert.equal(created[0]?.closed, 1);
    });

    it("signs typed data given as a JSON string", async () => {
      const { hre } = await signRuntime({ secretKey: COW_ACCOUNT.secretKey });

      const { result } = await runSign(hre, {
        key: "deployer",
        message: JSON.stringify(EIP712_MAIL),
        data: true,
        chain: "0x1",
      });

      assert.equal(result, EIP712_MAIL_SIGNATURE);
    });

    it("signs typed data without domain.chainId with no chain to compare", async () => {
      const { hre } = await signRuntime();
      const typedData = mailOnChain(undefined);

      const { result } = await runSign(hre, {
        key: "deployer",
        message: JSON.stringify(typedData),
        data: true,
      });

      assert.ok(await verifiesMail(typedData, result, HARDHAT_ACCOUNT_0.address));
    });

    it("refuses typed data that names a chain when nothing gives one to compare", async () => {
      const { hre, created } = await signRuntime();

      await assertKmsError(
        runSign(hre, { key: "deployer", message: JSON.stringify(EIP712_MAIL), data: true }),
        [
          "the typed data is for chain 1, and there is no chain to compare it with",
          "--network or --chain",
        ],
      );
      assert.equal(created.length, 0);
    });

    it("refuses typed data for another chain than --chain", async () => {
      const { hre, created } = await signRuntime();

      await assertKmsError(
        runSign(hre, {
          key: "deployer",
          message: JSON.stringify(EIP712_MAIL),
          data: true,
          chain: "31337",
        }),
        ["the typed data is for chain 1, but --chain is chain 31337", "--allow-cross-chain"],
      );
      assert.equal(created.length, 0);
    });

    it("compares with the --network connection's chain", async () => {
      const { hre } = await signRuntime({ network: "local" });
      const typedData = mailOnChain(31337);

      const { result } = await runSign(hre, {
        key: "deployer",
        message: JSON.stringify(typedData),
        data: true,
      });

      assert.ok(await verifiesMail(typedData, result, HARDHAT_ACCOUNT_0.address));
      await assertKmsError(
        runSign(hre, { key: "deployer", message: JSON.stringify(EIP712_MAIL), data: true }),
        ["the typed data is for chain 1, but network local is chain 31337"],
      );
    });

    it("lets --chain take precedence over --network", async () => {
      const { hre } = await signRuntime({ network: "local", secretKey: COW_ACCOUNT.secretKey });

      const { result } = await runSign(hre, {
        key: "deployer",
        message: JSON.stringify(EIP712_MAIL),
        data: true,
        chain: "1",
      });

      assert.equal(result, EIP712_MAIL_SIGNATURE);
    });

    it("signs for another chain with --allow-cross-chain or kms.allowCrossChainTypedData", async () => {
      const flag = await signRuntime({ network: "local", secretKey: COW_ACCOUNT.secretKey });
      const config = await signRuntime({
        allowCrossChainTypedData: true,
        secretKey: COW_ACCOUNT.secretKey,
      });
      const message = JSON.stringify(EIP712_MAIL);

      const viaFlag = await runSign(flag.hre, {
        key: "deployer",
        message,
        data: true,
        allowCrossChain: true,
      });
      const viaConfig = await runSign(config.hre, { key: "deployer", message, data: true });

      assert.equal(viaFlag.result, EIP712_MAIL_SIGNATURE);
      assert.equal(viaConfig.result, EIP712_MAIL_SIGNATURE);
    });

    it("refuses a --chain that is not a chain id, even when no check needs it", async () => {
      const { hre } = await signRuntime();

      await assertKmsError(
        runSign(hre, {
          key: "deployer",
          message: JSON.stringify(mailOnChain(undefined)),
          data: true,
          chain: "mainnet",
        }),
        ["--chain is not a chain id"],
      );
    });

    it("refuses invalid JSON, invalid typed data and a missing file", async () => {
      const { hre, created } = await signRuntime();

      await assertKmsError(runSign(hre, { key: "deployer", message: "{", data: true }), [
        "the typed data is not valid JSON",
      ]);
      await assertKmsError(runSign(hre, { key: "deployer", message: "{}", data: true }), [
        "the typed data is invalid",
      ]);
      await assertKmsError(
        runSign(hre, {
          key: "deployer",
          message: path.join(tmpdir(), "hardhat-kms-no-such-file.json"),
          data: true,
          fromFile: true,
        }),
        ["cannot read the typed data file", "(Error)"],
      );
      assert.equal(created.length, 0);
    });
  });

  it("refuses flags that do not go together", async () => {
    const { hre, created } = await signRuntime();

    await assertKmsError(runSign(hre, { key: "deployer", message: "x", fromFile: true }), [
      "--from-file requires --data",
    ]);
    await assertKmsError(
      runSign(hre, { key: "deployer", message: "{}", data: true, noHash: true }),
      ["--no-hash cannot be combined with --data"],
    );
    await assertKmsError(runSign(hre, { key: "deployer", message: "x", chain: "1" }), [
      "--chain and --allow-cross-chain apply only to --data",
    ]);
    await assertKmsError(runSign(hre, { key: "deployer", message: "x", allowCrossChain: true }), [
      "--chain and --allow-cross-chain apply only to --data",
    ]);
    assert.equal(created.length, 0);
  });

  describe("verifies each signature before printing it", () => {
    const wrongKey = privateKeyToAccount(`0x${COW_ACCOUNT.secretKey}`);
    const cases = [
      {
        mode: "a message",
        method: "signPersonalMessage",
        args: { key: "deployer", message: "hello" },
        forged: async () => await wrongKey.signMessage({ message: "hello" }),
      },
      {
        mode: "a malformed",
        method: "signPersonalMessage",
        args: { key: "deployer", message: "hello" },
        forged: async () => {
          const valid = await ACCOUNT_0.signMessage({ message: "hello" });
          return `${valid.slice(0, -2)}01`;
        },
      },
      {
        mode: "typed data",
        method: "signTypedData",
        args: { key: "deployer", message: JSON.stringify(mailOnChain(undefined)), data: true },
        forged: async () => {
          const { domain, types, primaryType, message } = mailOnChain(undefined);
          return await wrongKey.signTypedData({ domain, types, primaryType, message });
        },
      },
    ] as const;
    for (const { mode, method, args, forged } of cases) {
      it(`refuses ${mode} signature that does not recover to the key`, async () => {
        const { hre, created } = await signRuntime();
        const signature = await forged();
        const signed = mock.method(KmsSigner.prototype, method, async () => signature);
        try {
          await assertKmsError(runSign(hre, args), [
            "the signature does not recover to the key's address",
          ]);
          assert.equal(signOutput.printed, "");
          assert.equal(created[0]?.closed, 1);
        } finally {
          signed.mock.restore();
        }
      });
    }

    it("refuses a digest signature that does not recover to the key", async () => {
      const { hre } = await signRuntime();
      const signed = mock.method(KmsSigner.prototype, "signDigest", async () => {
        const forged = secp256k1.Signature.fromBytes(
          secp256k1.sign(hex(DIGEST.slice(2)), hex(COW_ACCOUNT.secretKey), {
            prehash: false,
            format: "recovered",
          }),
          "recovered",
        );
        return { r: forged.r, s: forged.s, yParity: forged.recovery === 1 ? 1 : 0 } as const;
      });
      try {
        await assertKmsError(runSign(hre, { key: "deployer", message: DIGEST, noHash: true }), [
          "the signature does not recover to the key's address",
        ]);
      } finally {
        signed.mock.restore();
      }
    });
  });
});
