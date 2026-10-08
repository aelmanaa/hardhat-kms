import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import { isResult } from "hardhat/utils/result";
import { privateKeyToAccount } from "viem/accounts";

import hardhatKms from "../../src/index.ts";
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
const N = secp256k1.Point.CURVE().n;
const account0 = privateKeyToAccount(`0x${HARDHAT_ACCOUNT_0.secretKey}`);
const [GETH] = PERSONAL_SIGN_VECTORS;
const GETH_MESSAGE = `0x${GETH.message}`;
const COW_SPENDER: `0x${string}` = "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826";

/** A fake adapter that counts its calls and how often it was closed. */
type ClosableAdapter = FakeAdapter & { closed: number };

function closableAdapter(
  secretKey: string,
  identity: FakeAdapterOptions["identity"] = "publicKey",
): ClosableAdapter {
  const adapter = Object.assign(fakeAdapter({ secretKey: hex(secretKey), identity }), {
    closed: 0,
  });
  adapter.close = async () => {
    adapter.closed++;
  };
  return adapter;
}

/** How the fake adapter of each key behaves: whose key it holds, and what it can report. */
const ADAPTERS: Record<string, () => ClosableAdapter> = {
  deployer: () => closableAdapter(HARDHAT_ACCOUNT_0.secretKey),
  cow: () => closableAdapter(COW_ACCOUNT.secretKey),
  "address-only": () => closableAdapter(HARDHAT_ACCOUNT_0.secretKey, "address"),
  "no-identity": () => closableAdapter(HARDHAT_ACCOUNT_0.secretKey, "none"),
};

/**
 * A runtime with keys served by fake adapters: `deployer` (Hardhat account 0) and `cow`, and two
 * keys of Hardhat account 0 pinned to its address, whose adapters report only the address
 * (`address-only`) or nothing (`no-identity`). `created` holds every adapter the tasks opened.
 */
async function runtime() {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms],
    kms: {
      keys: {
        deployer: vaultKey("deployer"),
        cow: vaultKey("cow"),
        "address-only": vaultKey("address-only", HARDHAT_ACCOUNT_0.address),
        "no-identity": vaultKey("no-identity", HARDHAT_ACCOUNT_0.address),
      },
    },
  });
  const created: ClosableAdapter[] = [];
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      const make = ADAPTERS[key.name];
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

type Hre = Awaited<ReturnType<typeof runtime>>["hre"];

interface VerifyRun {
  message: string;
  signature: string;
  address?: string;
  key?: string;
  data?: boolean;
  fromFile?: boolean;
}

/** Runs `kms verify` and returns its result and what it wrote to stdout and stderr. */
async function verify(
  hre: Hre,
  args: VerifyRun,
): Promise<{ result: unknown; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const out = mock.method(process.stdout, "write", (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  const err = mock.method(process.stderr, "write", (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const result: unknown = await hre.tasks.getTask(["kms", "verify"]).run({ ...args });
    return { result, stdout, stderr };
  } finally {
    out.mock.restore();
    err.mock.restore();
  }
}

async function assertKmsError(
  promise: Promise<unknown>,
  ...includes: [string, ...string[]]
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HardhatPluginError, String(error));
    for (const part of includes) {
      assert.ok(error.message.includes(part), `"${error.message}" should include "${part}"`);
    }
    return true;
  });
}

/** Rewrites the `v` byte of a 65-byte signature. */
function withV(signature: string, v: number): string {
  return `${signature.slice(0, 130)}${v.toString(16).padStart(2, "0")}`;
}

/** The high-S twin of a low-S signature, with the recovery bit flipped so it recovers the same key. */
function highSTwin(signature: string): string {
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130), 16);
  return `${signature.slice(0, 66)}${(N - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;
}

let dir: string;
const file = (name: string, content: string): string => {
  const where = path.join(dir, name);
  writeFileSync(where, content);
  return where;
};

describe("kms verify", () => {
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hardhat-kms-verify-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("with --address", () => {
    it("accepts a personal_sign signature over hex bytes, without opening any adapter", async () => {
      const { hre, created } = await runtime();

      const { result, stdout, stderr } = await verify(hre, {
        message: GETH_MESSAGE,
        signature: GETH.signature,
        address: HARDHAT_ACCOUNT_0.address,
      });

      assert.equal(stdout, `Valid: ${HARDHAT_ACCOUNT_0.address} signed this message.\n`);
      assert.equal(stderr, "");
      assert.deepEqual(result, { success: true, value: { address: HARDHAT_ACCOUNT_0.address } });
      assert.equal(created.length, 0);
    });

    it("matches a lowercase address, and prints it checksummed", async () => {
      const { hre } = await runtime();

      const { result, stdout } = await verify(hre, {
        message: GETH_MESSAGE,
        signature: GETH.signature,
        address: HARDHAT_ACCOUNT_0.address.toLowerCase(),
      });

      assert.equal(stdout, `Valid: ${HARDHAT_ACCOUNT_0.address} signed this message.\n`);
      assert.deepEqual(result, { success: true, value: { address: HARDHAT_ACCOUNT_0.address } });
    });

    it("reads a message without 0x as UTF-8 text, as cast does", async () => {
      const { hre } = await runtime();
      const signature = await account0.signMessage({ message: "hello, kms ✓" });

      const text = await verify(hre, {
        message: "hello, kms ✓",
        signature,
        address: HARDHAT_ACCOUNT_0.address,
      });
      const bytes = await verify(hre, {
        message: `0x${Buffer.from("hello, kms ✓").toString("hex")}`,
        signature,
        address: HARDHAT_ACCOUNT_0.address,
      });

      assert.deepEqual(text.result, bytes.result);
      assert.deepEqual(text.result, {
        success: true,
        value: { address: HARDHAT_ACCOUNT_0.address },
      });
    });

    it("reads 0x as hex: the text 0x68 and the byte 0x68 are different messages", async () => {
      const { hre } = await runtime();
      const signature = await account0.signMessage({ message: "0x68" });

      const { result } = await verify(hre, {
        message: "0x68",
        signature,
        address: HARDHAT_ACCOUNT_0.address,
      });

      assert.ok(isResult(result) && !result.success, "expected a failed result");
    });

    it("prints both addresses on a mismatch and returns a failed result", async () => {
      const { hre, created } = await runtime();

      const { result, stdout, stderr } = await verify(hre, {
        message: GETH_MESSAGE,
        signature: GETH.signature,
        address: COW_ACCOUNT.address.toLowerCase(),
      });

      assert.equal(stdout, "");
      assert.equal(
        stderr,
        `Invalid: the signature over this message recovers to ${HARDHAT_ACCOUNT_0.address}, not to the expected signer ${COW_ACCOUNT.address}.\n`,
      );
      assert.deepEqual(result, {
        success: false,
        error: { recovered: HARDHAT_ACCOUNT_0.address, expected: COW_ACCOUNT.address },
      });
      assert.equal(created.length, 0);
    });

    it("matches an all-uppercase address", async () => {
      const { hre } = await runtime();

      const { result } = await verify(hre, {
        message: GETH_MESSAGE,
        signature: GETH.signature,
        address: `0x${HARDHAT_ACCOUNT_0.address.slice(2).toUpperCase()}`,
      });

      assert.deepEqual(result, { success: true, value: { address: HARDHAT_ACCOUNT_0.address } });
    });

    it("reads v as 0 or 1 and as an EIP-155 value, as cast does", async () => {
      const { hre } = await runtime();
      const bit = Number.parseInt(GETH.signature.slice(130), 16) - 27;

      // The bare bit, then EIP-155 values for chain ids 0, 1 and 100.
      for (const v of [bit, 35 + bit, 37 + bit, 235 + bit]) {
        const { result } = await verify(hre, {
          message: GETH_MESSAGE,
          signature: withV(GETH.signature, v),
          address: HARDHAT_ACCOUNT_0.address,
        });

        assert.deepEqual(
          result,
          { success: true, value: { address: HARDHAT_ACCOUNT_0.address } },
          `v = ${v}`,
        );
      }
    });

    it("accepts a high-S signature as cast does, with a note that gives the low-S form", async () => {
      const { hre } = await runtime();

      const { result, stdout, stderr } = await verify(hre, {
        message: GETH_MESSAGE,
        signature: highSTwin(GETH.signature),
        address: HARDHAT_ACCOUNT_0.address,
      });

      assert.equal(stdout, `Valid: ${HARDHAT_ACCOUNT_0.address} signed this message.\n`);
      assert.equal(
        stderr,
        `[hardhat-kms] this signature is high-S; OpenZeppelin ECDSA.recover rejects it; the low-S form is ${GETH.signature}\n`,
      );
      assert.deepEqual(result, { success: true, value: { address: HARDHAT_ACCOUNT_0.address } });
    });

    it("adds no high-S note to a mismatch", async () => {
      const { hre } = await runtime();

      const { stderr } = await verify(hre, {
        message: GETH_MESSAGE,
        signature: highSTwin(GETH.signature),
        address: COW_ACCOUNT.address,
      });

      assert.match(stderr, /^Invalid: /);
      assert.doesNotMatch(stderr, /high-S/);
    });

    it("refuses a mixed-case address with a wrong checksum", async () => {
      const { hre } = await runtime();
      const typo = HARDHAT_ACCOUNT_0.address.replace("Fd6", "fd6");

      await assertKmsError(
        verify(hre, { message: GETH_MESSAGE, signature: GETH.signature, address: typo }),
        `--address: ${typo} is not a valid Ethereum address`,
      );
    });
  });

  describe("with --key", () => {
    it("asks the KMS only for the key's address, then closes the adapter", async () => {
      const { hre, created } = await runtime();

      const { result, stdout } = await verify(hre, {
        message: GETH_MESSAGE,
        signature: GETH.signature,
        key: "deployer",
      });

      assert.equal(stdout, `Valid: ${HARDHAT_ACCOUNT_0.address} signed this message.\n`);
      assert.deepEqual(result, { success: true, value: { address: HARDHAT_ACCOUNT_0.address } });
      assert.equal(created.length, 1);
      assert.deepEqual(created[0]?.calls, { getPublicKey: 1, getAddress: 0, signDigest: 0 });
      assert.equal(created[0]?.closed, 1);
    });

    it("fails with both addresses when the key did not sign", async () => {
      const { hre, created } = await runtime();

      const { result, stderr } = await verify(hre, {
        message: GETH_MESSAGE,
        signature: GETH.signature,
        key: "cow",
      });

      assert.match(
        stderr,
        new RegExp(
          `recovers to ${HARDHAT_ACCOUNT_0.address}, not to the expected signer ${COW_ACCOUNT.address}\\.`,
        ),
      );
      assert.ok(isResult(result) && !result.success, "expected a failed result");
      assert.equal(created[0]?.closed, 1);
    });

    it("asks an address-only adapter for the address when the key has a pin", async () => {
      const { hre, created } = await runtime();

      const { result, stderr } = await verify(hre, {
        message: GETH_MESSAGE,
        signature: GETH.signature,
        key: "address-only",
      });

      assert.deepEqual(result, { success: true, value: { address: HARDHAT_ACCOUNT_0.address } });
      assert.equal(stderr, "");
      assert.deepEqual(created[0]?.calls, { getPublicKey: 0, getAddress: 1, signDigest: 0 });
    });

    it("checks against the pin, with a note, when the adapter cannot report the key", async () => {
      const { hre, created } = await runtime();

      const { result, stderr } = await verify(hre, {
        message: GETH_MESSAGE,
        signature: GETH.signature,
        key: "no-identity",
      });

      assert.deepEqual(result, { success: true, value: { address: HARDHAT_ACCOUNT_0.address } });
      assert.equal(
        stderr,
        "[hardhat-kms] no-identity: the provider cannot report this key's address, so the signature is checked against the configured `address` pin, which is not confirmed yet.\n",
      );
      assert.deepEqual(created[0]?.calls, { getPublicKey: 0, getAddress: 0, signDigest: 0 });
    });

    it("refuses an unknown key name", async () => {
      const { hre } = await runtime();

      await assertKmsError(
        verify(hre, { message: GETH_MESSAGE, signature: GETH.signature, key: "nobody" }),
        'unknown key "nobody". Known keys: deployer, cow, address-only, no-identity.',
      );
    });

    it("checks a malformed signature before opening the key", async () => {
      const { hre, created } = await runtime();

      await assertKmsError(
        verify(hre, { message: GETH_MESSAGE, signature: "0x1234", key: "deployer" }),
        "invalid signature: expected a 65-byte signature",
      );
      assert.equal(created.length, 0);
    });
  });

  describe("--address and --key together", () => {
    it("requires one of them", async () => {
      const { hre } = await runtime();

      await assertKmsError(
        verify(hre, { message: GETH_MESSAGE, signature: GETH.signature }),
        "pass the expected signer with --address <address> or --key <key>",
      );
    });

    it("refuses both", async () => {
      const { hre } = await runtime();

      await assertKmsError(
        verify(hre, {
          message: GETH_MESSAGE,
          signature: GETH.signature,
          address: HARDHAT_ACCOUNT_0.address,
          key: "deployer",
        }),
        "pass either --address or --key, not both",
      );
    });
  });

  describe("with --data", () => {
    it("verifies the EIP-712 specification example given inline", async () => {
      const { hre } = await runtime();

      const { result, stdout } = await verify(hre, {
        message: JSON.stringify(EIP712_MAIL),
        signature: EIP712_MAIL_SIGNATURE,
        address: COW_ACCOUNT.address,
        data: true,
      });

      assert.equal(stdout, `Valid: ${COW_ACCOUNT.address} signed this typed data.\n`);
      assert.deepEqual(result, { success: true, value: { address: COW_ACCOUNT.address } });
    });

    it("reads the typed data from a file with --from-file", async () => {
      const { hre } = await runtime();

      const { result } = await verify(hre, {
        message: file("mail.json", JSON.stringify(EIP712_MAIL)),
        signature: EIP712_MAIL_SIGNATURE,
        address: COW_ACCOUNT.address,
        data: true,
        fromFile: true,
      });

      assert.deepEqual(result, { success: true, value: { address: COW_ACCOUNT.address } });
    });

    it("refuses --from-file without --data", async () => {
      const { hre } = await runtime();

      await assertKmsError(
        verify(hre, {
          message: file("mail.json", JSON.stringify(EIP712_MAIL)),
          signature: EIP712_MAIL_SIGNATURE,
          address: COW_ACCOUNT.address,
          fromFile: true,
        }),
        "kms verify: --from-file requires --data",
      );
    });

    it("verifies a viem signature over typed data with a uint256 written as a string", async () => {
      const { hre } = await runtime();
      const permit = {
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "chainId", type: "uint256" },
          ],
          Permit: [
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        domain: { name: "Token", chainId: 11155111 },
        message: {
          spender: COW_ACCOUNT.address,
          value: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        },
      } as const;
      const signature = await account0.signTypedData({
        types: { Permit: permit.types.Permit },
        primaryType: "Permit",
        domain: { name: "Token", chainId: 11155111 },
        message: { spender: COW_SPENDER, value: 2n ** 256n - 1n },
      });

      const { result } = await verify(hre, {
        message: file("permit.json", JSON.stringify(permit)),
        signature,
        key: "deployer",
        data: true,
        fromFile: true,
      });

      assert.deepEqual(result, { success: true, value: { address: HARDHAT_ACCOUNT_0.address } });
    });

    it("fails on a mismatch, naming typed data", async () => {
      const { hre } = await runtime();

      const { result, stderr } = await verify(hre, {
        message: JSON.stringify(EIP712_MAIL),
        signature: EIP712_MAIL_SIGNATURE,
        address: HARDHAT_ACCOUNT_0.address,
        data: true,
      });

      assert.match(stderr, /^Invalid: the signature over this typed data recovers to /);
      assert.ok(isResult(result) && !result.success, "expected a failed result");
    });

    it("refuses a missing file, invalid JSON, a wrong shape, an inexact number and deep nesting", async () => {
      const { hre } = await runtime();
      const run = (message: string, fromFile = false) =>
        verify(hre, {
          message,
          signature: EIP712_MAIL_SIGNATURE,
          address: COW_ACCOUNT.address,
          data: true,
          fromFile,
        });

      await assertKmsError(
        run(path.join(dir, "missing.json"), true),
        `kms verify: cannot read the typed data file ${path.join(dir, "missing.json")} (Error)`,
      );
      await assertKmsError(run("{"), "kms verify: the typed data is not valid JSON");
      await assertKmsError(
        run(JSON.stringify({ ...EIP712_MAIL, primaryType: 1 })),
        "the typed data is invalid: the typed data needs a string `primaryType`",
      );
      await assertKmsError(
        run(JSON.stringify(EIP712_MAIL).replace('"chainId":1', '"chainId":9007199254740993')),
        'a number at key "chainId" is above 2^53 - 1, so JSON cannot hold it exactly; write it as a string',
      );
      await assertKmsError(
        run(`${"[".repeat(100_000)}${"]".repeat(100_000)}`),
        "kms verify: the typed data could not be read (RangeError); it may be nested too deeply",
      );
    });
  });

  describe("malformed input", () => {
    const cases: [string, string, string][] = [
      ["a short signature", "0x1234", "got 4 hex digits"],
      ["a signature without 0x", GETH.signature.slice(2), "must be 0x-prefixed hex"],
      ["non-hex digits", `${GETH.signature.slice(0, -1)}z`, "must be 0x-prefixed hex"],
      ["a 64-byte signature", GETH.signature.slice(0, 130), "got 128 hex digits"],
      ["r of zero", `0x${"0".repeat(64)}${GETH.signature.slice(66)}`, "outside the range"],
      [
        "a v between 28 and 35",
        withV(GETH.signature, 29),
        "v must be 0 or 1, 27 or 28, or 35 or more (EIP-155), got 29",
      ],
    ];
    for (const [name, signature, message] of cases) {
      it(`refuses ${name}`, async () => {
        const { hre } = await runtime();

        await assertKmsError(
          verify(hre, { message: GETH_MESSAGE, signature, address: HARDHAT_ACCOUNT_0.address }),
          "invalid signature: ",
          message,
        );
      });
    }

    it("refuses a 0x message that is not whole bytes of hex", async () => {
      const { hre } = await runtime();

      for (const message of ["0x123", "0xzz"]) {
        await assertKmsError(
          verify(hre, { message, signature: GETH.signature, address: HARDHAT_ACCOUNT_0.address }),
          "kms verify: the message is not 0x-prefixed hex with an even number of digits",
        );
      }
    });
  });
});
