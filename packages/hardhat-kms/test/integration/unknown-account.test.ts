import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { HardhatError } from "@nomicfoundation/hardhat-errors";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import hardhatKms from "../../src/index.ts";
import { toChecksumAddress } from "../../src/internal/crypto/address.ts";
import type { KmsKeyUserConfig } from "../../src/types.ts";
import { fakeAdapter } from "../helpers/fake-adapter.ts";
import { type RecordingNode, startRecordingNode } from "../helpers/recording-node.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0, PERSONAL_SIGN_VECTORS } from "../helpers/vectors.ts";

/** An address that is neither a KMS account nor a local account. */
const UNKNOWN = "0x1111111111111111111111111111111111111111";
/** A key name that must never show in an error. */
const KEY_NAME = "cow-secret-key-name";
const MESSAGE = `0x${PERSONAL_SIGN_VECTORS[0].message}`;
const LISTED = `The KMS account on this network is ${COW_ACCOUNT.address}.`;

type Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

/** Runs a request that must fail, and returns what it threw. */
async function failure(provider: Provider, method: string, params: unknown[]): Promise<Error> {
  const outcome = await provider.request({ method, params }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(outcome instanceof Error, `${method} should fail: ${String(outcome)}`);
  return outcome;
}

/** A transaction from `from` with the fields Hardhat's local accounts need to sign it. */
function transfer(from: string, value = "0x1"): Record<string, unknown> {
  return { from, to: COW_ACCOUNT.address, value, gas: "0x5208", gasPrice: "0x3b9aca00" };
}

/** Asserts the error lists the KMS account, keeps its original message first and names no key. */
function assertLists(error: Error, original: string): void {
  assert.equal(error.message, `${original}${/[.!?]$/.test(original) ? "" : "."} ${LISTED}`);
  assert.ok(!error.message.includes(KEY_NAME), "no key name");
  assert.ok(!error.message.includes("myvault"), "no provider");
  assert.ok(String(error.stack).includes(LISTED), "the stack shows the new message");
}

describe("an account that is neither a KMS account nor a local account", () => {
  let node: RecordingNode;
  let hre: HardhatRuntimeEnvironment;

  before(async () => {
    node = await startRecordingNode();
    const keys: Record<string, KmsKeyUserConfig> = {
      [KEY_NAME]: vaultKey("cow", COW_ACCOUNT.address),
    };
    hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms, hardhatViem, hardhatEthers],
      kms: { keys },
      networks: {
        simulated: { type: "edr-simulated", kmsAccounts: [KEY_NAME] },
        plainSimulated: { type: "edr-simulated" },
        local: {
          type: "http",
          url: node.url,
          accounts: [`0x${HARDHAT_ACCOUNT_0.secretKey}`],
          kmsAccounts: [KEY_NAME],
        },
        remote: { type: "http", url: node.url, kmsAccounts: [KEY_NAME] },
        plainRemote: { type: "http", url: node.url },
      },
    });
  });

  after(async () => {
    await node.server.close();
  });

  it("lists the KMS account in the simulated network's error, with its class, code and data", async () => {
    const { provider } = await hre.network.create("simulated");
    const { provider: plain } = await hre.network.create("plainSimulated");
    for (const [method, params] of [
      ["eth_sendTransaction", [transfer(UNKNOWN)]],
      ["personal_sign", [MESSAGE, UNKNOWN]],
      ["eth_sign", [UNKNOWN, MESSAGE]],
    ] as const) {
      const error = await failure(provider, method, [...params]);
      const original = await failure(plain, method, [...params]);
      assert.equal(original.message, `Unknown account ${UNKNOWN}`);
      assertLists(error, original.message);
      assert.equal(Object.getPrototypeOf(error), Object.getPrototypeOf(original), "same class");
      assert.equal(Reflect.get(error, "code"), -32000);
      assert.deepEqual(Reflect.get(error, "data"), Reflect.get(original, "data"));
    }
  });

  it("lists the KMS account in Hardhat's HHE716 for a network with local accounts", async () => {
    const { provider } = await hre.network.create("local");
    for (const [method, params] of [
      ["eth_sendTransaction", [transfer(UNKNOWN)]],
      ["personal_sign", [MESSAGE, UNKNOWN]],
    ] as const) {
      const error = await failure(provider, method, [...params]);
      assert.ok(
        HardhatError.isHardhatError(error, HardhatError.ERRORS.CORE.NETWORK.NOT_LOCAL_ACCOUNT),
        String(error),
      );
      assertLists(
        error,
        `HHE716: Account "${UNKNOWN}" is not managed by the node you are connected to.`,
      );
    }
  });

  it("lists the KMS account in a remote node's error answer, with its code", async () => {
    const { provider } = await hre.network.create("remote");
    const { provider: plain } = await hre.network.create("plainRemote");
    const original = await failure(plain, "eth_sendTransaction", [transfer(UNKNOWN)]);
    const error = await failure(provider, "eth_sendTransaction", [transfer(UNKNOWN)]);
    assertLists(error, original.message);
    assert.equal(Object.getPrototypeOf(error), Object.getPrototypeOf(original), "same class");
    assert.equal(Reflect.get(error, "code"), -32000);

    // Geth and Reth answer "unknown account".
    node.faults.set("eth_sign", "unknown account");
    try {
      assertLists(await failure(provider, "eth_sign", [UNKNOWN, MESSAGE]), "unknown account");
    } finally {
      node.faults.delete("eth_sign");
    }
  });

  it("shows the list through viem and ethers", async () => {
    const { viem, ethers } = await hre.network.create("simulated");
    const wallet = await viem.getWalletClient(UNKNOWN);
    await assert.rejects(
      wallet.sendTransaction({ to: UNKNOWN, value: 1n }),
      (error: unknown) => error instanceof Error && error.message.includes(LISTED),
    );
    const signer = await ethers.getSigner(UNKNOWN);
    await assert.rejects(
      signer.signMessage("hello"),
      (error: unknown) => error instanceof Error && error.message.includes(LISTED),
    );
  });

  it("leaves the errors of known accounts and other errors unchanged", async () => {
    const { provider } = await hre.network.create("simulated");
    const { provider: plain } = await hre.network.create("plainSimulated");
    // A local account without the funds: the node's own error, as without KMS accounts.
    const tooMuch = transfer(HARDHAT_ACCOUNT_0.address, "0xffffffffffffffffffffffffffffffffff");
    const error = await failure(provider, "eth_sendTransaction", [tooMuch]);
    const original = await failure(plain, "eth_sendTransaction", [tooMuch]);
    assert.equal(error.message, original.message);
    assert.equal(Reflect.get(error, "code"), Reflect.get(original, "code"));
    assert.ok(!error.message.includes(COW_ACCOUNT.address));

    // The simulated network has no eth_signTransaction; that error is not about the account.
    const unsupported = await failure(provider, "eth_signTransaction", [
      { ...transfer(UNKNOWN), nonce: "0x0" },
    ]);
    assert.equal(unsupported.message, "Method eth_signTransaction is not supported");

    // A node's answer that is not about the account passes through.
    const { provider: remote } = await hre.network.create("remote");
    node.faults.set("eth_sign", "unknown accounts are not allowed here");
    try {
      const answer = await failure(remote, "eth_sign", [UNKNOWN, MESSAGE]);
      assert.equal(answer.message, "unknown accounts are not allowed here");
    } finally {
      node.faults.delete("eth_sign");
    }

    // Only the five signing methods get the list.
    node.faults.set("eth_getBalance", "unknown account");
    try {
      const answer = await failure(remote, "eth_getBalance", [UNKNOWN, "latest"]);
      assert.equal(answer.message, "unknown account");
    } finally {
      node.faults.delete("eth_getBalance");
    }
  });

  it("leaves the error unchanged when the KMS addresses cannot be read", async () => {
    const broken = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: { keys: { broken: vaultKey("broken") } },
      networks: { remote: { type: "http", url: node.url, kmsAccounts: ["broken"] } },
    });
    broken.hooks.registerHandlers("kms", {
      createKeyAdapter: async () =>
        await Promise.resolve(
          fakeAdapter({
            secretKey: new Uint8Array(32).fill(1),
            throwError: new Error("KMS is down"),
          }),
        ),
    });
    const { provider } = await broken.network.create("remote");
    node.faults.set("eth_sign", "unknown account");
    try {
      // Not an address, so the plugin looks no key up before it passes the request on.
      const error = await failure(provider, "eth_sign", ["0x1234", MESSAGE]);
      assert.equal(error.message, "unknown account");
    } finally {
      node.faults.delete("eth_sign");
    }
  });

  it("lists at most ten KMS addresses, then how many more", async () => {
    const addresses = Array.from({ length: 12 }, (_, index) =>
      toChecksumAddress(`0x${(index + 1).toString(16).padStart(40, "a")}`),
    );
    const many = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms],
      kms: {
        keys: Object.fromEntries(
          addresses.map((address, index) => [`key${index}`, vaultKey(`key${index}`, address)]),
        ),
      },
      networks: {
        simulated: {
          type: "edr-simulated",
          kmsAccounts: addresses.map((_, index) => `key${index}`),
        },
      },
    });
    const { provider } = await many.network.create("simulated");
    const error = await failure(provider, "personal_sign", [MESSAGE, UNKNOWN]);
    assert.equal(
      error.message,
      `Unknown account ${UNKNOWN}. The KMS accounts on this network are ${addresses.slice(0, 10).join(", ")} and 2 more.`,
    );
  });
});
