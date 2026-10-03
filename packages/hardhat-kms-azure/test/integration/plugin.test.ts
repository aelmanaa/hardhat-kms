import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import * as keyVault from "@azure/keyvault-keys";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import hardhatKms from "hardhat-kms";
import type { KmsKeyAdapter, KmsKeyConfig } from "hardhat-kms/types";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatPlugin } from "hardhat/types/plugins";

import hardhatKmsAzure from "../../src/index.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { KEY_NAME, KEY_VERSION, VAULT_URL } from "../helpers/fake-key-vault.ts";
import { keyVaultHttp, staticCredential, TENANT_ID } from "../helpers/key-vault-http.ts";
import { loaderFor, signContext } from "../helpers/plugin-adapter.ts";

const secretKey = secp256k1.utils.randomSecretKey();
const coreVersion = String(
  Reflect.get(Object(createRequire(import.meta.url)("hardhat-kms/package.json")), "version"),
);
const ownVersion = String(
  Reflect.get(Object(createRequire(import.meta.url)("@hardhat-kms/azure/package.json")), "version"),
);

async function runtime(plugins: HardhatPlugin[] = [hardhatKmsAzure]) {
  return await createHardhatRuntimeEnvironment({
    plugins,
    kms: {
      keys: {
        deployer: { provider: "azure", keyId: `${VAULT_URL}/keys/${KEY_NAME}` },
        pinned: {
          provider: "azure",
          vaultUrl: VAULT_URL,
          keyName: KEY_NAME,
          keyVersion: KEY_VERSION,
        },
        google: {
          provider: "gcp",
          keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
        },
      },
    },
  });
}

/** Runs the `kms` hook chain the way hardhat-kms does, recording the keys that reach its end. */
async function createAdapter(
  hre: Awaited<ReturnType<typeof runtime>>,
  name: string,
  unclaimed: string[] = [],
): Promise<KmsKeyAdapter> {
  const key = hre.config.kms.keys[name];
  assert.ok(key);
  return await hre.hooks.runHandlerChain(
    "kms",
    "createKeyAdapter",
    [key],
    async (_context, rest: KmsKeyConfig) => {
      unclaimed.push(rest.displayId);
      return await Promise.reject(new Error("unclaimed"));
    },
  );
}

describe("@hardhat-kms/azure plugin", () => {
  it("loads hardhat-kms through its plugin dependency", async () => {
    const hre = await runtime();

    assert.equal(hre.config.kms.keys.deployer?.provider, "azure");
    // Listing both, as users coming from hardhat-kms alone may do, loads the core once.
    const both = await runtime([hardhatKms, hardhatKmsAzure]);
    assert.equal(both.config.kms.keys.deployer?.provider, "azure");
  });

  it("claims azure keys with the real SDK and credential chain, and passes other keys on", async () => {
    const hre = await runtime();
    const unclaimed: string[] = [];

    // Creating the adapter loads the SDK and builds the credential chain, but sends nothing.
    const adapter = await createAdapter(hre, "deployer", unclaimed);
    assert.equal(adapter.describe().provider, "azure");
    assert.equal(adapter.describe().pinnedId, `${VAULT_URL}/keys/${KEY_NAME}`);
    await createAdapter(hre, "pinned");
    await assert.rejects(createAdapter(hre, "google", unclaimed), /unclaimed/);
    assert.deepEqual(unclaimed, [
      "gcp:projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
    ]);
  });

  it("signs through the real Azure SDK with ES256K, against the version it pinned", async () => {
    const current = "fedcba9876543210fedcba9876543210";
    const vault = keyVaultHttp({
      secretKey,
      vaultUrl: VAULT_URL,
      keyName: KEY_NAME,
      currentVersion: current,
    });
    const credential = staticCredential();
    const hre = await runtime();
    hre.hooks.registerHandlers(
      "kms",
      kmsHandlers(ownVersion, loaderFor(keyVault, credential, { httpClient: vault.httpClient })),
    );
    const adapter = await createAdapter(hre, "deployer");
    const ctx = signContext();
    const digest = new Uint8Array(32).fill(5);

    const publicKey = await adapter.getPublicKey?.(ctx);
    const signature = await adapter.signDigest?.({ digest }, ctx);
    await adapter.signDigest?.({ digest }, ctx);

    assert.deepEqual(publicKey, secp256k1.getPublicKey(secretKey, false));
    assert.ok(signature !== undefined && "format" in signature && signature.format === "compact");
    assert.ok(
      secp256k1.verify(signature.bytes, digest, secp256k1.getPublicKey(secretKey), {
        prehash: false,
      }),
    );
    // Each client meets Key Vault's challenge once, then sends the token. The unversioned key is
    // read once; every signature names the version that read returned.
    const authorized = vault.requests.filter((request) => request.authorization !== undefined);
    assert.deepEqual(
      authorized.map(({ method, path }) => [method, path]),
      [
        ["GET", `/keys/${KEY_NAME}/`],
        ["POST", `/keys/${KEY_NAME}/${current}/sign`],
        ["POST", `/keys/${KEY_NAME}/${current}/sign`],
      ],
    );
    assert.equal(vault.requests.length - authorized.length, 2);
    assert.ok(vault.requests.every((request) => request.apiVersion !== null));
    // Both clients put the plugin's tag before the SDK's own user agent, which the Key Vault audit
    // log records as `ClientInfo`.
    for (const { userAgent } of vault.requests) {
      assert.ok(userAgent !== undefined && userAgent.startsWith(`hardhat-kms/${ownVersion} `));
      assert.match(userAgent, /azsdk-js-keyvault-keys\//);
    }
    const sign = authorized[1]?.body;
    assert.equal(sign?.alg, "ES256K");
    assert.equal(sign?.value, Buffer.from(digest).toString("base64url"));
    assert.deepEqual(credential.scopes, [
      "https://vault.azure.net/.default",
      "https://vault.azure.net/.default",
    ]);
    assert.deepEqual(credential.tenants, [TENANT_ID, TENANT_ID]);
  });

  it("reads the kid of the real SDK's sign response, and refuses another version", async () => {
    const vault = keyVaultHttp({
      secretKey,
      vaultUrl: VAULT_URL,
      keyName: KEY_NAME,
      currentVersion: KEY_VERSION,
      signKid: `${VAULT_URL}/keys/${KEY_NAME}/ffffffffffffffffffffffffffffffff`,
    });
    const hre = await runtime();
    hre.hooks.registerHandlers(
      "kms",
      kmsHandlers(
        ownVersion,
        loaderFor(keyVault, staticCredential(), { httpClient: vault.httpClient }),
      ),
    );
    const adapter = await createAdapter(hre, "pinned");

    await assert.rejects(
      adapter.signDigest?.({ digest: new Uint8Array(32) }, signContext()) ?? Promise.resolve(),
      /azure, sign, key azure:https:\/\/test-vault\.vault\.azure\.net\/keys\/deployer\/0123456789abcdef0123456789abcdef: the signature is from another key version than the pinned one/,
    );
  });

  it("explains a missing key that the real SDK reports", async () => {
    const vault = keyVaultHttp({
      secretKey,
      vaultUrl: VAULT_URL,
      keyName: "other",
      currentVersion: KEY_VERSION,
    });
    const hre = await runtime();
    hre.hooks.registerHandlers(
      "kms",
      kmsHandlers(
        ownVersion,
        loaderFor(keyVault, staticCredential(), { httpClient: vault.httpClient }),
      ),
    );
    const adapter = await createAdapter(hre, "deployer");

    await assert.rejects(adapter.getPublicKey?.(signContext()) ?? Promise.resolve(), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Key Vault answered 404 KeyNotFound: the key or key version/);
      return true;
    });
  });

  it("loads the SDK once per runtime, and again after a failed load", async () => {
    const hre = await runtime();
    let loads = 0;
    const fail = new Error("load failed");
    hre.hooks.registerHandlers(
      "kms",
      kmsHandlers(ownVersion, async (userAgent) => {
        loads += 1;
        if (loads === 1) {
          throw fail;
        }
        return await loaderFor(keyVault, staticCredential())(userAgent);
      }),
    );

    await assert.rejects(createAdapter(hre, "deployer"), (error) => error === fail);
    await createAdapter(hre, "deployer");
    await createAdapter(hre, "pinned");
    assert.equal(loads, 2);
  });

  it("refuses Azure keys when hardhat-kms is another version, and passes other keys on", async () => {
    const hre = await runtime();
    // Handlers registered at run time run first: these behave like a @hardhat-kms/azure 9.9.9.
    hre.hooks.registerHandlers("kms", kmsHandlers("9.9.9"));
    const unclaimed: string[] = [];

    await assert.rejects(createAdapter(hre, "deployer"), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes(
          `azure, create adapter, key azure:${VAULT_URL}/keys/${KEY_NAME}: @hardhat-kms/azure 9.9.9 needs hardhat-kms 9.9.9, but hardhat-kms ${coreVersion} is installed`,
        ),
        error.message,
      );
      assert.ok(
        error.message.includes("npm install --save-dev hardhat-kms@9.9.9 @hardhat-kms/azure@9.9.9"),
      );
      return true;
    });
    await assert.rejects(createAdapter(hre, "google", unclaimed), /unclaimed/);
    assert.equal(unclaimed.length, 1);
  });
});
