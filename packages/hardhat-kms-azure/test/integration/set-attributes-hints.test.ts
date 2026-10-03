import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";

import type { AzureKmsKeyUserConfig } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsAzure from "../../src/index.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { fakeKeyVaultSdk, type FakeKeyVaultOptions } from "../helpers/fake-key-vault.ts";
import { loaderFor } from "../helpers/plugin-adapter.ts";

const ownVersion = String(
  Reflect.get(Object(createRequire(import.meta.url)("@hardhat-kms/azure/package.json")), "version"),
);

// Distinct values, so any of them in a message is a leak.
const VAULT = "hiddenvault";
const VAULT_URL = `https://${VAULT}.vault.azure.net`;
const NAME = "hidden-key-name";
const VERSION = "5ec7e75ec7e75ec7e75ec7e75ec7e75e";
const RETURNED = "aaaabbbbccccddddeeeeffff00001111";

const VARIABLES = {
  HHKMS_HINT_KEY_ID: `${VAULT_URL}/keys/${NAME}/${VERSION}`,
  HHKMS_HINT_UNVERSIONED_KEY_ID: `${VAULT_URL}/keys/${NAME}`,
  HHKMS_HINT_VAULT_URL: VAULT_URL,
  HHKMS_HINT_KEY_NAME: NAME,
  HHKMS_HINT_KEY_VERSION: VERSION,
  "HHKMS_HINT/keys/ODD": `${VAULT_URL}/keys/${NAME}/${VERSION}`,
};
for (const [name, value] of Object.entries(VARIABLES)) {
  process.env[name] = value;
}
after(() => {
  for (const name of Object.keys(VARIABLES)) {
    Reflect.deleteProperty(process.env, name);
  }
});

/** The message of the error that listing the key's account gives, for a key in this state. */
async function hintFor(
  key: AzureKmsKeyUserConfig,
  options: Partial<FakeKeyVaultOptions>,
): Promise<string> {
  const fake = fakeKeyVaultSdk({
    secretKey: new Uint8Array(32).fill(1),
    currentVersion: RETURNED,
    ...options,
  });
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKmsAzure],
    kms: { keys: { deployer: key } },
    networks: { remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["deployer"] } },
  });
  const credential = { getToken: async () => await Promise.resolve(null) };
  hre.hooks.registerHandlers("kms", kmsHandlers(ownVersion, loaderFor(fake.sdk, credential)));
  const connection = await hre.network.create("remote");
  let message = "";
  await assert.rejects(connection.provider.request({ method: "eth_accounts" }), (error) => {
    assert.ok(error instanceof Error, String(error));
    message = error.message;
    return true;
  });
  await connection.close();
  return message;
}

describe("set-attributes hints for keys configured with configuration variables", () => {
  const cases: Array<[string, AzureKmsKeyUserConfig, string, string[]]> = [
    [
      "the whole key id",
      { provider: "azure", keyId: configVariable("HHKMS_HINT_KEY_ID") },
      "--vault-name <vault-name> --name <key-name> --version <version>",
      [VAULT, NAME, VERSION],
    ],
    [
      "the whole key id, without a version",
      { provider: "azure", keyId: configVariable("HHKMS_HINT_UNVERSIONED_KEY_ID") },
      `--vault-name <vault-name> --name <key-name> --version ${RETURNED}`,
      [VAULT, NAME],
    ],
    [
      "the whole key id, from a variable whose name holds /keys/",
      { provider: "azure", keyId: configVariable("HHKMS_HINT/keys/ODD") },
      "--vault-name <vault-name> --name <key-name> --version <version>",
      [VAULT, NAME, VERSION],
    ],
    [
      "the vault URL",
      {
        provider: "azure",
        vaultUrl: configVariable("HHKMS_HINT_VAULT_URL"),
        keyName: NAME,
        keyVersion: VERSION,
      },
      `--vault-name <vault-name> --name ${NAME} --version ${VERSION}`,
      [VAULT],
    ],
    [
      "the key name",
      {
        provider: "azure",
        vaultUrl: VAULT_URL,
        keyName: configVariable("HHKMS_HINT_KEY_NAME"),
        keyVersion: VERSION,
      },
      `--vault-name ${VAULT} --name <key-name> --version ${VERSION}`,
      [NAME],
    ],
    [
      "the key version",
      {
        provider: "azure",
        vaultUrl: VAULT_URL,
        keyName: NAME,
        keyVersion: configVariable("HHKMS_HINT_KEY_VERSION"),
      },
      `--vault-name ${VAULT} --name ${NAME} --version <version>`,
      [VERSION],
    ],
  ];
  for (const [name, key, target, hidden] of cases) {
    it(`hides ${name}`, async () => {
      const errors: Array<[Partial<FakeKeyVaultOptions>, string]> = [
        [{ enabled: false }, "--enabled true`"],
        [{ keyOperations: ["verify"] }, "--ops sign verify`"],
      ];
      for (const [options, tail] of errors) {
        const message = await hintFor(key, options);
        assert.ok(message.includes(`az keyvault key set-attributes ${target} ${tail}`), message);
        for (const value of hidden) {
          assert.ok(!message.includes(value), `"${message}" should not include "${value}"`);
        }
      }
    });
  }
});
