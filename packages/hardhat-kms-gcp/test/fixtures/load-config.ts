// Loads hardhat-kms-gcp and resolves a config with keys of every first-party provider, as
// `hardhat` would, and optionally creates one key's adapter. A test runs this in a child process
// and checks which modules it imported.
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsGcp from "../../src/index.ts";

const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatKmsGcp],
  kms: {
    keys: {
      aws: { provider: "aws", keyId: "alias/deployer", region: "eu-west-1" },
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

// HHKMS_FIXTURE_KEY names a key whose adapter to create, through the kms hook chain.
const keyName = process.env.HHKMS_FIXTURE_KEY ?? "";
if (keyName !== "") {
  const key = hre.config.kms.keys[keyName];
  if (key === undefined) {
    throw new Error(`missing key ${keyName}`);
  }
  try {
    const adapter = await hre.hooks.runHandlerChain(
      "kms",
      "createKeyAdapter",
      [key],
      async () => await Promise.reject(new Error("unclaimed")),
    );
    await adapter.close?.();
  } catch {
    // Keys of other providers reach the end of the chain; only the imports matter here.
  }
}

process.stdout.write(`${hre.config.networks.sepolia?.kmsAccounts.length ?? 0} accounts\n`);
