// Exercises config loading, adapter creation and signing with planted secrets, so the debug test
// can check that none of them reach the debug output. Run with DEBUG=hardhat:kms:*.
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKms from "../../src/index.ts";
import { createKeyAdapter } from "../../src/internal/providers/create-adapter.ts";
import { KmsSigner } from "../../src/internal/signer/kms-signer.ts";
import type { KmsKeyUserConfig } from "../../src/types.ts";
import { fakeAdapter } from "../helpers/fake-adapter.ts";
import { HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const secretKey = new Uint8Array(Buffer.from(HARDHAT_ACCOUNT_0.secretKey, "hex"));
const keysValue: unknown = {
  aws: { provider: "aws", keyId: configVariable("HHKMS_DEBUG_AWS_KEY_ID") },
  gcp: {
    provider: "gcp",
    projectId: configVariable("HHKMS_DEBUG_GCP_PROJECT"),
    location: "l",
    keyRing: "r",
    keyName: "k",
    keyVersion: 1,
  },
  vault: { provider: "myvault", token: configVariable("HHKMS_DEBUG_VAULT_TOKEN") },
};

const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatKms],
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- includes a third-party provider
  kms: { keys: keysValue as Record<string, KmsKeyUserConfig> },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("HHKMS_DEBUG_RPC_URL"),
      kmsAccounts: ["aws", "gcp", "vault"],
    },
  },
});

let calls = 0;
hre.hooks.registerHandlers("kms", {
  createKeyAdapter: async () => {
    calls++;
    if (calls === 1) {
      // A provider whose SDK error text carries a secret.
      return fakeAdapter({ secretKey, throwError: new TypeError("HHKMS-SECRET-SDK-MESSAGE") });
    }
    // Signs with the wrong key once, so the signer retries.
    return fakeAdapter({ secretKey, wrongKeyForCalls: 1 });
  },
});

const options = { timeoutMs: 5000, displayMessage: async () => {} };
for (const name of ["aws", "gcp", "vault"]) {
  const key = hre.config.kms.keys[name];
  if (key === undefined) {
    throw new Error(`missing key ${name}`);
  }
  if (key.provider === "aws") {
    await key.keyId.get();
  } else if (key.provider === "gcp") {
    await key.keyVersionName.get();
  }
  const signer = new KmsSigner(await createKeyAdapter(hre, key), options);
  try {
    await signer.signPersonalMessage(new TextEncoder().encode("hello"));
  } catch {
    // The first adapter fails on purpose.
  }
}
