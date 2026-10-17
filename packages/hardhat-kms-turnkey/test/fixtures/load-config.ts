// Loads @hardhat-kms/turnkey and resolves a config with a Turnkey key and a key of another
// provider, as `hardhat` would, and optionally creates one key's adapter through the kms hook
// chain. A test runs this in a child process and checks which modules it imported.
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsTurnkey from "../../src/index.ts";

const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatKmsTurnkey],
  kms: {
    keys: {
      turnkey: {
        provider: "turnkey",
        organizationId: configVariable("HHKMS_FIXTURE_ORGANIZATION"),
        address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        apiPrivateKey: configVariable("HHKMS_FIXTURE_API_PRIVATE_KEY"),
      },
      gcp: {
        provider: "gcp",
        keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
      },
    },
  },
  networks: {
    sepolia: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["turnkey", "gcp"] },
  },
});
process.stdout.write(`${Object.keys(hre.config.kms.keys).length} keys\n`);

// HHKMS_FIXTURE_KEY names a key whose adapter to create. Creating a Turnkey adapter reads no
// credential and sends nothing; no plugin claims the gcp key.
const name = process.env.HHKMS_FIXTURE_KEY ?? "";
const key = hre.config.kms.keys[name];
if (key !== undefined) {
  try {
    const adapter = await hre.hooks.runHandlerChain(
      "kms",
      "createKeyAdapter",
      [key],
      async () => await Promise.reject(new Error("unclaimed")),
    );
    process.stdout.write(`created ${adapter.describe().provider}\n`);
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : "failed"}\n`);
  }
}
