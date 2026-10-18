// The Turnkey smoke test's cases, run through the plugin in a Hardhat runtime: the RPC accounts of
// a local simulated network and the `kms` tasks. Nothing is sent to a public chain, except one
// optional EIP-1559 self-send on Sepolia. `turnkey.live.test.ts` runs them against Turnkey, and
// `test/integration/live-smoke.test.ts` against the local stub.
//
// Sign requests per run, at most:
//   1 personal_sign, 1 eth_signTypedData_v4, 1 `kms sign --no-hash`, 1 `kms sign-auth`,
//   3 `kms sign-tx` (types 2, 0 and 4), 1 `kms sign-tx` with `transactionSigning: "digest"`,
//   1 denied, 1 pending approval, and 1 optional Sepolia send: 11.
// The two credential checks create no sign activity.
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";

import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { NetworkUserConfig } from "hardhat/types/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import {
  type Address,
  getAddress,
  type Hex,
  isHex,
  keccak256,
  parseTransaction,
  recoverAddress,
  serializeTransaction,
  toHex,
  verifyMessage,
  verifyTypedData,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverAuthorizationAddress } from "viem/utils";

import hardhatKmsTurnkey from "../../src/index.ts";
import { createTurnkeyKeyAdapter } from "../../src/internal/adapter.ts";
import {
  type Answer,
  defaultTransport,
  type RequestContext,
  type Transport,
  TurnkeyClient,
} from "../../src/internal/client.ts";
import { ERRORS } from "../../src/internal/error-catalog.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { apiKeyFromPrivateKey } from "../../src/internal/stamp.ts";
import { legacyV, type LiveRecorder } from "./smoke.ts";

/** The chain of the local simulated network: no signature here is valid on a public chain. */
const LOCAL_CHAIN_ID = 31_337;
const SEPOLIA_CHAIN_ID = 11_155_111;
/** A delegate for the EIP-7702 authorizations: the zero-code address 0x…7702. */
const DELEGATE: Address = "0x0000000000000000000000000000000000007702";
/** The recipient of the signed, never-sent transactions. */
const RECIPIENT: Address = "0x000000000000000000000000000000000000dEaD";
const WHOAMI_PATH = "/public/v1/query/whoami";
const CREATE_API_KEYS_PATH = "/public/v1/submit/create_api_keys";
const DELETE_API_KEYS_PATH = "/public/v1/submit/delete_api_keys";
/** How stale the stale-timestamp request is: past Turnkey's 1-hour window. */
const STALE_MS = 2 * 60 * 60 * 1000;
/** The Sepolia send's gas price limit, as in the three-cloud suite. */
const MAX_SEPOLIA_FEE = 20_000_000_000n;
const RECEIPT_TIMEOUT_MS = 300_000;

/** One case: its title and what it runs. */
export interface SmokeCase {
  name: string;
  run: (smoke: Smoke) => Promise<string | { skip: string } | undefined>;
}

/** The runtime the cases share. */
export interface Smoke {
  hre: HardhatRuntimeEnvironment;
  settings: SmokeSettings;
  /** The allowed account, checksummed. */
  address: Address;
  now: () => number;
  /** Writes a transaction for `kms sign-tx` and returns its path. */
  txFile: (tx: Record<string, unknown>) => string;
  /** Removes the scratch directory. */
  close: () => void;
}

/** What the cases need. */
export interface SmokeSettings {
  /** The allowed account, which the guide's policy lets the API user sign with. */
  address: string;
  /** An account no policy covers. */
  denied: string;
  /** An account under a policy that needs 2 approvers. */
  consensus: string;
  /** The names of the variables that hold the organization id and the API private key. */
  variables: { organizationId: string; apiPrivateKey: string };
  /** The transport the adapters and the credential checks use; the recorder's `fetch` in it. */
  transport: Partial<Transport>;
  recorder: LiveRecorder;
  /** The Sepolia RPC URL, when the run sends one transaction there; otherwise that case skips. */
  sepoliaUrl?: string | undefined;
  /** The current time, for the requests the cases build themselves. */
  now?: () => number;
}

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/** A `0x` hex string from an unknown value, or a failed assertion. */
function hexOf(value: unknown, what: string): Hex {
  assert.ok(typeof value === "string" && isHex(value), `${what} is not hex`);
  return value;
}

/** The fixed part of a catalogue template between two placeholders, to find it in a message. */
function templatePart(template: string, after: string, before: string): string {
  const start = template.indexOf(after) + after.length;
  const end = template.indexOf(before, start);
  return template.slice(start, end === -1 ? undefined : end);
}

const FORBIDDEN_TEXT = templatePart(ERRORS.forbidden.template, "{status}", "{request}");
const TIMESTAMP_TEXT = templatePart(ERRORS.timestamp.template, "{status}", ".");
const APPROVAL_NEEDED =
  /Turnkey holds activity ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) until it gets more approvals \(ACTIVITY_STATUS_CONSENSUS_NEEDED\)/i;

/** The messages of an error and its causes. */
function textOf(error: unknown): string {
  let text = "";
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    text += `${cause.message}\n`;
  }
  return text;
}

const ownVersion = String(
  field(createRequire(import.meta.url)("@hardhat-kms/turnkey/package.json"), "version"),
);

/**
 * Builds the runtime the cases share. It has four keys on the same organization and API key:
 * `allowed`, `digest` (the allowed account with `transactionSigning: "digest"`), `denied` and
 * `consensus`, and a `local` simulated network whose only account is `allowed`.
 *
 * @param settings - The accounts, variables, transport and recorder.
 * @returns The shared runtime; call `close` when the run ends.
 */
export async function openSmoke(settings: SmokeSettings): Promise<Smoke> {
  const now = settings.now ?? Date.now;
  const address = getAddress(settings.address);
  const turnkeyKey = (account: string, transactionSigning?: "transaction" | "digest") => ({
    provider: "turnkey" as const,
    organizationId: configVariable(settings.variables.organizationId),
    address: account,
    apiPrivateKey: configVariable(settings.variables.apiPrivateKey),
    ...(transactionSigning === undefined ? {} : { transactionSigning }),
  });
  const networks: Record<string, NetworkUserConfig> = {
    local: {
      type: "edr-simulated",
      hardfork: "prague",
      chainId: LOCAL_CHAIN_ID,
      accounts: [],
      kmsAccounts: ["allowed"],
    },
  };
  if (settings.sepoliaUrl !== undefined) {
    networks.sepolia = {
      type: "http",
      chainType: "l1",
      url: settings.sepoliaUrl,
      chainId: SEPOLIA_CHAIN_ID,
      accounts: [],
      kmsAccounts: ["allowed"],
    };
  }
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKmsTurnkey],
      kms: {
        keys: {
          allowed: turnkeyKey(settings.address),
          digest: turnkeyKey(settings.address, "digest"),
          denied: turnkeyKey(settings.denied),
          consensus: turnkeyKey(settings.consensus),
        },
      },
      networks,
    },
    { network: "local" },
  );
  hre.hooks.registerHandlers(
    "kms",
    kmsHandlers(
      ownVersion,
      async () => async (key) =>
        await createTurnkeyKeyAdapter(key, { transport: settings.transport }),
    ),
  );
  const scratch = mkdtempSync(path.join(tmpdir(), "hardhat-kms-turnkey-smoke-"));
  let files = 0;

  return {
    hre,
    settings,
    address,
    now,
    txFile: (tx) => {
      const file = path.join(scratch, `tx-${files++}.json`);
      writeFileSync(file, JSON.stringify(tx));
      return file;
    },
    close: () => {
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/** The cases, in the order they run. */
export const SMOKE_CASES: readonly SmokeCase[] = [
  {
    name: "the API user cannot add an API key to itself (create_api_keys is denied)",
    run: async ({ settings, now }) => {
      const error = await credentialCheck(settings, now(), now);
      assert.ok(error !== undefined);
      const last = settings.recorder.exchanges.findLast(
        (exchange) => exchange.path === "create_api_keys",
      );
      assert.equal(last?.status, 403, `create_api_keys answered ${String(last?.status)}, not 403`);
      return last.code === undefined ? "403" : `403 ${last.code}`;
    },
  },
  {
    name: "a request older than an hour fails as turnkey.service.timestamp",
    run: async ({ settings, now }) => {
      const error = await credentialCheck(settings, now() - STALE_MS, now);
      const text = textOf(error);
      assert.ok(
        text.includes(TIMESTAMP_TEXT),
        `a stale create_api_keys did not fail with turnkey.service.timestamp: ${text}`,
      );
      const last = settings.recorder.exchanges.findLast(
        (exchange) => exchange.path === "create_api_keys",
      );
      return `HTTP ${String(last?.status)}${last?.code === undefined ? "" : ` ${last.code}`}`;
    },
  },
  {
    name: "personal_sign: Turnkey hashes the unprefixed EIP-191 preimage with KECCAK256",
    run: async ({ hre, address }) => {
      const message = `hardhat-kms Turnkey smoke test ${randomBytes(8).toString("hex")}`;
      const { provider } = await hre.network.create("local");
      const signature = hexOf(
        await provider.request({ method: "personal_sign", params: [toHex(message), address] }),
        "the signature",
      );
      assert.ok(await verifyMessage({ address, message, signature }));
      return undefined;
    },
  },
  {
    name: "eth_signTypedData_v4: Turnkey's EIP-712 hash equals the core's",
    run: async ({ hre, address }) => {
      const typedData = {
        domain: {
          name: "hardhat-kms smoke",
          version: "1",
          chainId: LOCAL_CHAIN_ID,
          verifyingContract: RECIPIENT,
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
            { name: "nonce", type: "uint256" },
          ],
        },
        primaryType: "Mail",
        message: {
          from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
          to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
          contents: "Hello, Bob!",
          nonce: BigInt(`0x${randomBytes(8).toString("hex")}`),
        },
      } as const;
      const { provider } = await hre.network.create("local");
      const signature = hexOf(
        await provider.request({
          method: "eth_signTypedData_v4",
          params: [
            address,
            JSON.stringify(typedData, (_key, value: unknown) =>
              typeof value === "bigint" ? value.toString() : value,
            ),
          ],
        }),
        "the signature",
      );
      assert.ok(await verifyTypedData({ address, signature, ...typedData }));
      return undefined;
    },
  },
  {
    name: "kms sign --no-hash: a raw digest with HASH_FUNCTION_NO_OP",
    run: async ({ hre, address }) => {
      const digest = toHex(randomBytes(32));
      const signature = hexOf(
        await task(hre, ["kms", "sign"], {
          key: "allowed",
          message: digest,
          data: false,
          fromFile: false,
          noHash: true,
          allowCrossChain: false,
        }),
        "the signature",
      );
      assert.equal(await recoverAddress({ hash: digest, signature }), address);
      return undefined;
    },
  },
  {
    name: "kms sign-auth: an EIP-7702 authorization",
    run: async ({ hre, address }) => {
      const signed = await task(hre, ["kms", "sign-auth"], {
        key: "allowed",
        delegate: DELEGATE,
        chain: undefined,
        nonce: "0",
        selfBroadcast: false,
        force: false,
      });
      const yParity = Number(hexOf(field(signed, "yParity"), "yParity"));
      assert.ok(yParity === 0 || yParity === 1);
      const recovered = await recoverAuthorizationAddress({
        authorization: { address: DELEGATE, chainId: LOCAL_CHAIN_ID, nonce: 0 },
        signature: {
          r: hexOf(field(signed, "r"), "r"),
          s: hexOf(field(signed, "s"), "s"),
          yParity,
        },
      });
      assert.equal(recovered, address);
      return undefined;
    },
  },
  {
    name: "kms sign-tx type 2 (EIP-1559) through sign_transaction, not sent",
    run: async ({ hre, address, txFile }) =>
      await signTx(hre, "allowed", txFile(eip1559Tx(0)), "eip1559", address),
  },
  {
    name: "kms sign-tx type 0 (legacy, EIP-155 v) through sign_transaction, not sent",
    run: async ({ hre, address, txFile }) =>
      await signTx(
        hre,
        "allowed",
        txFile({
          type: "0x0",
          chainId: toHex(LOCAL_CHAIN_ID),
          nonce: "0x0",
          gas: "0x5208",
          gasPrice: "0x77359400",
          to: RECIPIENT,
          value: "0x0",
        }),
        "legacy",
        address,
      ),
  },
  {
    name: "kms sign-tx type 4 (EIP-7702, with another key's authorization) through sign_transaction, not sent",
    run: async ({ hre, address, txFile }) => {
      const other = privateKeyToAccount(generatePrivateKey());
      const authorization = await other.signAuthorization({
        contractAddress: DELEGATE,
        chainId: LOCAL_CHAIN_ID,
        nonce: 0,
      });
      return await signTx(
        hre,
        "allowed",
        txFile({
          type: "0x4",
          chainId: toHex(LOCAL_CHAIN_ID),
          nonce: "0x0",
          gas: "0x186a0",
          maxFeePerGas: "0x77359400",
          maxPriorityFeePerGas: "0x1",
          to: RECIPIENT,
          value: "0x0",
          authorizationList: [
            {
              chainId: toHex(LOCAL_CHAIN_ID),
              address: DELEGATE,
              nonce: "0x0",
              yParity: toHex(authorization.yParity ?? 0),
              r: authorization.r,
              s: authorization.s,
            },
          ],
        }),
        "eip7702",
        address,
      );
    },
  },
  {
    name: 'kms sign-tx type 2 with transactionSigning "digest": a NO_OP digest through sign_raw_payload',
    run: async ({ hre, address, txFile }) =>
      await signTx(hre, "digest", txFile(eip1559Tx(1)), "eip1559", address),
  },
  {
    name: "the denied account fails with turnkey.service.forbidden, naming SIGN_TRANSACTION_V2",
    run: async ({ hre, settings, txFile }) => {
      const error = await failure(
        task(hre, ["kms", "sign-tx"], { key: "denied", tx: txFile(eip1559Tx(0)) }),
      );
      const text = textOf(error);
      assert.ok(text.includes(FORBIDDEN_TEXT), `not turnkey.service.forbidden: ${text}`);
      assert.ok(text.includes("ACTIVITY_TYPE_SIGN_TRANSACTION_V2"));
      const last = settings.recorder.exchanges.findLast(
        (exchange) => exchange.path === "sign_transaction",
      );
      return `HTTP ${String(last?.status)}${last?.code === undefined ? "" : ` ${last.code}`}`;
    },
  },
  {
    name: "the consensus account fails with turnkey.activity.approval-needed (a random digest)",
    run: async ({ hre }) => {
      const error = await failure(
        task(hre, ["kms", "sign"], {
          key: "consensus",
          message: toHex(randomBytes(32)),
          data: false,
          fromFile: false,
          noHash: true,
          allowCrossChain: false,
        }),
      );
      const text = textOf(error);
      const id = APPROVAL_NEEDED.exec(text)?.[1];
      assert.ok(id !== undefined, `not turnkey.activity.approval-needed with a UUID: ${text}`);
      // The first block only: enough to find the activity in the dashboard, while the logs keep no
      // whole activity id.
      return `reject activity ${id.slice(0, 8)}-… in the Turnkey dashboard (Activities, pending)`;
    },
  },
  {
    name: "one EIP-1559 self-send of 0 wei on Sepolia (optional)",
    run: async ({ hre, settings, address }) => {
      if (settings.sepoliaUrl === undefined) {
        return { skip: "not asked for: dispatch with sepolia-send to run it" };
      }
      return await sepoliaSend(hre, address);
    },
  },
];

/** A type 2 transaction on the local chain, never sent. */
function eip1559Tx(nonce: number): Record<string, unknown> {
  return {
    type: "0x2",
    chainId: toHex(LOCAL_CHAIN_ID),
    nonce: toHex(nonce),
    gas: "0x5208",
    maxFeePerGas: "0x77359400",
    maxPriorityFeePerGas: "0x1",
    to: RECIPIENT,
    value: "0x0",
  };
}

/**
 * Runs a `kms` task with its text output dropped: it would put signatures and signed
 * transactions in the log. Under `node --test` the test runner's own events go to standard output
 * as bytes, not text, and pass through.
 */
async function task(
  hre: HardhatRuntimeEnvironment,
  name: string[],
  args: Record<string, unknown>,
): Promise<unknown> {
  const original = process.stdout.write.bind(process.stdout);
  const write = mock.method(process.stdout, "write", (chunk: unknown) =>
    chunk instanceof Uint8Array ? original(chunk) : true,
  );
  const writeError = mock.method(process.stderr, "write", () => true);
  try {
    const result: unknown = await hre.tasks.getTask(name).run(args);
    return result;
  } finally {
    write.mock.restore();
    writeError.mock.restore();
  }
}

/** The error a promise rejects with; fails if it resolves. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  const outcome = await promise.then(
    () => ({ signed: true, error: undefined }),
    (error: unknown) => ({ signed: false, error }),
  );
  assert.ok(!outcome.signed, "the request was signed: the account's policy let it through");
  return outcome.error;
}

/** Signs a transaction file with `kms sign-tx` and checks the raw transaction it prints. */
async function signTx(
  hre: HardhatRuntimeEnvironment,
  key: string,
  file: string,
  type: string,
  address: Address,
): Promise<undefined> {
  const signed = await task(hre, ["kms", "sign-tx"], { key, tx: file });
  const raw = hexOf(field(signed, "raw"), "the signed transaction");
  const parsed = parseTransaction(raw);
  assert.equal(parsed.type, type);
  assert.equal(parsed.chainId, LOCAL_CHAIN_ID);
  if (parsed.type === "legacy") {
    assert.equal(
      legacyV(raw, LOCAL_CHAIN_ID),
      "eip155",
      "the legacy transaction's v is not EIP-155",
    );
  }
  const { r, s, yParity } = parsed;
  assert.ok(r !== undefined && s !== undefined && (yParity === 0 || yParity === 1));
  // The unsigned form: viem serializes a legacy transaction without its own signature fields (the
  // EIP-155 preimage), and a typed one without them once they are cleared.
  const unsigned =
    parsed.type === "legacy"
      ? serializeTransaction(parsed)
      : serializeTransaction({ ...parsed, r: undefined, s: undefined, yParity: undefined });
  assert.equal(
    await recoverAddress({ hash: keccak256(unsigned), signature: { r, s, yParity } }),
    address,
  );
  return undefined;
}

/**
 * Asks Turnkey to add a fresh API key to the API user itself, with `timestampMs` set to `at`.
 * The guide's deny policy must refuse it. If Turnkey accepts it, the key is deleted at once and
 * the check fails loudly; neither key is ever printed.
 *
 * @returns The error the request failed with.
 */
async function credentialCheck(
  settings: SmokeSettings,
  at: number,
  now: () => number,
): Promise<unknown> {
  const transport: Transport = { ...defaultTransport(), ...settings.transport };
  const privateKey = process.env[settings.variables.apiPrivateKey]?.trim() ?? "";
  const organizationId = process.env[settings.variables.organizationId]?.trim() ?? "";
  const apiKey = apiKeyFromPrivateKey(privateKey);
  assert.ok(apiKey !== undefined, `${settings.variables.apiPrivateKey} is not a P-256 private key`);
  const client = new TurnkeyClient(transport, apiKey, "credential check");
  const whoami = await client.send(
    WHOAMI_PATH,
    JSON.stringify({ organizationId }),
    context("whoami"),
  );
  const userId = field(whoami.body, "userId");
  assert.ok(typeof userId === "string" && userId !== "", "whoami returned no userId");

  const fresh = createECDH("prime256v1");
  fresh.generateKeys();
  const body = JSON.stringify({
    type: "ACTIVITY_TYPE_CREATE_API_KEYS_V2",
    timestampMs: String(at),
    organizationId,
    parameters: {
      userId,
      apiKeys: [
        {
          apiKeyName: "hardhat-kms-smoke-deny-check",
          publicKey: fresh.getPublicKey("hex", "compressed"),
          curveType: "API_KEY_CURVE_P256",
          expirationSeconds: "900",
        },
      ],
    },
  });
  let answer: Answer;
  try {
    answer = await client.send(CREATE_API_KEYS_PATH, body, context("create api keys"));
  } catch (error) {
    return error;
  }
  // Turnkey accepted it: the deny policy did not hold.
  const outcome = await removeCreatedKey(client, answer, organizationId, userId, now);
  throw new Error(
    `CREDENTIAL DENY POLICY DID NOT HOLD: Turnkey let the API user add an API key to itself. ${outcome} ` +
      "Fix the deny policy of the Turnkey setup guide (step 4) before any other run, and list the user's API keys in the dashboard.",
  );
}

/** The context of one credential-check request. */
function context(operation: string): RequestContext {
  return {
    signal: AbortSignal.timeout(60_000),
    operation,
    requestId: "smoke",
    forbiddenHint: "",
  };
}

/** Deletes the API keys a create_api_keys activity added, and says how that went. */
async function removeCreatedKey(
  client: TurnkeyClient,
  answer: Answer,
  organizationId: string,
  userId: string,
  now: () => number,
): Promise<string> {
  const activity = field(answer.body, "activity");
  const status = field(activity, "status");
  if (status !== "ACTIVITY_STATUS_COMPLETED") {
    return `The activity is ${String(status)}, not completed: reject it in the Turnkey dashboard now.`;
  }
  const ids = field(field(field(activity, "result"), "createApiKeysResult"), "apiKeyIds");
  if (!Array.isArray(ids) || ids.length === 0) {
    return "Its result names no key id: delete the key named hardhat-kms-smoke-deny-check in the Turnkey dashboard now.";
  }
  try {
    const deleted = await client.send(
      DELETE_API_KEYS_PATH,
      JSON.stringify({
        type: "ACTIVITY_TYPE_DELETE_API_KEYS",
        timestampMs: String(now()),
        organizationId,
        parameters: { userId, apiKeyIds: ids },
      }),
      context("delete api keys"),
    );
    const deletedStatus = field(field(deleted.body, "activity"), "status");
    return deletedStatus === "ACTIVITY_STATUS_COMPLETED"
      ? "The test deleted the key it added."
      : `Deleting it ended as ${String(deletedStatus)}: delete the key named hardhat-kms-smoke-deny-check in the Turnkey dashboard now.`;
  } catch {
    return "Deleting it failed: delete the key named hardhat-kms-smoke-deny-check in the Turnkey dashboard now.";
  }
}

/** Sends one EIP-1559 transaction of 0 wei from the account to itself on Sepolia. */
async function sepoliaSend(
  hre: HardhatRuntimeEnvironment,
  address: Address,
): Promise<string | { skip: string }> {
  const { provider } = await hre.network.create("sepolia");
  const block = await provider.request({
    method: "eth_getBlockByNumber",
    params: ["latest", false],
  });
  const baseFee = BigInt(hexOf(field(block, "baseFeePerGas"), "baseFeePerGas"));
  const maxFee = baseFee * 2n + 1_000_000_000n;
  if (maxFee > MAX_SEPOLIA_FEE) {
    return { skip: "Sepolia's fees are above the 20 gwei cap: nothing was sent" };
  }
  const balance = BigInt(
    hexOf(
      await provider.request({ method: "eth_getBalance", params: [address, "latest"] }),
      "the balance",
    ),
  );
  if (balance < maxFee * 21_000n) {
    return { skip: "the allowed account holds too little Sepolia ETH: nothing was sent" };
  }
  const hash = hexOf(
    await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: address, to: address, value: "0x0", type: "0x2" }],
    }),
    "the transaction hash",
  );
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  for (;;) {
    const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (receipt !== null) {
      assert.equal(field(receipt, "status"), "0x1", "the Sepolia transaction reverted");
      assert.equal(field(receipt, "type"), "0x2");
      assert.equal(getAddress(String(field(receipt, "from"))), address);
      return "mined with status 1";
    }
    assert.ok(Date.now() < deadline, "no receipt within 300 seconds");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
