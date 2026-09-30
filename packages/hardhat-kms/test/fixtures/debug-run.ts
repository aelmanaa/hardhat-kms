// Exercises config loading, adapter creation, SDK loading and signing with planted secrets, so the
// debug test can check that none of them reach the debug output. Run with DEBUG=hardhat:kms:*.
// HHKMS_DEBUG_PROJECT names a throwaway project with a fake AWS SDK installed.
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";

import hardhatKms from "../../src/index.ts";
import { createKeyAdapter } from "../../src/internal/providers/create-adapter.ts";
import { loadSdk } from "../../src/internal/providers/sdk.ts";
import { KmsSigner } from "../../src/internal/signer/kms-signer.ts";
import type { KmsKeyAdapter, KmsKeyUserConfig } from "../../src/types.ts";
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
  azure: {
    provider: "azure",
    vaultUrl: configVariable("HHKMS_DEBUG_AZURE_VAULT"),
    keyName: "deployer",
  },
  vault: {
    provider: "myvault",
    token: configVariable("HHKMS_DEBUG_VAULT_TOKEN"),
    literal: "hhkms-secret-literal-field",
  },
  // No adapter exists for GCP yet, so this key stops at the built-in step without a network call.
  builtin: {
    provider: "gcp",
    keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/builtin/cryptoKeyVersions/1",
  },
};

const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatKms],
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- includes a third-party provider
  kms: { keys: keysValue as Record<string, KmsKeyUserConfig> },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("HHKMS_DEBUG_RPC_URL"),
      kmsAccounts: [
        "aws",
        "gcp",
        "azure",
        "vault",
        { provider: "aws", keyId: configVariable("HHKMS_DEBUG_AWS_KEY_ID") },
      ],
    },
  },
});

// Each key gets an adapter that fails or succeeds in a different way. "builtin" goes to the
// built-in provider, which is not available yet.
const behaviours: Record<string, () => KmsKeyAdapter> = {
  aws: () => fakeAdapter({ secretKey, wrongKeyForCalls: 1 }),
  gcp: () => {
    const error = new TypeError("hhkms-secret-sdk-message", {
      cause: new Error("hhkms-secret-cause"),
    });
    Object.assign(error, { $metadata: { requestId: "hhkms-secret-request-id" } });
    return fakeAdapter({ secretKey, throwError: error });
  },
  azure: () =>
    fakeAdapter({
      secretKey,
      throwError: new HardhatPluginError("hardhat-kms-test", "hhkms-secret-plugin-message"),
    }),
  vault: () => fakeAdapter({ secretKey, hang: true }),
};
hre.hooks.registerHandlers("kms", {
  createKeyAdapter: async (context, key, next) => {
    const behaviour = behaviours[key.name];
    return behaviour === undefined ? await next(context, key) : behaviour();
  },
});

// The plugin's timeout timers do not keep the process alive, and the hanging adapter holds no
// handle either, so keep the process running until every case has finished.
const keepAlive = setInterval(() => undefined, 1000);
for (const name of ["aws", "gcp", "azure", "vault", "builtin"]) {
  const key = hre.config.kms.keys[name];
  if (key === undefined) {
    throw new Error(`missing key ${name}`);
  }
  if (key.provider === "gcp") {
    await key.keyVersionName.get();
  } else if ("keyId" in key) {
    await key.keyId.get();
  }
  try {
    const adapter = await createKeyAdapter(hre, key);
    const signer = new KmsSigner(adapter, {
      timeoutMs: name === "vault" ? 50 : 5000,
      displayId: key.displayId,
      displayMessage: async () => {},
    });
    await signer.signPersonalMessage(new TextEncoder().encode("hello"));
  } catch {
    // Most keys fail on purpose.
  }
}

clearInterval(keepAlive);

// --kms, with the planted AWS key id in Foundry's variable.
process.env.AWS_KMS_KEY_ID = process.env.HHKMS_DEBUG_AWS_KEY_ID;
await createHardhatRuntimeEnvironment({ plugins: [hardhatKms] }, { kms: "aws" });

// SDK loading, from a project with a fake SDK.
await loadSdk(
  { packageName: "@aws-sdk/client-kms", range: "^3.0.0" },
  process.env.HHKMS_DEBUG_PROJECT ?? "",
  "aws",
);
