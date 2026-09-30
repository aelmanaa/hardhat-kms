// Loads the plugin and resolves a config that uses every built-in provider, as `hardhat` would.
// A test runs this in a child process and checks which modules it imported.
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKms from "../../src/index.ts";

const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatKms],
  kms: {
    keys: {
      aws: { provider: "aws", keyId: configVariable("HHKMS_FIXTURE_AWS") },
      gcp: {
        provider: "gcp",
        keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
      },
      azure: { provider: "azure", keyId: "https://v.vault.azure.net/keys/k" },
    },
  },
  networks: {
    sepolia: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["aws", "gcp", "azure"] },
  },
});

process.stdout.write(`${hre.config.networks.sepolia?.kmsAccounts.length ?? 0} accounts\n`);
