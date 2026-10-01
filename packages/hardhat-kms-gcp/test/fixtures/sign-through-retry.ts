// Signs once through a network connection while Cloud KMS is unavailable for the first two calls,
// with a fake SDK that holds no socket or timer of its own. The adapter's pause before each retry
// is then the only thing the process waits on; the test that runs this checks that the process
// stays alive through it and prints the signature.
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsGcp from "../../src/index.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { fakeGcpKmsSdk, googleError, KEY_VERSION_NAME } from "../helpers/fake-gcp-kms.ts";

const secretKey = new Uint8Array(32).fill(1);
const fake = fakeGcpKmsSdk({
  secretKey,
  failFirst: { method: "asymmetricSign", error: googleError(14, "unavailable"), times: 2 },
});
const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatKmsGcp],
  kms: { keys: { deployer: { provider: "gcp", keyVersionName: KEY_VERSION_NAME } } },
  networks: { remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["deployer"] } },
});
hre.hooks.registerHandlers(
  "kms",
  kmsHandlers(undefined, async () => fake.sdk),
);
const { provider } = await hre.network.create("remote");
const accounts = await provider.request({ method: "eth_accounts" });
const address: unknown = Array.isArray(accounts) ? accounts[0] : undefined;
if (typeof address !== "string") {
  throw new Error("no KMS account");
}
const signature = await provider.request({ method: "personal_sign", params: ["0x00", address] });
process.stdout.write(`signature ${String(signature)} after ${fake.calls.length} calls\n`);
