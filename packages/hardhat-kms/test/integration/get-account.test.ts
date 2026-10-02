// connection.kms.getAccount on an edr-simulated network: a viem wallet client built with the
// account deploys and writes a contract, and a second, local account sends the EIP-7702
// authorization the KMS account signed (the sponsored case). EDR holds none of the KMS keys.
import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";

import hardhatViem from "@nomicfoundation/hardhat-viem";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import { createWalletClient, custom, getAddress, type Hex, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

import hardhatKms from "../../src/index.ts";
import { addressOfSecretKey, type FakeAdapter, fakeAdapter } from "../helpers/fake-adapter.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { COW_ACCOUNT } from "../helpers/vectors.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixture-projects/deploy");
const COW = getAddress(
  addressOfSecretKey(new Uint8Array(Buffer.from(COW_ACCOUNT.secretKey, "hex"))),
);
/** Hardhat's second default account, which sponsors the authorization. */
const SPONSOR = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const COUNTER_ABI = [
  {
    type: "constructor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "label_", type: "string" },
      { name: "start", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "count",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "add",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

async function runtime() {
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms, hardhatViem],
      solidity: "0.8.24",
      kms: { keys: { cow: vaultKey("cow") }, simulatedBalance: 10n ** 18n },
      networks: {
        local: { type: "edr-simulated", hardfork: "prague", kmsAccounts: ["cow"] },
      },
    },
    {},
    root,
  );
  const adapters: FakeAdapter[] = [];
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      if (key.name !== "cow") {
        return await next(context, key);
      }
      // High-S DER signatures, as AWS KMS often returns.
      const adapter = fakeAdapter({
        secretKey: new Uint8Array(Buffer.from(COW_ACCOUNT.secretKey, "hex")),
        highS: true,
      });
      adapters.push(adapter);
      return await Promise.resolve(adapter);
    },
  });
  return { hre, adapters };
}

const signatures = (adapters: FakeAdapter[]): number =>
  adapters.reduce((total, adapter) => total + adapter.calls.signDigest, 0);
const kmsCalls = (adapters: FakeAdapter[]): number =>
  adapters.reduce(
    (total, { calls }) => total + calls.signDigest + calls.getPublicKey + calls.getAddress,
    0,
  );

describe("connection.kms.getAccount", { timeout: 300_000 }, () => {
  let bytecode: Hex;

  before(async () => {
    const { hre } = await runtime();
    await hre.tasks.getTask("build").run({ quiet: true });
    const artifact = await hre.artifacts.readArtifact("Counter");
    assert.ok(isHex(artifact.bytecode));
    bytecode = artifact.bytecode;
  });

  it("gives a viem wallet client an account that deploys and writes", async () => {
    const { hre, adapters } = await runtime();
    const connection = await hre.network.create({ network: "local" });
    const account = await connection.kms.getAccount(COW);
    const wallet = createWalletClient({
      account,
      chain: hardhat,
      transport: custom(connection.provider),
    });
    const publicClient = await connection.viem.getPublicClient();

    const deployHash = await wallet.deployContract({
      abi: COUNTER_ABI,
      bytecode,
      args: ["account", 7n],
    });
    const deployed = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    assert.equal(deployed.status, "success");
    assert.equal(getAddress(deployed.from), COW);
    const address = deployed.contractAddress;
    assert.ok(address !== null && address !== undefined);

    const writeHash = await wallet.writeContract({
      address,
      abi: COUNTER_ABI,
      functionName: "add",
      args: [5n],
    });
    const written = await publicClient.waitForTransactionReceipt({ hash: writeHash });
    assert.equal(written.status, "success");
    const read = { address, abi: COUNTER_ABI } as const;
    assert.equal(await publicClient.readContract({ ...read, functionName: "owner" }), COW);
    assert.equal(await publicClient.readContract({ ...read, functionName: "count" }), 12n);
    assert.equal(signatures(adapters), 2);
    await connection.close();
  });

  it("signs an authorization that a second, local account sends in a type 4 transaction", async () => {
    const { hre, adapters } = await runtime();
    const connection = await hre.network.create({ network: "local" });
    const account = await connection.kms.getAccount(COW);
    const transport = custom(connection.provider);
    const publicClient = await connection.viem.getPublicClient();
    const sponsor = createWalletClient({ account: SPONSOR, chain: hardhat, transport });
    const deployHash = await sponsor.deployContract({
      abi: COUNTER_ABI,
      bytecode,
      args: ["delegate", 0n],
    });
    const { contractAddress } = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    assert.ok(contractAddress !== null && contractAddress !== undefined);

    const kmsWallet = createWalletClient({ account, chain: hardhat, transport });
    const authorization = await kmsWallet.signAuthorization({ contractAddress });
    // The delegated code runs in COW's account: the sponsor, the contract's owner, adds 3 to
    // the count in COW's storage.
    const hash = await sponsor.writeContract({
      authorizationList: [authorization],
      address: COW,
      abi: COUNTER_ABI,
      functionName: "add",
      args: [3n],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    assert.equal(getAddress(receipt.from), SPONSOR.address);
    assert.equal(
      await publicClient.getCode({ address: COW }),
      `0xef0100${contractAddress.slice(2).toLowerCase()}`,
    );
    assert.equal(
      await publicClient.readContract({ address: COW, abi: COUNTER_ABI, functionName: "count" }),
      3n,
    );
    assert.equal(signatures(adapters), 1);
    await connection.close();
  });

  it("is on every connection, and refuses an address that is not a KMS account", async () => {
    const { hre, adapters } = await runtime();
    const connection = await hre.network.create({ network: "local" });
    await assert.rejects(
      async () => await connection.kms.getAccount(SPONSOR.address),
      (error: unknown) =>
        error instanceof HardhatPluginError &&
        error.message.includes(`${SPONSOR.address} is not a KMS account of network local.`) &&
        error.message.includes(COW),
    );
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const raw = await connection.kms.getAccount(COW, { rawSign: true });
      assert.equal(typeof raw.sign, "function");
      assert.equal(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0]?.arguments[0]), /rawSign/);
    } finally {
      warn.mock.restore();
    }
    assert.equal(signatures(adapters), 0);
    await connection.close();
  });

  it("refuses to sign once its connection is closed, while another connection's account signs", async () => {
    const { hre, adapters } = await runtime();
    const connection = await hre.network.create({ network: "local" });
    const other = await hre.network.create({ network: "local" });
    const account = await connection.kms.getAccount(COW);
    const otherAccount = await other.kms.getAccount(COW);
    await connection.close();
    const callsBefore = kmsCalls(adapters);
    const closed =
      "the connection to network local is closed, so its KMS accounts no longer sign. Get the account from an open connection";
    for (const [operation, run] of [
      ["signMessage", async () => await account.signMessage({ message: "after close" })],
      [
        "signTransaction",
        async () =>
          await account.signTransaction({
            type: "eip1559",
            chainId: hardhat.id,
            maxFeePerGas: 1n,
            to: SPONSOR.address,
          }),
      ],
      ["getAccount", async () => await connection.kms.getAccount(COW)],
    ] as const) {
      await assert.rejects(
        run,
        (error: unknown) =>
          error instanceof HardhatPluginError && error.message === `${operation}: ${closed}`,
      );
    }
    assert.equal(
      kmsCalls(adapters),
      callsBefore,
      "a closed connection's account must not call the KMS",
    );
    assert.ok(isHex(await otherAccount.signMessage({ message: "still open" })));
    await other.close();
  });
});
