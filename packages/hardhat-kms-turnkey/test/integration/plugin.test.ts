// @hardhat-kms/turnkey in a real Hardhat runtime, against a local Turnkey stub over HTTP: the
// adapter's own fetch, stamps and parsing, then the core's checks, through the RPC accounts, the
// kms tasks, and viem and ethers deploys on edr-simulated. The stub checks every X-Stamp and signs
// with a secp256k1 test key; it can answer with a high s, a wrong v or another key's signature.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, afterEach, before, describe, it, mock } from "node:test";

import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import { ContractFactory } from "ethers";
import hardhatKms from "hardhat-kms";
import type { KmsKeyConfig } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { type Address, getAddress, type Hex, verifyTypedData } from "viem";

import { EIP712_MAIL, PERSONAL_SIGN_VECTORS } from "../../../hardhat-kms/test/helpers/vectors.ts";
import hardhatKmsTurnkey from "../../src/index.ts";
import { createTurnkeyKeyAdapter } from "../../src/internal/adapter.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import {
  ACCOUNT,
  ACCOUNT_SECRET_KEY,
  API_PRIVATE_KEY,
  API_PUBLIC_KEY,
  ORGANIZATION,
} from "../helpers/keys.ts";
import { POLL_PATH, SIGN_PATH, TurnkeyStub } from "../helpers/turnkey-stub.ts";

const ownVersion = String(
  Reflect.get(
    Object(createRequire(import.meta.url)("@hardhat-kms/turnkey/package.json")),
    "version",
  ),
);
const ADDRESS: Address = getAddress(ACCOUNT.address);
/** Init code that deploys a contract whose code returns 42. */
const BYTECODE: Hex = "0x600a600c600039600a6000f3602a60005260206000f3";
const RUNTIME_CODE: Hex = "0x602a60005260206000f3";

const VARIABLES = {
  HHKMS_TEST_TURNKEY_ORGANIZATION: ORGANIZATION,
  HHKMS_TEST_TURNKEY_API_PRIVATE_KEY: API_PRIVATE_KEY,
};

let stub: TurnkeyStub;
let baseUrl: string;

before(async () => {
  Object.assign(process.env, VARIABLES);
  stub = new TurnkeyStub({
    organizationId: ORGANIZATION,
    apiPublicKey: API_PUBLIC_KEY,
    secretKey: ACCOUNT_SECRET_KEY,
  });
  baseUrl = await stub.listen();
});

after(async () => {
  await stub.close();
  for (const name of Object.keys(VARIABLES)) {
    Reflect.deleteProperty(process.env, name);
  }
});

afterEach(() => {
  stub.mode = "good";
  stub.firstStatus = "ACTIVITY_STATUS_COMPLETED";
  stub.requests.length = 0;
});

/** A runtime whose Turnkey adapters talk to the stub, through the package's own handler. */
async function runtime() {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKmsTurnkey, hardhatViem, hardhatEthers],
    kms: {
      keys: {
        deployer: {
          provider: "turnkey",
          organizationId: configVariable("HHKMS_TEST_TURNKEY_ORGANIZATION"),
          address: ACCOUNT.address.toLowerCase(),
          apiPrivateKey: configVariable("HHKMS_TEST_TURNKEY_API_PRIVATE_KEY"),
          apiPublicKey: API_PUBLIC_KEY,
        },
      },
      simulatedBalance: 10n ** 20n,
    },
    networks: {
      // `accounts: []`: EDR holds no key, so only the plugin can sign for the Turnkey account.
      local: { type: "edr-simulated", accounts: [], kmsAccounts: ["deployer"] },
    },
  });
  hre.hooks.registerHandlers(
    "kms",
    kmsHandlers(
      ownVersion,
      async () => async (key) => await createTurnkeyKeyAdapter(key, { transport: { baseUrl } }),
    ),
  );
  return hre;
}

/** The parameters of each sign request the stub got. */
function signParameters(): unknown[] {
  return stub.bodies(SIGN_PATH).map((body): unknown => Reflect.get(Object(body), "parameters"));
}

/** Runs a `kms` task with standard output captured, and returns its result and output. */
async function task(
  hre: Awaited<ReturnType<typeof runtime>>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown; printed: string }> {
  let printed = "";
  const write = mock.method(process.stdout, "write", (chunk: unknown) => {
    printed += String(chunk);
    return true;
  });
  const writeError = mock.method(process.stderr, "write", () => true);
  try {
    return { result: await hre.tasks.getTask(["kms", name]).run(args), printed };
  } finally {
    write.mock.restore();
    writeError.mock.restore();
  }
}

describe("@hardhat-kms/turnkey in a Hardhat runtime", () => {
  it("loads hardhat-kms through its plugin dependency, and once when both are listed", async () => {
    const hre = await runtime();
    const key: KmsKeyConfig | undefined = hre.config.kms.keys.deployer;
    assert.equal(key?.provider, "turnkey");
    const both = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKms, hardhatKmsTurnkey],
    });
    assert.ok(both.tasks.getTask(["kms", "accounts"]));
  });

  it("lists the account and signs Hardhat's personal_sign vectors, each with one stamped request", async () => {
    const hre = await runtime();
    const { provider } = await hre.network.create("local");

    assert.deepEqual(await provider.request({ method: "eth_accounts" }), [ADDRESS]);
    assert.equal(stub.requests.length, 0);
    for (const vector of PERSONAL_SIGN_VECTORS) {
      const signature = await provider.request({
        method: "personal_sign",
        params: [`0x${vector.message}`, ADDRESS],
      });
      assert.equal(signature, vector.signature, vector.source);
    }
    assert.equal(stub.requests.length, PERSONAL_SIGN_VECTORS.length);
    assert.ok(stub.requests.every((request) => request.stamped));
    for (const parameters of signParameters()) {
      assert.equal(Reflect.get(Object(parameters), "hashFunction"), "HASH_FUNCTION_KECCAK256");
      assert.equal(Reflect.get(Object(parameters), "signWith"), ADDRESS);
    }
  });

  it("signs eth_signTypedData_v4 as EIP-712 typed data, which Turnkey hashes", async () => {
    const hre = await runtime();
    const { viem } = await hre.network.create("local");
    const wallet = await viem.getWalletClient(ADDRESS);
    const typedData = {
      domain: {
        name: "Ether Mail",
        version: "1",
        chainId: 31337,
        verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
      },
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
        from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
        to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
        contents: "Hello, Bob!",
      },
    } as const;

    const signature = await wallet.signTypedData({ account: ADDRESS, ...typedData });

    assert.equal(await verifyTypedData({ address: ADDRESS, signature, ...typedData }), true);
    const [parameters] = signParameters();
    assert.equal(Reflect.get(Object(parameters), "encoding"), "PAYLOAD_ENCODING_EIP712");
    assert.equal(Reflect.get(Object(parameters), "hashFunction"), "HASH_FUNCTION_NO_OP");
  });

  it("deploys through viem from the Turnkey account, signing the digest", async () => {
    const hre = await runtime();
    const { viem } = await hre.network.create("local");
    const wallet = await viem.getWalletClient(ADDRESS);
    const client = await viem.getPublicClient();

    const hash = await wallet.deployContract({ abi: [], bytecode: BYTECODE });
    const receipt = await client.waitForTransactionReceipt({ hash });

    assert.equal(receipt.status, "success");
    assert.equal(getAddress(receipt.from), ADDRESS);
    assert.ok(receipt.contractAddress);
    assert.equal(await client.getCode({ address: receipt.contractAddress }), RUNTIME_CODE);
    const [parameters] = signParameters();
    assert.equal(Reflect.get(Object(parameters), "hashFunction"), "HASH_FUNCTION_NO_OP");
    assert.equal(Reflect.get(Object(parameters), "encoding"), "PAYLOAD_ENCODING_HEXADECIMAL");
  });

  it("deploys through ethers from the Turnkey account", async () => {
    const hre = await runtime();
    const { ethers } = await hre.network.create("local");
    const signer = await ethers.getSigner(ADDRESS);

    const contract = await new ContractFactory([], BYTECODE, signer).deploy();
    await contract.waitForDeployment();
    const deployment = contract.deploymentTransaction();

    assert.equal(deployment?.from, ADDRESS);
    assert.equal(await ethers.provider.getCode(await contract.getAddress()), RUNTIME_CODE);
    assert.equal(stub.bodies(SIGN_PATH).length, 1);
  });

  it("runs the kms tasks", async () => {
    const hre = await runtime();

    const address = await task(hre, "address", { key: "deployer" });
    assert.equal(address.printed.trim(), ADDRESS);
    assert.equal(stub.requests.length, 0);

    const [vector] = PERSONAL_SIGN_VECTORS;
    const signed = await task(hre, "sign", {
      key: "deployer",
      message: `0x${vector.message}`,
      data: false,
      fromFile: false,
      noHash: false,
      allowCrossChain: false,
    });
    assert.equal(signed.result, vector.signature);

    const digest = `0x${"ab".repeat(32)}`;
    const raw = await task(hre, "sign", {
      key: "deployer",
      message: digest,
      data: false,
      fromFile: false,
      noHash: true,
      allowCrossChain: false,
    });
    assert.match(String(raw.result), /^0x[0-9a-f]{130}$/);

    const typed = await task(hre, "sign", {
      key: "deployer",
      message: JSON.stringify(EIP712_MAIL),
      chain: "1",
      data: true,
      fromFile: false,
      noHash: false,
      allowCrossChain: false,
    });
    assert.match(String(typed.result), /^0x[0-9a-f]{130}$/);

    const accounts = await task(hre, "accounts", {
      json: true,
      showIds: false,
      balances: false,
      checkSign: true,
    });
    const report: unknown = JSON.parse(accounts.printed);
    const [entry] = Reflect.get(Object(report), "accounts");
    assert.equal(Reflect.get(Object(entry), "address"), ADDRESS);
    assert.equal(Reflect.get(Object(entry), "signCheck"), "ok");
    assert.ok(!accounts.printed.includes(ORGANIZATION));

    assert.deepEqual(
      signParameters().map((parameters): unknown[] => [
        Reflect.get(Object(parameters), "encoding"),
        Reflect.get(Object(parameters), "hashFunction"),
      ]),
      [
        ["PAYLOAD_ENCODING_HEXADECIMAL", "HASH_FUNCTION_KECCAK256"],
        ["PAYLOAD_ENCODING_HEXADECIMAL", "HASH_FUNCTION_NO_OP"],
        ["PAYLOAD_ENCODING_EIP712", "HASH_FUNCTION_NO_OP"],
        ["PAYLOAD_ENCODING_HEXADECIMAL", "HASH_FUNCTION_KECCAK256"],
      ],
    );
  });

  it("polls a pending activity through get_activity, and signs with the result", async () => {
    const hre = await runtime();
    const { provider } = await hre.network.create("local");
    stub.firstStatus = "ACTIVITY_STATUS_PENDING";
    stub.pendingPolls = 1;
    const [vector] = PERSONAL_SIGN_VECTORS;

    assert.equal(
      await provider.request({ method: "personal_sign", params: [`0x${vector.message}`, ADDRESS] }),
      vector.signature,
    );
    assert.deepEqual(
      stub.requests.map((request) => request.path),
      [SIGN_PATH, POLL_PATH, POLL_PATH],
    );
    stub.pendingPolls = 0;
  });
});

describe("the core's checks on Turnkey's signatures", () => {
  it("normalizes a high s, with one request", async () => {
    const hre = await runtime();
    const { provider } = await hre.network.create("local");
    stub.mode = "high-s";
    for (const vector of PERSONAL_SIGN_VECTORS) {
      assert.equal(
        await provider.request({
          method: "personal_sign",
          params: [`0x${vector.message}`, ADDRESS],
        }),
        vector.signature,
      );
    }
    assert.equal(stub.requests.length, PERSONAL_SIGN_VECTORS.length);
  });

  it("finds the parity itself when v is wrong, and sends a valid transaction", async () => {
    const hre = await runtime();
    const { viem } = await hre.network.create("local");
    stub.mode = "wrong-v";
    const wallet = await viem.getWalletClient(ADDRESS);
    const client = await viem.getPublicClient();

    const hash = await wallet.sendTransaction({ to: ADDRESS, value: 1n });

    assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    assert.equal(stub.requests.length, 1);
  });

  it("refuses another key's signature after one fresh attempt, and sends nothing", async () => {
    const hre = await runtime();
    const { viem } = await hre.network.create("local");
    stub.mode = "foreign";
    const wallet = await viem.getWalletClient(ADDRESS);
    const client = await viem.getPublicClient();

    await assert.rejects(wallet.sendTransaction({ to: ADDRESS, value: 1n }));

    assert.equal(await client.getTransactionCount({ address: ADDRESS }), 0);
    assert.equal(await client.getBalance({ address: ADDRESS }), 10n ** 20n);
    // The fresh attempt is a new activity: another body, with a later timestampMs.
    const times = stub
      .bodies(SIGN_PATH)
      .map((body) => Number(Reflect.get(Object(body), "timestampMs")));
    assert.equal(times.length, 2);
    assert.ok(times[1] !== undefined && times[0] !== undefined && times[1] > times[0]);
  });

  it("refuses another key's message signature too", async () => {
    const hre = await runtime();
    const { provider } = await hre.network.create("local");
    stub.mode = "foreign";
    const [vector] = PERSONAL_SIGN_VECTORS;
    await assert.rejects(
      provider.request({ method: "personal_sign", params: [`0x${vector.message}`, ADDRESS] }),
    );
    assert.equal(stub.requests.length, 2);
  });
});
