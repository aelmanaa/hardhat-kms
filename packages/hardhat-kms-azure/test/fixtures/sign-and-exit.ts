// Signs once through a network connection and returns without closing anything, as a script run
// with `hardhat run` does. The test that runs it checks that the process exits on its own. It uses
// the real Azure SDK, whose requests an in-process Key Vault answers.
import * as keyVault from "@azure/keyvault-keys";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsAzure from "../../src/index.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { KEY_NAME, KEY_VERSION, VAULT_URL } from "../helpers/fake-key-vault.ts";
import { keyVaultHttp, staticCredential } from "../helpers/key-vault-http.ts";
import { loaderFor } from "../helpers/plugin-adapter.ts";

const vault = keyVaultHttp({
  secretKey: new Uint8Array(32).fill(1),
  vaultUrl: VAULT_URL,
  keyName: KEY_NAME,
  currentVersion: KEY_VERSION,
});
const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatKmsAzure],
  kms: { keys: { deployer: { provider: "azure", keyId: `${VAULT_URL}/keys/${KEY_NAME}` } } },
  networks: { remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["deployer"] } },
});
hre.hooks.registerHandlers(
  "kms",
  kmsHandlers(undefined, loaderFor(keyVault, staticCredential(), { httpClient: vault.httpClient })),
);
const { provider } = await hre.network.create("remote");
const accounts = await provider.request({ method: "eth_accounts" });
const address: unknown = Array.isArray(accounts) ? accounts[0] : undefined;
if (typeof address !== "string") {
  throw new Error("no KMS account");
}
await provider.request({ method: "personal_sign", params: ["0x00", address] });
process.stdout.write("signed\n");
