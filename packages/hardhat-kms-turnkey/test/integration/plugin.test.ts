// @hardhat-kms/turnkey in a real Hardhat runtime, against a local Turnkey stub over HTTP: the
// adapter's own fetch, stamps and parsing, then the core's checks, through the RPC accounts, the
// kms tasks, and viem and ethers deploys on edr-simulated. The stub checks every X-Stamp and signs
// with a secp256k1 test key; it can answer with a high s, a wrong v or another key's signature, and
// for sign_transaction with another transaction, another type or a cut-short answer.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it, mock } from "node:test";

import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import { ContractFactory, type TransactionRequest } from "ethers";
import hardhatKms from "hardhat-kms";
import type { KmsKeyConfig } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import {
  type Address,
  getAddress,
  type Hex,
  isHex,
  parseTransaction,
  type SignedAuthorization,
  verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  COW_ACCOUNT,
  EIP712_MAIL,
  PERSONAL_SIGN_VECTORS,
} from "../../../hardhat-kms/test/helpers/vectors.ts";
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
import {
  POLL_PATH,
  SIGN_PATH,
  SIGN_TRANSACTION_PATH,
  SIGN_TRANSACTION_TYPE,
  type SignMode,
  TurnkeyStub,
} from "../helpers/turnkey-stub.ts";

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
const DELEGATE: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
/** Another account, whose EIP-7702 authorization the Turnkey account sends in a type 4 transaction. */
const OTHER = privateKeyToAccount(`0x${COW_ACCOUNT.secretKey}`);
const GAS_PRICE = 2_000_000_000n;

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
async function runtime(network?: string) {
  const hre = await createHardhatRuntimeEnvironment(
    {
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
        local: {
          type: "edr-simulated",
          hardfork: "prague",
          accounts: [],
          kmsAccounts: ["deployer"],
        },
      },
    },
    network === undefined ? {} : { network },
  );
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

/** The sign_transaction requests the stub got: their parameters and the activity type. */
function transactionRequests(): Array<{ type: unknown; parameters: Record<string, unknown> }> {
  return stub.bodies(SIGN_TRANSACTION_PATH).map((body) => ({
    type: Reflect.get(Object(body), "type"),
    parameters: Object(Reflect.get(Object(body), "parameters")),
  }));
}

/**
 * Checks that each sign_transaction request carried the core's unsigned bytes as hex without 0x,
 * `TRANSACTION_TYPE_ETHEREUM` and the checksummed address, and returns the transaction types.
 */
function sentTypes(): string[] {
  const requests = transactionRequests();
  assert.ok(stub.requests.every((request) => request.stamped));
  return requests.map(({ type, parameters }) => {
    assert.equal(type, SIGN_TRANSACTION_TYPE);
    assert.deepEqual(Object.keys(parameters), ["signWith", "unsignedTransaction", "type"]);
    assert.equal(parameters.signWith, ADDRESS);
    assert.equal(parameters.type, "TRANSACTION_TYPE_ETHEREUM");
    const unsigned = String(parameters.unsignedTransaction);
    assert.match(unsigned, /^(?:[0-9a-f]{2})+$/);
    const parsed = parseTransaction(`0x${unsigned}`);
    assert.equal(parsed.r, undefined, "the request carries no signature");
    return String(parsed.type);
  });
}

/** An authorization from another account, for a type 4 transaction. */
async function authorizationOf(nonce: number): Promise<SignedAuthorization> {
  return await OTHER.signAuthorization({ contractAddress: DELEGATE, chainId: 31337, nonce });
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

  it("deploys and calls through viem with types 0, 1, 2 and 4, each through sign_transaction", async () => {
    const hre = await runtime();
    const { viem } = await hre.network.create("local");
    const wallet = await viem.getWalletClient(ADDRESS);
    const client = await viem.getPublicClient();

    /** Deploys, then calls the contract, with one transaction type. */
    const deployAndCall = async (
      deploy: () => Promise<Hex>,
      call: (to: Address) => Promise<Hex>,
    ): Promise<Address> => {
      const deployed = await client.waitForTransactionReceipt({ hash: await deploy() });
      assert.equal(deployed.status, "success");
      assert.equal(getAddress(deployed.from), ADDRESS);
      const address = deployed.contractAddress ?? undefined;
      assert.ok(address);
      assert.equal(await client.getCode({ address }), RUNTIME_CODE);
      const called = await client.waitForTransactionReceipt({ hash: await call(address) });
      assert.equal(called.status, "success");
      return address;
    };
    await deployAndCall(
      async () =>
        await wallet.deployContract({
          abi: [],
          bytecode: BYTECODE,
          type: "legacy",
          gasPrice: GAS_PRICE,
        }),
      async (to) =>
        await wallet.sendTransaction({ to, data: "0x01", type: "legacy", gasPrice: GAS_PRICE }),
    );
    await deployAndCall(
      async () =>
        await wallet.deployContract({
          abi: [],
          bytecode: BYTECODE,
          type: "eip2930",
          gasPrice: GAS_PRICE,
        }),
      async (to) =>
        await wallet.sendTransaction({ to, data: "0x01", type: "eip2930", gasPrice: GAS_PRICE }),
    );
    const contract = await deployAndCall(
      async () => await wallet.deployContract({ abi: [], bytecode: BYTECODE, type: "eip1559" }),
      async (to) => await wallet.sendTransaction({ to, data: "0x01", type: "eip1559" }),
    );
    const delegated = await client.waitForTransactionReceipt({
      hash: await wallet.sendTransaction({
        to: contract,
        data: "0x01",
        authorizationList: [await authorizationOf(0)],
      }),
    });
    assert.equal(delegated.status, "success");
    assert.equal(delegated.type, "eip7702");

    assert.deepEqual(sentTypes(), [
      "legacy",
      "legacy",
      "eip2930",
      "eip2930",
      "eip1559",
      "eip1559",
      "eip7702",
    ]);
    assert.equal(stub.bodies(SIGN_PATH).length, 0);
  });

  it("deploys and calls through ethers with types 0, 1, 2 and 4, each through sign_transaction", async () => {
    const hre = await runtime();
    const { ethers } = await hre.network.create("local");
    const signer = await ethers.getSigner(ADDRESS);

    let contract = "";
    for (const type of [0, 1, 2]) {
      const fees: TransactionRequest = type === 2 ? {} : { gasPrice: GAS_PRICE };
      const deployed = await new ContractFactory([], BYTECODE, signer).deploy({ type, ...fees });
      await deployed.waitForDeployment();
      assert.equal(deployed.deploymentTransaction()?.from, ADDRESS);
      contract = await deployed.getAddress();
      assert.equal(await ethers.provider.getCode(contract), RUNTIME_CODE);
      const called = await (
        await signer.sendTransaction({ to: contract, data: "0x01", type, ...fees })
      ).wait();
      assert.equal(called?.status, 1);
      assert.equal(called?.type, type);
    }
    const authorization = await authorizationOf(0);
    const delegated = await (
      await signer.sendTransaction({
        to: contract,
        data: "0x01",
        type: 4,
        authorizationList: [
          {
            address: authorization.address,
            chainId: BigInt(authorization.chainId),
            nonce: BigInt(authorization.nonce),
            signature: {
              r: authorization.r,
              s: authorization.s,
              yParity: authorization.yParity === 1 ? 1 : 0,
            },
          },
        ],
      })
    ).wait();
    assert.equal(delegated?.status, 1);
    assert.equal(delegated?.type, 4);

    assert.deepEqual(sentTypes(), [
      "legacy",
      "legacy",
      "eip2930",
      "eip2930",
      "eip1559",
      "eip1559",
      "eip7702",
    ]);
    assert.equal(stub.bodies(SIGN_PATH).length, 0);
  });

  it("signs with kms sign-tx through sign_transaction", async () => {
    const hre = await runtime("local");
    const scratch = mkdtempSync(path.join(tmpdir(), "hardhat-kms-turnkey-sign-tx-"));
    try {
      const file = path.join(scratch, "tx.json");
      writeFileSync(
        file,
        JSON.stringify({
          to: OTHER.address,
          value: "0x1",
          chainId: "0x7a69",
          nonce: "0x0",
          gas: "0x5208",
          maxFeePerGas: "0x77359400",
          maxPriorityFeePerGas: "0x1",
        }),
      );
      const signed = await task(hre, "sign-tx", { key: "deployer", tx: file });
      const raw = signed.printed.trim();
      assert.match(raw, /^0x02[0-9a-f]+$/);
      assert.ok(isHex(raw));
      const parsed = parseTransaction(raw);
      assert.equal(getAddress(parsed.to ?? ""), OTHER.address);
      assert.deepEqual(sentTypes(), ["eip1559"]);
      assert.equal(stub.bodies(SIGN_PATH).length, 0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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

  it("fails kms history with the unsupported error, naming neither the organization nor the address", async () => {
    const hre = await runtime();

    await assert.rejects(task(hre, "history", { key: "deployer" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "turnkey, history: kms history does not read Turnkey keys yet: @hardhat-kms/turnkey signs with them but has no audit log reader. Read the key's activity with Turnkey's own tools",
      );
      assert.ok(!error.message.includes(ORGANIZATION));
      assert.ok(!error.message.toLowerCase().includes(ACCOUNT.address.slice(2).toLowerCase()));
      return true;
    });
    assert.equal(stub.requests.length, 0);
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

  it("normalizes a high s in a signed transaction, with one request", async () => {
    const hre = await runtime();
    const { viem } = await hre.network.create("local");
    stub.mode = "high-s";
    const wallet = await viem.getWalletClient(ADDRESS);
    const client = await viem.getPublicClient();

    const hash = await wallet.sendTransaction({ to: ADDRESS, value: 1n });

    assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    assert.equal(stub.bodies(SIGN_TRANSACTION_PATH).length, 1);
  });

  it("finds the parity itself when v is wrong, and sends a valid transaction", async () => {
    const hre = await runtime();
    const { viem } = await hre.network.create("local");
    stub.mode = "wrong-v";
    const wallet = await viem.getWalletClient(ADDRESS);
    const client = await viem.getPublicClient();

    const hash = await wallet.sendTransaction({ to: ADDRESS, value: 1n });

    assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    assert.equal(stub.bodies(SIGN_TRANSACTION_PATH).length, 1);
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
      .bodies(SIGN_TRANSACTION_PATH)
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

describe("the Turnkey adapter's checks on signed transactions", () => {
  const hostile: Array<{ mode: SignMode; message: RegExp }> = [
    {
      mode: "other-body",
      message:
        /turnkey, sign transaction, key turnkey:<HHKMS_TEST_TURNKEY_ORGANIZATION>\/0x[0-9a-fA-F]{40}: Turnkey signed a transaction whose value differs from the transaction the plugin sent/,
    },
    { mode: "wrong-type", message: /Turnkey signed a transaction whose type differs/ },
    {
      mode: "malformed",
      message:
        /Turnkey answered in a form this plugin does not read: the signed transaction is not one canonical RLP list/,
    },
  ];
  for (const { mode, message } of hostile) {
    it(`refuses a signed transaction in mode ${mode}, and broadcasts nothing`, async () => {
      const hre = await runtime();
      const { viem } = await hre.network.create("local");
      stub.mode = mode;
      const wallet = await viem.getWalletClient(ADDRESS);
      const client = await viem.getPublicClient();

      await assert.rejects(
        wallet.sendTransaction({ to: OTHER.address, value: 1n }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          let text = "";
          for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
            text += `${cause.message}\n`;
          }
          assert.match(text, message);
          assert.ok(!text.includes(ORGANIZATION));
          return true;
        },
      );

      assert.equal(await client.getTransactionCount({ address: ADDRESS }), 0);
      assert.equal(await client.getBalance({ address: ADDRESS }), 10n ** 20n);
      assert.equal(await client.getBalance({ address: OTHER.address }), 0n);
      assert.equal(stub.bodies(SIGN_TRANSACTION_PATH).length, 1);
    });
  }
});
