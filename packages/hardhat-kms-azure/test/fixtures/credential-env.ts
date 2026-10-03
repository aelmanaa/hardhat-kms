// Runs `kms accounts`, `kms history` or the adapter creation of one Azure key with the real
// @azure/identity and the plugin's own hook handlers, in the environment the test gives this
// process. It prints what the task printed and the message of any error, so the test can check
// that a refused sign-in fails with the catalogued error and that no planted value is printed.
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsAzure from "../../src/index.ts";

const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatKmsAzure],
  kms: {
    keys: {
      deployer: {
        provider: "azure",
        keyId: "https://v.vault.azure.net/keys/k/0123456789abcdef0123456789abcdef",
      },
    },
    audit: { azure: { workspaceId: "00000000-0000-0000-0000-000000000001" } },
  },
});

const task = process.env.HHKMS_FIXTURE_TASK ?? "";
try {
  if (task === "accounts") {
    await hre.tasks.getTask(["kms", "accounts"]).run({ json: false, showIds: false });
  } else if (task === "history") {
    await hre.tasks.getTask(["kms", "history"]).run({
      key: "deployer",
      since: "2026-10-01T00:00:00Z",
      until: "2026-10-02T00:00:00Z",
      limit: 10,
      json: false,
      showIds: false,
    });
  } else {
    const key = hre.config.kms.keys.deployer;
    if (key === undefined) {
      throw new Error("missing key deployer");
    }
    // Creating the adapter builds the credential chain and sends no request.
    const adapter = await hre.hooks.runHandlerChain(
      "kms",
      "createKeyAdapter",
      [key],
      async () => await Promise.reject(new Error("unclaimed")),
    );
    await adapter.close?.();
    process.stdout.write("adapter created\n");
  }
} catch (error) {
  process.stdout.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
}
