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
  createWalletClient,
  custom,
  getAddress,
  type Hex,
  isHex,
  parseTransaction,
  type SignedAuthorization,
  verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

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
  signContext,
} from "../helpers/keys.ts";
import {
  POLL_PATH,
  SIGN_PATH,
  SIGN_TRANSACTION_PATH,
  SIGN_TRANSACTION_TYPE,
  type SignMode,
  TurnkeyStub,
  turnkeyError,
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
  stub.stuck = undefined;
  stub.requests.length = 0;
});

/** A runtime whose Turnkey adapters talk to the stub, through the package's own handler. */
async function runtime(
  network?: string,
  transactionSigning?: "transaction" | "digest",
  timeoutMs?: number,
) {
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
            ...(transactionSigning === undefined ? {} : { transactionSigning }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            allowRawDigests: true,
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
        // Without automine, the node queues a transaction past a nonce gap instead of refusing it.
        queued: {
          type: "edr-simulated",
          hardfork: "prague",
          accounts: [],
          kmsAccounts: ["deployer"],
          mining: { auto: false, interval: 0 },
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

/** How many sign_transaction and sign_raw_payload requests the stub got. */
function signRequestCounts(): number[] {
  return [stub.bodies(SIGN_TRANSACTION_PATH).length, stub.bodies(SIGN_PATH).length];
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

  it("signs types 0, 1, 2 and 4 as NO_OP digests through sign_raw_payload with transactionSigning digest", async () => {
    const hre = await runtime(undefined, "digest");
    const { viem } = await hre.network.create("local");
    const wallet = await viem.getWalletClient(ADDRESS);
    const client = await viem.getPublicClient();

    const hashes: Hex[] = [
      await wallet.sendTransaction({
        to: OTHER.address,
        value: 1n,
        type: "legacy",
        gasPrice: GAS_PRICE,
      }),
      await wallet.sendTransaction({
        to: OTHER.address,
        value: 1n,
        type: "eip2930",
        gasPrice: GAS_PRICE,
      }),
      await wallet.deployContract({ abi: [], bytecode: BYTECODE, type: "eip1559" }),
      await wallet.sendTransaction({
        to: OTHER.address,
        authorizationList: [await authorizationOf(0)],
      }),
    ];
    for (const hash of hashes) {
      const receipt = await client.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      assert.equal(getAddress(receipt.from), ADDRESS);
    }

    assert.equal(stub.bodies(SIGN_TRANSACTION_PATH).length, 0);
    const parameters = signParameters();
    assert.equal(parameters.length, 4);
    for (const sent of parameters) {
      const fields: object = Object(sent);
      assert.deepEqual(Object.keys(fields).toSorted(), [
        "encoding",
        "hashFunction",
        "payload",
        "signWith",
      ]);
      assert.equal(Reflect.get(fields, "encoding"), "PAYLOAD_ENCODING_HEXADECIMAL");
      assert.equal(Reflect.get(fields, "hashFunction"), "HASH_FUNCTION_NO_OP");
      assert.match(String(Reflect.get(fields, "payload")), /^[0-9a-f]{64}$/);
    }
    assert.ok(stub.requests.every((request) => request.stamped));
  });

  for (const [configured, overridden] of [
    ["transaction", "digest"],
    ["digest", "transaction"],
  ] as const) {
    it(`sends through the override's transactionSigning, ${overridden}, after a send in ${configured}`, async () => {
      const inline = {
        provider: "turnkey",
        organizationId: configVariable("HHKMS_TEST_TURNKEY_ORGANIZATION"),
        address: ACCOUNT.address,
        apiPrivateKey: configVariable("HHKMS_TEST_TURNKEY_API_PRIVATE_KEY"),
        apiPublicKey: API_PUBLIC_KEY,
      } as const;
      const hre = await createHardhatRuntimeEnvironment({
        plugins: [hardhatKmsTurnkey, hardhatViem],
        kms: { simulatedBalance: 10n ** 20n },
        networks: {
          local: {
            type: "edr-simulated",
            hardfork: "prague",
            accounts: [],
            kmsAccounts: [{ ...inline, transactionSigning: configured }],
          },
        },
      });
      hre.hooks.registerHandlers(
        "kms",
        kmsHandlers(
          ownVersion,
          async () => async (key) => await createTurnkeyKeyAdapter(key, { transport: { baseUrl } }),
        ),
      );
      // Two connections to one simulated network do not share its state, so each sends nonce 0.
      const sends = async (connection: Awaited<ReturnType<typeof hre.network.create>>) => {
        const wallet = await connection.viem.getWalletClient(ADDRESS);
        const hash = await wallet.sendTransaction({ to: OTHER.address, value: 1n });
        const receipt = await (
          await connection.viem.getPublicClient()
        ).waitForTransactionReceipt({
          hash,
        });
        assert.equal(receipt.status, "success");
      };

      await sends(await hre.network.create("local"));
      assert.deepEqual(signRequestCounts(), configured === "transaction" ? [1, 0] : [0, 1]);
      await sends(
        await hre.network.create({
          network: "local",
          override: { kmsAccounts: [{ ...inline, transactionSigning: overridden }] },
        }),
      );
      assert.deepEqual(signRequestCounts(), [1, 1]);
    });
  }

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
      yes: true,
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

/** Runs `run` with the variable unset, then sets it back. */
async function withUnset(name: keyof typeof VARIABLES, run: () => Promise<void>): Promise<void> {
  Reflect.deleteProperty(process.env, name);
  try {
    await run();
  } finally {
    process.env[name] = VARIABLES[name];
  }
}

/** Checks that a text names the variable as Hardhat does, and holds no variable's value. */
function assertNames(text: string, name: string): void {
  assert.ok(
    text.includes(`Configuration Variable "${name}" not found`),
    `"${text}" should name ${name}`,
  );
  for (const value of Object.values(VARIABLES)) {
    assert.ok(!text.includes(value), "the text holds a variable's value");
  }
}

/** Checks a thrown error the way `assertNames` checks a text, its stack included. */
function failsNaming(name: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assertNames(error.message, name);
    assertNames(String(error.stack), name);
    return true;
  };
}

describe("a Turnkey key whose configuration variable is unset (#544)", () => {
  for (const name of [
    "HHKMS_TEST_TURNKEY_API_PRIVATE_KEY",
    "HHKMS_TEST_TURNKEY_ORGANIZATION",
  ] as const) {
    it(`names ${name} in kms sign`, async () => {
      const hre = await runtime();
      await withUnset(name, async () => {
        await assert.rejects(
          task(hre, "sign", {
            key: "deployer",
            message: "hello",
            data: false,
            fromFile: false,
            noHash: false,
            allowCrossChain: false,
          }),
          failsNaming(name),
        );
      });
      assert.equal(stub.requests.length, 0);
    });

    it(`names ${name} in kms accounts --check-sign`, async () => {
      const hre = await runtime();
      await withUnset(name, async () => {
        const { printed } = await task(hre, "accounts", {
          json: true,
          showIds: false,
          balances: false,
          checkSign: true,
        });
        const report: unknown = JSON.parse(printed);
        const [entry] = Reflect.get(Object(report), "accounts");
        assert.equal(Reflect.get(Object(entry), "signCheck"), null);
        assertNames(String(Reflect.get(Object(entry), "error")), name);
        for (const value of Object.values(VARIABLES)) {
          assert.ok(!printed.includes(value), "the output holds a variable's value");
        }
      });
      assert.equal(stub.requests.length, 0);
    });

    it(`names ${name} in a send`, async () => {
      const hre = await runtime();
      const { provider } = await hre.network.create("local");
      await withUnset(name, async () => {
        await assert.rejects(
          provider.request({
            method: "eth_sendTransaction",
            params: [{ from: ADDRESS, to: OTHER.address, value: "0x1" }],
          }),
          failsNaming(name),
        );
      });
      assert.equal(stub.requests.length, 0);
    });

    it(`names ${name} through the adapter, with the key Hardhat resolved`, async () => {
      const hre = await runtime();
      const key = hre.config.kms.keys.deployer;
      assert.equal(key?.provider, "turnkey");
      await withUnset(name, async () => {
        const adapter = await createTurnkeyKeyAdapter(key, { transport: { baseUrl } });
        await assert.rejects(
          adapter.signDigest?.({ digest: new Uint8Array(32).fill(7) }, signContext()) ??
            Promise.reject(new Error("the adapter has no signDigest")),
          failsNaming(name),
        );
      });
      assert.equal(stub.requests.length, 0);
    });
  }
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

/** The nonce and value of a sign_transaction body's unsigned transaction. */
function unsignedOf(body: unknown): { nonce: number; value: bigint } {
  const parameters: unknown = Reflect.get(Object(body), "parameters");
  const parsed = parseTransaction(
    `0x${String(Reflect.get(Object(parameters), "unsignedTransaction"))}`,
  );
  return { nonce: parsed.nonce ?? 0, value: parsed.value ?? 0n };
}

/** Keeps the sign_transaction activity of the transaction with this value pending. */
const stuckOn =
  (value: bigint) =>
  (body: unknown): boolean =>
    Reflect.get(Object(body), "type") === SIGN_TRANSACTION_TYPE && unsignedOf(body).value === value;

/** The nonces of the sign_transaction requests, in the order the stub got them. */
function signedNonces(): number[] {
  return stub.bodies(SIGN_TRANSACTION_PATH).map((body) => unsignedOf(body).nonce);
}

/** Every message in an error's cause chain, as viem wraps the plugin's error. */
function causeText(error: unknown): string {
  let text = "";
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    text += `${cause.message}\n`;
  }
  return text;
}

describe("a Turnkey transaction that Turnkey has not finished when the plugin gives up (#537)", () => {
  const TIMEOUT_MS = 1300;

  it("keeps the nonce held after a timeout while polling, names the activity, and the next send takes the next nonce", async () => {
    const hre = await runtime(undefined, undefined, TIMEOUT_MS);
    const { provider, viem } = await hre.network.create("queued");
    const client = await viem.getPublicClient();
    stub.stuck = stuckOn(1n);

    await assert.rejects(
      provider.request({
        method: "eth_sendTransaction",
        params: [{ from: ADDRESS, to: OTHER.address, value: "0x1" }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /^turnkey, sign transaction, key turnkey:<HHKMS_TEST_TURNKEY_ORGANIZATION>\/0x[0-9a-fA-F]{40}: no answer within 1300 ms\. The request reached the provider, and Turnkey may still sign this transaction \(activity 00000000-0000-4000-8000-[0-9]{12}\); anyone who can read it there can then broadcast it with nonce 0\. Reject the activity in the Turnkey dashboard while it is pending; then, or if it completed, send a replacement transaction with nonce 0, before any other transaction from this account\. Until nonce 0 is mined, the provider's copy itself reaches the node through this network connection, or the connection closes, the connection's sends from this account skip nonce 0/,
        );
        assert.ok(!error.message.includes(ORGANIZATION));
        return true;
      },
    );
    assert.ok(stub.requests.some((request) => request.path === POLL_PATH));
    stub.stuck = undefined;

    // The next send skips nonce 0: a gap, never a second transaction with nonce 0.
    const queued = await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: OTHER.address, value: "0x2" }],
    });
    assert.deepEqual(signedNonces(), [0, 1]);
    assert.equal(await client.getTransactionCount({ address: ADDRESS }), 0);

    // The replacement the error asks for fills the gap, and both are mined.
    const replacement = await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: OTHER.address, value: "0x3", nonce: "0x0" }],
    });
    await provider.request({ method: "evm_mine", params: [] });
    assert.equal(
      (await client.waitForTransactionReceipt({ hash: assertHash(replacement) })).status,
      "success",
    );
    assert.equal(
      (await client.waitForTransactionReceipt({ hash: assertHash(queued) })).status,
      "success",
    );
    assert.equal(await client.getTransactionCount({ address: ADDRESS }), 2);
    assert.equal(await client.getBalance({ address: OTHER.address }), 5n);
  });

  it("keeps the nonce held after an abort while polling, through viem's reset", async () => {
    const hre = await runtime();
    const { provider, kms } = await hre.network.create("queued");
    // A Turnkey key has no public-key call: its first signature reveals the key to getAccount.
    const [vector] = PERSONAL_SIGN_VECTORS;
    await provider.request({ method: "personal_sign", params: [`0x${vector.message}`, ADDRESS] });
    const controller = new AbortController();
    const account = await kms.getAccount(ADDRESS, { signal: controller.signal });
    const wallet = createWalletClient({ account, chain: hardhat, transport: custom(provider) });
    stub.stuck = stuckOn(5n);

    const sending = wallet.sendTransaction({ to: OTHER.address, value: 5n });
    while (!stub.requests.some((request) => request.path === POLL_PATH)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await assert.rejects(sending, (error: unknown) => {
      assert.match(
        causeText(error),
        /cancelled by the caller's abort signal\. The request reached the provider, and Turnkey may still sign this transaction \(activity [0-9a-f-]{36}\); anyone who can read it there can then broadcast it with nonce 0/,
      );
      return true;
    });
    stub.stuck = undefined;

    await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: OTHER.address, value: "0x6" }],
    });
    assert.deepEqual(signedNonces(), [0, 1]);
  });

  it("keeps the nonce held when the activity needs approval, and names the cause and the activity", async () => {
    const hre = await runtime(undefined, undefined, TIMEOUT_MS);
    const { provider } = await hre.network.create("queued");
    stub.firstStatus = "ACTIVITY_STATUS_CONSENSUS_NEEDED";

    await assert.rejects(
      provider.request({
        method: "eth_sendTransaction",
        params: [{ from: ADDRESS, to: OTHER.address, value: "0x1" }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /^turnkey, sign transaction, key [^ ]+: Turnkey holds activity (00000000-0000-4000-8000-[0-9]{12}) until it gets more approvals \(ACTIVITY_STATUS_CONSENSUS_NEEDED\)\. .*Reject it in the Turnkey dashboard, so that nobody approves it later\. The request reached the provider, and Turnkey may still sign this transaction \(activity \1\); anyone who can read it there can then broadcast it with nonce 0\. Reject the activity in the Turnkey dashboard while it is pending; then, or if it completed, send a replacement transaction with nonce 0,/,
        );
        return true;
      },
    );
    stub.firstStatus = "ACTIVITY_STATUS_COMPLETED";

    await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: OTHER.address, value: "0x2" }],
    });
    assert.deepEqual(signedNonces(), [0, 1]);
  });

  it("keeps the nonce held after a signed transaction it refused, or a failed poll", async () => {
    const hre = await runtime(undefined, undefined, TIMEOUT_MS);
    const { provider } = await hre.network.create("queued");
    stub.mode = "other-body";
    await assert.rejects(
      provider.request({
        method: "eth_sendTransaction",
        params: [{ from: ADDRESS, to: OTHER.address, value: "0x1" }],
      }),
      /Turnkey signed a transaction whose value differs .*The request reached the provider, and Turnkey may still sign this transaction \(activity [0-9a-f-]{36}\); anyone who can read it there can then broadcast it with nonce 0\./,
    );
    stub.mode = "good";
    // A pending activity the stub does not know, so its poll answers 404.
    stub.answer({
      status: 200,
      json: {
        activity: {
          id: "00000000-0000-4000-8000-0000000000fe",
          organizationId: ORGANIZATION,
          status: "ACTIVITY_STATUS_PENDING",
          type: SIGN_TRANSACTION_TYPE,
        },
      },
    });
    await assert.rejects(
      provider.request({
        method: "eth_sendTransaction",
        params: [{ from: ADDRESS, to: OTHER.address, value: "0x2" }],
      }),
      /Turnkey answered 404 NOT_FOUND.*The request reached the provider, and Turnkey may still sign this transaction \(activity 00000000-0000-4000-8000-0000000000fe\); .*broadcast it with nonce 1\./,
    );
    await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: OTHER.address, value: "0x3" }],
    });
    assert.deepEqual(signedNonces(), [0, 1, 2]);
  });

  it("releases the nonce when Turnkey refuses the request for certain", async () => {
    const hre = await runtime(undefined, undefined, TIMEOUT_MS);
    const { provider, viem } = await hre.network.create("local");
    const client = await viem.getPublicClient();
    const rejected = {
      status: 200,
      json: {
        activity: {
          id: "00000000-0000-4000-8000-0000000000ff",
          organizationId: ORGANIZATION,
          status: "ACTIVITY_STATUS_REJECTED",
          type: SIGN_TRANSACTION_TYPE,
        },
      },
    };
    for (const refusal of [turnkeyError(403, "POLICY_DENIED"), rejected]) {
      stub.answer(refusal);
      await assert.rejects(
        provider.request({
          method: "eth_sendTransaction",
          params: [{ from: ADDRESS, to: OTHER.address, value: "0x1" }],
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(!error.message.includes("The request reached the provider"), error.message);
          return true;
        },
      );
    }
    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: OTHER.address, value: "0x2" }],
    });
    assert.equal(
      (await client.waitForTransactionReceipt({ hash: assertHash(hash) })).status,
      "success",
    );
    assert.deepEqual(signedNonces(), [0, 0, 0]);
  });

  it("releases the nonce in digest mode, whose activity holds only a hash", async () => {
    const hre = await runtime(undefined, "digest", TIMEOUT_MS);
    const { provider, viem } = await hre.network.create("local");
    const client = await viem.getPublicClient();
    stub.stuck = () => true;

    await assert.rejects(
      provider.request({
        method: "eth_sendTransaction",
        params: [{ from: ADDRESS, to: OTHER.address, value: "0x1" }],
      }),
      /: no answer within 1300 ms$/,
    );
    stub.stuck = undefined;

    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: OTHER.address, value: "0x2" }],
    });
    const mined = await client.waitForTransactionReceipt({ hash: assertHash(hash) });
    assert.equal(mined.status, "success");
    assert.equal((await client.getTransaction({ hash: mined.transactionHash })).nonce, 0);
    assert.equal(stub.bodies(SIGN_TRANSACTION_PATH).length, 0);
  });

  it("releases the nonce when the request fails before it leaves", async () => {
    const hre = await runtime(undefined, undefined, TIMEOUT_MS);
    const { provider, viem } = await hre.network.create("local");
    const client = await viem.getPublicClient();
    const variable = "HHKMS_TEST_TURNKEY_API_PRIVATE_KEY";
    Reflect.deleteProperty(process.env, variable);
    try {
      await assert.rejects(
        provider.request({
          method: "eth_sendTransaction",
          params: [{ from: ADDRESS, to: OTHER.address, value: "0x1" }],
        }),
        /Configuration Variable "HHKMS_TEST_TURNKEY_API_PRIVATE_KEY" not found/,
      );
    } finally {
      process.env[variable] = API_PRIVATE_KEY;
    }
    assert.equal(stub.requests.length, 0);

    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: OTHER.address, value: "0x2" }],
    });
    assert.equal(
      (await client.waitForTransactionReceipt({ hash: assertHash(hash) })).status,
      "success",
    );
    assert.deepEqual(signedNonces(), [0]);
  });

  it("keeps ten parallel sends on distinct nonces when one of them hangs", async () => {
    const hre = await runtime(undefined, undefined, TIMEOUT_MS);
    const { provider, viem } = await hre.network.create("queued");
    const client = await viem.getPublicClient();
    stub.stuck = stuckOn(3n);

    const results = await Promise.all(
      Array.from({ length: 10 }, async (_, value) => {
        try {
          const hash: unknown = await provider.request({
            method: "eth_sendTransaction",
            params: [{ from: ADDRESS, to: OTHER.address, value: `0x${value.toString(16)}` }],
          });
          return hash;
        } catch (error) {
          return error;
        }
      }),
    );

    const failed = results.filter((result) => result instanceof Error);
    assert.equal(failed.length, 1);
    assert.ok(results[3] instanceof Error);
    assert.match(results[3].message, /broadcast it with nonce 3\./);
    const nonces = signedNonces();
    assert.deepEqual(
      nonces.toSorted((a, b) => a - b),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
    // Nine transactions reach the node, none of them with the held nonce 3.
    const sent = await Promise.all(
      results
        .filter((result) => !(result instanceof Error))
        .map(async (hash) => await client.getTransaction({ hash: assertHash(hash) })),
    );
    assert.deepEqual(
      sent.map((transaction) => transaction.nonce).toSorted((a, b) => a - b),
      [0, 1, 2, 4, 5, 6, 7, 8, 9],
    );
    stub.stuck = undefined;
    const replacement = await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: OTHER.address, value: "0x0", nonce: "0x3" }],
    });
    await provider.request({ method: "evm_mine", params: [] });
    await client.waitForTransactionReceipt({ hash: assertHash(replacement) });
    assert.equal(await client.getTransactionCount({ address: ADDRESS }), 10);
  });
});

/** A transaction hash from an RPC answer. */
function assertHash(value: unknown): Hex {
  assert.ok(typeof value === "string" && isHex(value) && value.length === 66, String(value));
  return value;
}
