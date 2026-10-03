// Loads @hardhat-kms/azure and resolves a config with keys of every first-party provider, as
// `hardhat` would, and optionally creates one key's adapter or runs a `kms` task. A test runs
// this in a child process and checks which modules it imported.
import { fileURLToPath } from "node:url";

import type { KmsKeyUserConfig } from "hardhat-kms/types";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { isResult } from "hardhat/utils/result";

import hardhatKmsAzure from "../../src/index.ts";

const keys: Record<string, KmsKeyUserConfig> = {
  aws: { provider: "aws", keyId: "alias/deployer", region: "eu-west-1" },
  gcp: {
    provider: "gcp",
    keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
  },
  azure: { provider: "azure", keyId: "https://v.vault.azure.net/keys/k" },
};
// HHKMS_FIXTURE_SKIP leaves one key out, so that `kms accounts` sees only the other providers'.
Reflect.deleteProperty(keys, process.env.HHKMS_FIXTURE_SKIP ?? "");

const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatKmsAzure],
  kms: { keys },
  networks: {
    sepolia: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: Object.keys(keys) },
  },
});

// kms verify takes a message and a signature as well; these parse, so the task reaches the key.
const VERIFY_ARGUMENTS = {
  message: "0x5417aa2a18a44da0675524453ff108c545382f0d7e26605c56bba47c21b5e979",
  signature:
    "0x9c73dd4937a37eecab3abb54b74b6ec8e500080431d36afedb1726624587ee6710296e10c1194dded7376f13ff03ef6c9e797eb86bae16c20c57776fc69344271c",
};

// HHKMS_FIXTURE_TASK=accounts runs `kms accounts`, which takes no key and tries every key.
if (process.env.HHKMS_FIXTURE_TASK === "accounts") {
  const result = await hre.tasks.getTask(["kms", "accounts"]).run({ json: false, showIds: false });
  process.stdout.write(
    `accounts task ${isResult(result) && result.success ? "passed" : "failed"}\n`,
  );
}

// HHKMS_FIXTURE_KEY names a key whose adapter to create, through the kms hook chain. Creating an
// Azure adapter builds the credential chain but sends no request.
const keyName = process.env.HHKMS_FIXTURE_KEY ?? "";
if (keyName !== "") {
  const key = hre.config.kms.keys[keyName];
  if (key === undefined) {
    throw new Error(`missing key ${keyName}`);
  }
  // HHKMS_FIXTURE_TASK runs that kms task on the key instead, as `hardhat kms <task> <key>` does.
  const taskName = process.env.HHKMS_FIXTURE_TASK ?? "";
  // kms sign-tx also takes a transaction file; the test sets HARDHAT_NETWORK for its --network.
  // kms sign-auth also needs a delegate, a chain and a nonce, so that it reaches the KMS.
  const signTx = taskName === "sign-tx";
  const taskArgs = signTx
    ? { key: keyName, tx: fileURLToPath(new URL("tx.json", import.meta.url)) }
    : taskName === "verify"
      ? { key: keyName, ...VERIFY_ARGUMENTS }
      : taskName === "sign-auth"
        ? { key: keyName, delegate: `0x${"11".repeat(20)}`, chain: "1", nonce: "0" }
        : { key: keyName };
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
      await hre.tasks.getTask(["kms", taskName]).run(taskArgs);
    }
  } catch (error) {
    // Keys of other providers reach the end of the chain; only the imports matter here.
    if (signTx && error instanceof Error && error.message.includes("create adapter")) {
      // sign-tx read its file and got as far as the key before it failed.
      process.stdout.write("sign-tx reached the key\n");
    }
  }
}

process.stdout.write(`${hre.config.networks.sepolia?.kmsAccounts.length ?? 0} accounts\n`);
