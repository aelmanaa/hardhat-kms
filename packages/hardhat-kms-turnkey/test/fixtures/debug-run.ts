// Signs through the real adapter against the Turnkey stub, with planted values in every place the
// plugin reads or receives one, so the debug test can check that none reaches the output. Run with
// DEBUG=hardhat:kms:*. Prints each caught error's message on standard output, and writes the
// stamps the stub received to STAMPS_FILE.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsTurnkey from "../../src/index.ts";
import { createTurnkeyKeyAdapter } from "../../src/internal/adapter.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { ACCOUNT, ACCOUNT_SECRET_KEY, API_PUBLIC_KEY } from "../helpers/keys.ts";
import { TurnkeyStub, turnkeyError } from "../helpers/turnkey-stub.ts";

const organizationId = process.env.HHKMS_DEBUG_TURNKEY_ORGANIZATION ?? "";
const activityId = process.env.HHKMS_DEBUG_ACTIVITY_ID ?? "";
const turnkeyMessage = process.env.HHKMS_DEBUG_TURNKEY_MESSAGE ?? "";
const version = String(
  Reflect.get(
    Object(createRequire(import.meta.url)("@hardhat-kms/turnkey/package.json")),
    "version",
  ),
);

const stub = new TurnkeyStub({
  organizationId,
  apiPublicKey: API_PUBLIC_KEY,
  secretKey: ACCOUNT_SECRET_KEY,
});
const baseUrl = await stub.listen();

const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatKmsTurnkey],
  kms: {
    keys: {
      deployer: {
        provider: "turnkey",
        organizationId: configVariable("HHKMS_DEBUG_TURNKEY_ORGANIZATION"),
        address: ACCOUNT.address,
        apiPrivateKey: configVariable("HHKMS_DEBUG_TURNKEY_API_PRIVATE_KEY"),
        apiPublicKey: configVariable("HHKMS_DEBUG_TURNKEY_API_PUBLIC_KEY"),
      },
    },
    simulatedBalance: 10n ** 18n,
  },
  networks: { local: { type: "edr-simulated", accounts: [], kmsAccounts: ["deployer"] } },
});
hre.hooks.registerHandlers(
  "kms",
  kmsHandlers(
    version,
    async () => async (key) => await createTurnkeyKeyAdapter(key, { transport: { baseUrl } }),
  ),
);
const { provider } = await hre.network.create("local");

const activity = (status: string, extra: Record<string, unknown> = {}) => ({
  status: 200,
  json: {
    activity: {
      id: activityId,
      organizationId,
      status,
      type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
      ...extra,
    },
  },
});

/** One request through the RPC account; the answers queued before it shape what the stub says. */
async function personalSign(name: string): Promise<void> {
  try {
    await provider.request({ method: "personal_sign", params: ["0x68656c6c6f", ACCOUNT.address] });
    process.stdout.write(`${name}: signed\n`);
  } catch (error) {
    process.stdout.write(`${name}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

await personalSign("completed");
try {
  await provider.request({
    method: "eth_sendTransaction",
    params: [{ from: ACCOUNT.address, to: ACCOUNT.address, value: "0x1" }],
  });
  process.stdout.write("transaction: sent\n");
} catch (error) {
  process.stdout.write(`transaction: ${error instanceof Error ? error.message : String(error)}\n`);
}
stub.firstStatus = "ACTIVITY_STATUS_PENDING";
stub.pendingPolls = 1;
await personalSign("pending");
stub.firstStatus = "ACTIVITY_STATUS_COMPLETED";
stub.answer(activity("ACTIVITY_STATUS_CONSENSUS_NEEDED"));
await personalSign("consensus");
stub.answer(
  activity("ACTIVITY_STATUS_FAILED", {
    failure: { code: 7, message: turnkeyMessage, details: [{ turnkeyErrorCode: "POLICY_DENIED" }] },
  }),
);
await personalSign("failed");
stub.answer(turnkeyError(403, "REQUEST_NOT_AUTHORIZED", turnkeyMessage));
await personalSign("forbidden");
stub.answer(
  turnkeyError(429, "RATE_LIMIT_EXCEEDED", turnkeyMessage),
  turnkeyError(500, undefined, turnkeyMessage),
);
await personalSign("retried");
stub.answer(turnkeyError(401, "UNAUTHENTICATED", turnkeyMessage));
await personalSign("unauthenticated");
stub.answer(
  activity("ACTIVITY_STATUS_COMPLETED", { organizationId: "00000000-0000-0000-0000-000000000000" }),
);
await personalSign("mismatch");

for (const showIds of [false, true]) {
  await hre.tasks
    .getTask(["kms", "accounts"])
    .run({ json: true, showIds, balances: false, checkSign: true });
}

await stub.close();
writeFileSync(
  process.env.STAMPS_FILE ?? "",
  JSON.stringify(stub.requests.map((request) => request.stamp ?? "")),
);
