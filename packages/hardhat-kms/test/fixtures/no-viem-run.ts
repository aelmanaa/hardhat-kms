// Runs every `kms` task, a send and a signature through the provider, then getAccount, in a
// process where viem cannot be resolved (see no-viem/hooks.mjs). Prints one `RESULT ` line of
// JSON for test/integration/no-viem.test.ts.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKms from "../../src/index.ts";
import { fakeAdapter } from "../helpers/fake-adapter.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const ADDRESS = HARDHAT_ACCOUNT_0.address;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const log = process.env.HARDHAT_KMS_NO_VIEM_LOG ?? "";

const hre = await createHardhatRuntimeEnvironment(
  {
    plugins: [hardhatKms],
    kms: { keys: { deployer: vaultKey("deployer") }, simulatedBalance: 10n ** 18n },
    networks: {
      local: { type: "edr-simulated", hardfork: "prague", accounts: [], kmsAccounts: ["deployer"] },
    },
  },
  { network: "local" },
);
hre.hooks.registerHandlers("kms", {
  createKeyAdapter: async (context, key, next) =>
    key.name === "deployer"
      ? fakeAdapter({ secretKey: new Uint8Array(Buffer.from(HARDHAT_ACCOUNT_0.secretKey, "hex")) })
      : await next(context, key),
});

const directory = mkdtempSync(path.join(tmpdir(), "hardhat-kms-no-viem-"));
const txFile = path.join(directory, "tx.json");
writeFileSync(txFile, JSON.stringify({ to: TO, value: "0x1" }));
const typedData = JSON.stringify({
  types: {
    EIP712Domain: [{ name: "chainId", type: "uint256" }],
    Note: [{ name: "text", type: "string" }],
  },
  primaryType: "Note",
  domain: { chainId: 31337 },
  message: { text: "hi" },
});
const sign = {
  key: "deployer",
  data: false,
  fromFile: false,
  noHash: false,
  allowCrossChain: false,
};
const tasks: [string, Record<string, unknown>][] = [
  ["accounts", { json: true, showIds: false }],
  ["address", { key: "deployer" }],
  ["public-key", { key: "deployer" }],
  ["sign", { ...sign, message: "hello" }],
  ["sign", { ...sign, message: typedData, data: true }],
  ["sign", { ...sign, message: `0x${"ab".repeat(32)}`, noHash: true }],
  [
    "verify",
    {
      message: "hello",
      signature: "",
      address: ADDRESS,
      data: false,
      fromFile: false,
    },
  ],
  ["sign-tx", { key: "deployer", tx: txFile }],
  ["sign-auth", { key: "deployer", delegate: TO, selfBroadcast: false, force: false }],
];

const ran: string[] = [];
let signature = "";
try {
  for (const [name, args] of tasks) {
    const taskArgs = name === "verify" ? { ...args, signature } : args;
    const result: unknown = await hre.tasks.getTask(["kms", name]).run(taskArgs);
    if (name === "sign" && signature === "" && typeof result === "string") {
      signature = result;
    }
    ran.push(name);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const connection = await hre.network.create();
const hash: unknown = await connection.provider.request({
  method: "eth_sendTransaction",
  params: [{ from: ADDRESS, to: TO, value: "0x1" }],
});
const signed: unknown = await connection.provider.request({
  method: "personal_sign",
  params: ["0x68656c6c6f", ADDRESS],
});

if (log !== "") {
  appendFileSync(log, "getAccount\n");
}
let getAccountError = "";
try {
  await connection.kms.getAccount(ADDRESS);
} catch (error) {
  getAccountError = error instanceof Error ? error.message : String(error);
}
await connection.close();

process.stdout.write(
  `RESULT ${JSON.stringify({ ran, hash: typeof hash, signed: signed === signature, getAccountError })}\n`,
);
