// Signs once through a network connection and returns without closing anything, as a script run
// with `hardhat run` does. The test that runs it checks that the process exits on its own.
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsAws from "../../src/index.ts";

const endpoint = process.env.HHKMS_FIXTURE_ENDPOINT ?? "";
const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatKmsAws],
  kms: {
    keys: { deployer: { provider: "aws", keyId: "alias/deployer", region: "eu-west-1", endpoint } },
  },
  networks: { remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["deployer"] } },
});
const { provider } = await hre.network.create("remote");
const accounts = await provider.request({ method: "eth_accounts" });
const address: unknown = Array.isArray(accounts) ? accounts[0] : undefined;
if (typeof address !== "string") {
  throw new Error("no KMS account");
}
await provider.request({ method: "personal_sign", params: ["0x00", address] });
process.stdout.write("signed\n");
