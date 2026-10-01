// Signs once through a network connection and returns without closing anything, as a script run
// with `hardhat run` does. The test that runs it checks that the process exits on its own.
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsGcp from "../../src/index.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { KEY_VERSION_NAME } from "../helpers/fake-gcp-kms.ts";
import { localSdk } from "../helpers/kms-server.ts";

const port = Number(process.env.HHKMS_FIXTURE_PORT ?? "");
const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatKmsGcp],
  kms: { keys: { deployer: { provider: "gcp", keyVersionName: KEY_VERSION_NAME } } },
  networks: { remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["deployer"] } },
});
// The plugin's own handler and the real SDK, pointed at the test's local server.
hre.hooks.registerHandlers(
  "kms",
  kmsHandlers(undefined, async () => localSdk(port)),
);
const { provider } = await hre.network.create("remote");
const accounts = await provider.request({ method: "eth_accounts" });
const address: unknown = Array.isArray(accounts) ? accounts[0] : undefined;
if (typeof address !== "string") {
  throw new Error("no KMS account");
}
await provider.request({ method: "personal_sign", params: ["0x00", address] });
process.stdout.write("signed\n");
