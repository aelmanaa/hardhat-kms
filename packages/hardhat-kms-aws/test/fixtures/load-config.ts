// Loads hardhat-kms-aws and resolves a config with keys of every first-party provider, as
// `hardhat` would, and optionally creates one key's adapter. A test runs this in a child process
// and checks which modules it imported.
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsAws from "../../src/index.ts";

const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatKmsAws],
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

// kms verify takes a message and a signature as well; these parse, so the task reaches the key.
const VERIFY_ARGUMENTS = {
  message: "0x5417aa2a18a44da0675524453ff108c545382f0d7e26605c56bba47c21b5e979",
  signature:
    "0x9c73dd4937a37eecab3abb54b74b6ec8e500080431d36afedb1726624587ee6710296e10c1194dded7376f13ff03ef6c9e797eb86bae16c20c57776fc69344271c",
};

// HHKMS_FIXTURE_KEY names a key whose adapter to create, through the kms hook chain.
const keyName = process.env.HHKMS_FIXTURE_KEY ?? "";
if (keyName !== "") {
  const key = hre.config.kms.keys[keyName];
  if (key === undefined) {
    throw new Error(`missing key ${keyName}`);
  }
  // HHKMS_FIXTURE_TASK runs that kms task on the key instead, as `hardhat kms <task> <key>` does.
  const taskName = process.env.HHKMS_FIXTURE_TASK ?? "";
  try {
    if (taskName === "") {
      const adapter = await hre.hooks.runHandlerChain(
        "kms",
        "createKeyAdapter",
        [key],
        async () => await Promise.reject(new Error("unclaimed")),
      );
      await adapter.close?.();
    } else {
      await hre.tasks
        .getTask(["kms", taskName])
        .run(taskName === "verify" ? { key: keyName, ...VERIFY_ARGUMENTS } : { key: keyName });
    }
  } catch {
    // Keys of other providers reach the end of the chain; only the imports matter here.
  }
}

process.stdout.write(`${hre.config.networks.sepolia?.kmsAccounts.length ?? 0} accounts\n`);
