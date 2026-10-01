import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { type Address, getAddress, hashMessage, hashTypedData, parseSignature } from "viem";

import hardhatKms from "../../src/index.ts";
import { fakeAdapter } from "../helpers/fake-adapter.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { COW_ACCOUNT } from "../helpers/vectors.ts";

const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixture-projects/ecrecover",
);
const KMS_ACCOUNT: Address = getAddress(COW_ACCOUNT.address);

/** The ABI of `contracts/Recover.sol`. */
const RECOVER_ABI = [
  {
    type: "function",
    name: "recover",
    stateMutability: "pure",
    inputs: [
      { name: "digest", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
const secretKey = new Uint8Array(Buffer.from(COW_ACCOUNT.secretKey, "hex"));

/**
 * A runtime with viem, ethers and one KMS account on an edr-simulated network. The account's fake
 * KMS returns only high-S signatures, as AWS KMS often does, so each one must be normalized; and
 * it counts its signatures, so a retry cannot hide a signature the plugin rejected.
 */
async function runtime() {
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms, hardhatViem, hardhatEthers],
      solidity: "0.8.24",
      kms: { keys: { cow: vaultKey("cow", KMS_ACCOUNT) } },
      networks: { local: { type: "edr-simulated", kmsAccounts: ["cow"] } },
    },
    {},
    root,
  );
  const adapter = fakeAdapter({ secretKey, highS: true });
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async () => await Promise.resolve(adapter),
  });
  return { hre, kmsSignatures: () => adapter.calls.signDigest };
}

const typedData = (chainId: number, verifyingContract: Address) =>
  ({
    domain: { name: "Ether Mail", version: "1", chainId, verifyingContract },
    types: {
      Person: [
        { name: "name", type: "string" },
        { name: "wallet", type: "address" },
      ],
      Mail: [
        { name: "from", type: "Person" },
        { name: "to", type: "Person" },
        { name: "contents", type: "string" },
      ],
    },
    primaryType: "Mail",
    message: {
      from: { name: "Cow", wallet: KMS_ACCOUNT },
      to: { name: "Bob", wallet: getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") },
      contents: "Hello, Bob!",
    },
  }) as const;

describe("signatures verified on chain with ecrecover", { timeout: 300_000 }, () => {
  before(async () => {
    const { hre } = await runtime();
    await hre.tasks.getTask("build").run({ quiet: true });
  });

  it("recovers the KMS account from viem's personal_sign and typed-data signatures", async () => {
    const { hre, kmsSignatures } = await runtime();
    const { viem } = await hre.network.create("local");
    const { address } = await viem.deployContract("Recover");
    const publicClient = await viem.getPublicClient();
    const wallet = await viem.getWalletClient(KMS_ACCOUNT);
    const data = typedData(31337, address);
    const recover = async (digest: `0x${string}`, signature: `0x${string}`): Promise<Address> => {
      const { v, r, s } = parseSignature(signature);
      return await publicClient.readContract({
        address,
        abi: RECOVER_ABI,
        functionName: "recover",
        args: [digest, Number(v), r, s],
      });
    };

    for (let index = 0; index < 4; index++) {
      const message = `hello ${index}`;
      assert.equal(
        await recover(hashMessage(message), await wallet.signMessage({ message })),
        KMS_ACCOUNT,
      );
      assert.equal(
        await recover(hashTypedData(data), await wallet.signTypedData(data)),
        KMS_ACCOUNT,
      );
    }
    // One KMS signature per request, each high-S: none was rejected and asked for again.
    assert.equal(kmsSignatures(), 8);
  });

  it("recovers the KMS account from ethers' signMessage and signTypedData", async () => {
    const { hre, kmsSignatures } = await runtime();
    const { ethers } = await hre.network.create("local");
    const recover = await ethers.deployContract("Recover");
    const signer = await ethers.getSigner(KMS_ACCOUNT);
    const data = typedData(31337, getAddress(await recover.getAddress()));

    const messageSignature = ethers.Signature.from(await signer.signMessage("hello ethers"));
    assert.equal(
      await recover.getFunction("recover")(
        ethers.hashMessage("hello ethers"),
        messageSignature.v,
        messageSignature.r,
        messageSignature.s,
      ),
      KMS_ACCOUNT,
    );
    const { Person, Mail } = data.types;
    const typedSignature = ethers.Signature.from(
      await signer.signTypedData(
        data.domain,
        { Person: [...Person], Mail: [...Mail] },
        data.message,
      ),
    );
    assert.equal(
      await recover.getFunction("recover")(
        ethers.TypedDataEncoder.hash(
          data.domain,
          { Person: [...Person], Mail: [...Mail] },
          data.message,
        ),
        typedSignature.v,
        typedSignature.r,
        typedSignature.s,
      ),
      KMS_ACCOUNT,
    );
    assert.equal(kmsSignatures(), 2, "one high-S KMS signature per request");
  });

  it("refuses typed data for another chain", async () => {
    const { hre } = await runtime();
    const { viem } = await hre.network.create("local");
    const wallet = await viem.getWalletClient(KMS_ACCOUNT);

    await assert.rejects(
      wallet.signTypedData(typedData(1, getAddress("0xcccccccccccccccccccccccccccccccccccccccc"))),
      /the typed data is for chain 1, but this network is chain 31337/,
    );
  });
});
