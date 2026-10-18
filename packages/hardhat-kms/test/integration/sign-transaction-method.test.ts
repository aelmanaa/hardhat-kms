// An adapter with `signTransaction` (#514) on an edr-simulated network: hardhat-viem,
// hardhat-ethers, a library account and `kms sign-tx` send and deploy through it, messages and
// authorizations still go to signMessage and signDigest, and a hostile adapter sends nothing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import type { EthereumProvider } from "hardhat/types/providers";
import { authorization, Transaction } from "micro-eth-signer";
import { createWalletClient, custom, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

import hardhatKms from "../../src/index.ts";
import { addressOfSecretKey } from "../helpers/fake-adapter.ts";
import { type FakeTxAdapter, fakeTxAdapter, type TxBehaviour } from "../helpers/fake-tx-adapter.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const secretKey = hex(COW_ACCOUNT.secretKey);
const COW = getAddress(addressOfSecretKey(secretKey));
const TO = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
// Creation code that deploys a contract returning 42.
const INIT_CODE = "0x600a600c600039600a6000f3602a60005260206000f3";
const DELEGATE = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
/** Another key's authorization, which the KMS account sends in a type 4 transaction. */
const OTHER = privateKeyToAccount(`0x${HARDHAT_ACCOUNT_0.secretKey}`);

let scratch: string;

before(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "hardhat-kms-sign-transaction-"));
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A runtime whose `cow` key is served by a fake adapter with `signTransaction`. */
async function runtime(behaviour: TxBehaviour = "honest") {
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms, hardhatViem, hardhatEthers],
      kms: { keys: { cow: vaultKey("cow") }, simulatedBalance: 10n ** 18n },
      networks: {
        local: { type: "edr-simulated", hardfork: "prague", kmsAccounts: ["cow"] },
      },
    },
    { network: "local" },
  );
  const adapters: FakeTxAdapter[] = [];
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      if (key.name !== "cow") {
        return await next(context, key);
      }
      const adapter = fakeTxAdapter({ secretKey, behaviour });
      adapters.push(adapter);
      return await Promise.resolve(adapter);
    },
  });
  return { hre, adapters };
}

/** The adapters' calls, summed. */
function calls(adapters: readonly FakeTxAdapter[]) {
  const total = { signDigest: 0, signMessage: 0, signTransaction: 0 };
  for (const adapter of adapters) {
    total.signDigest += adapter.calls.signDigest;
    total.signMessage += adapter.calls.signMessage;
    total.signTransaction += adapter.calls.signTransaction;
  }
  return total;
}

async function receiptOf(provider: EthereumProvider, hash: unknown) {
  const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
  assert.ok(typeof receipt === "object" && receipt !== null);
  return {
    status: Reflect.get(receipt, "status"),
    type: Reflect.get(receipt, "type"),
    from: getAddress(String(Reflect.get(receipt, "from"))),
  };
}

/** The block number and cow's nonce, which must not move when a send is refused. */
async function chainState(provider: EthereumProvider): Promise<unknown[]> {
  const block: unknown = await provider.request({ method: "eth_blockNumber" });
  const nonce: unknown = await provider.request({
    method: "eth_getTransactionCount",
    params: [COW, "pending"],
  });
  return [block, nonce];
}

/** An authorization by another key, as an `eth_sendTransaction` request carries it. */
function rpcAuthorization() {
  const signed = authorization.sign(
    { chainId: 31337n, address: DELEGATE, nonce: 0n },
    `0x${HARDHAT_ACCOUNT_0.secretKey}`,
  );
  return {
    chainId: "0x7a69",
    address: DELEGATE,
    nonce: "0x0",
    yParity: `0x${signed.yParity.toString(16)}`,
    r: `0x${signed.r.toString(16).padStart(64, "0")}`,
    s: `0x${signed.s.toString(16).padStart(64, "0")}`,
  };
}

/** Runs `kms sign-tx` and returns what it printed on standard output. */
async function signTx(
  hre: Awaited<ReturnType<typeof runtime>>["hre"],
  request: unknown,
): Promise<string> {
  const file = path.join(scratch, `tx-${Date.now()}-${Math.random()}.json`);
  writeFileSync(file, JSON.stringify(request));
  let printed = "";
  const write = mock.method(process.stdout, "write", (chunk: unknown) => {
    printed += String(chunk);
    return true;
  });
  const writeError = mock.method(process.stderr, "write", () => true);
  try {
    await hre.tasks.getTask(["kms", "sign-tx"]).run({ key: "cow", tx: file });
    return printed;
  } finally {
    write.mock.restore();
    writeError.mock.restore();
  }
}

const invalidSignature = /the provider returned an invalid signature/;

describe("an adapter with signTransaction", { timeout: 300_000 }, () => {
  it("signs every type sent with eth_sendTransaction through it", async () => {
    const { hre, adapters } = await runtime();
    const { provider } = await hre.network.create("local");
    const requests: Array<[string, Record<string, unknown>]> = [
      ["0x0", { from: COW, to: TO, value: "0x1", gasPrice: "0x3b9aca00" }],
      ["0x1", { from: COW, to: TO, value: "0x1", gasPrice: "0x3b9aca00", accessList: [] }],
      ["0x2", { from: COW, to: TO, value: "0x1" }],
      ["0x4", { from: COW, to: COW, authorizationList: [rpcAuthorization()] }],
    ];
    for (const [type, request] of requests) {
      const hash = await provider.request({ method: "eth_sendTransaction", params: [request] });
      const receipt = await receiptOf(provider, hash);
      assert.deepEqual(receipt, { status: "0x1", type, from: COW });
    }
    assert.deepEqual(calls(adapters), { signDigest: 0, signMessage: 0, signTransaction: 4 });
    assert.deepEqual(
      adapters.flatMap((adapter) => adapter.transactions.map(({ type }) => type)),
      [0, 1, 2, 4],
    );
  });

  it("sends and deploys with hardhat-viem's wallet client", async () => {
    const { hre, adapters } = await runtime();
    const { viem } = await hre.network.create("local");
    const wallet = await viem.getWalletClient(COW);
    const publicClient = await viem.getPublicClient();

    const sent = await wallet.sendTransaction({ to: TO, value: 1n });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash: sent })).status, "success");
    const deployed = await wallet.deployContract({ abi: [], bytecode: INIT_CODE });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deployed });
    assert.equal(receipt.status, "success");
    assert.ok(receipt.contractAddress !== null && receipt.contractAddress !== undefined);
    assert.deepEqual(calls(adapters), { signDigest: 0, signMessage: 0, signTransaction: 2 });
  });

  it("sends and deploys with hardhat-ethers", async () => {
    const { hre, adapters } = await runtime();
    const { ethers } = await hre.network.create("local");
    const signer = await ethers.getSigner(COW);

    const sent = await signer.sendTransaction({ to: TO, value: 1n });
    assert.equal((await sent.wait())?.status, 1);
    const contract = await new ethers.ContractFactory([], INIT_CODE, signer).deploy();
    await contract.waitForDeployment();
    assert.equal(BigInt(await ethers.provider.call({ to: await contract.getAddress() })), 42n);
    assert.deepEqual(calls(adapters), { signDigest: 0, signMessage: 0, signTransaction: 2 });
  });

  it("sends through a library account, and signs its authorizations with signDigest", async () => {
    const { hre, adapters } = await runtime();
    const connection = await hre.network.create("local");
    const account = await connection.kms.getAccount(COW);
    const wallet = createWalletClient({
      account,
      chain: hardhat,
      transport: custom(connection.provider),
    });
    const publicClient = await connection.viem.getPublicClient();

    for (const type of ["legacy", "eip2930", "eip1559"] as const) {
      const hash = await wallet.sendTransaction({ to: TO, value: 1n, type });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      assert.equal(receipt.type, type);
    }
    const signed = await OTHER.signAuthorization({
      contractAddress: DELEGATE,
      chainId: hardhat.id,
      nonce: 0,
    });
    const hash = await wallet.sendTransaction({ to: COW, authorizationList: [signed] });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash })).type, "eip7702");
    assert.deepEqual(calls(adapters), { signDigest: 0, signMessage: 0, signTransaction: 4 });

    await account.signAuthorization({ contractAddress: DELEGATE, chainId: hardhat.id, nonce: 9 });
    assert.deepEqual(calls(adapters), { signDigest: 1, signMessage: 0, signTransaction: 4 });
  });

  it("signs with kms sign-tx, and the node accepts the result", async () => {
    const { hre, adapters } = await runtime();

    const printed = await signTx(hre, { to: TO, value: "0x1" });

    const raw = printed.trim();
    assert.equal(Transaction.fromHex(raw, false).sender, COW);
    assert.deepEqual(calls(adapters), { signDigest: 0, signMessage: 0, signTransaction: 1 });
    // Each connection to a simulated network is a new chain, funded by kms.simulatedBalance.
    const { provider } = await hre.network.create("local");
    const hash = await provider.request({ method: "eth_sendRawTransaction", params: [raw] });
    assert.equal((await receiptOf(provider, hash)).status, "0x1");
  });

  it("signs personal_sign with signMessage", async () => {
    const { hre, adapters } = await runtime();
    const { provider } = await hre.network.create("local");

    const signature = await provider.request({
      method: "personal_sign",
      params: ["0x68656c6c6f", COW],
    });

    assert.equal(
      signature,
      await privateKeyToAccount(`0x${COW_ACCOUNT.secretKey}`).signMessage({ message: "hello" }),
    );
    assert.deepEqual(calls(adapters), { signDigest: 0, signMessage: 1, signTransaction: 0 });
  });

  describe("that returns a signature over another transaction", () => {
    it("sends nothing through eth_sendTransaction", async () => {
      const { hre, adapters } = await runtime("otherBody");
      const { provider } = await hre.network.create("local");
      const initial = await chainState(provider);

      await assert.rejects(
        provider.request({
          method: "eth_sendTransaction",
          params: [{ from: COW, to: TO, value: "0x1" }],
        }),
        (error: unknown) => {
          assert.ok(error instanceof HardhatPluginError, String(error));
          assert.match(error.message, invalidSignature);
          return true;
        },
      );
      assert.deepEqual(await chainState(provider), initial);
      assert.deepEqual(calls(adapters), { signDigest: 0, signMessage: 0, signTransaction: 2 });
    });

    it("sends nothing through hardhat-ethers or a library account", async () => {
      const { hre } = await runtime("otherBody");
      const connection = await hre.network.create("local");
      const initial = await chainState(connection.provider);
      const signer = await connection.ethers.getSigner(COW);
      await assert.rejects(signer.sendTransaction({ to: TO, value: 1n }), invalidSignature);
      const account = await connection.kms.getAccount(COW);
      const wallet = createWalletClient({
        account,
        chain: hardhat,
        transport: custom(connection.provider),
      });
      await assert.rejects(wallet.sendTransaction({ to: TO, value: 1n }), invalidSignature);
      assert.deepEqual(await chainState(connection.provider), initial);
    });

    it("prints nothing with kms sign-tx", async () => {
      const { hre } = await runtime("otherBody");
      let printed = "";
      await assert.rejects(
        (async () => {
          printed = await signTx(hre, { to: TO, value: "0x1" });
        })(),
        invalidSignature,
      );
      assert.equal(printed, "");
    });
  });

  describe("that returns another key's signature", () => {
    it("sends nothing", async () => {
      const { hre } = await runtime("otherKey");
      const { provider } = await hre.network.create("local");
      const initial = await chainState(provider);
      await assert.rejects(
        provider.request({
          method: "eth_sendTransaction",
          params: [{ from: COW, to: TO, value: "0x1" }],
        }),
        invalidSignature,
      );
      assert.deepEqual(await chainState(provider), initial);
    });
  });
});
