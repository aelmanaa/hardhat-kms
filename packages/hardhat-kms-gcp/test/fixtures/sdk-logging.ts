// Uses a Google Cloud key through the plugin with the real SDK and google-auth-library, as the
// test that runs it sets GOOGLE_SDK_NODE_LOGGING: creates the key's adapter twice, signs, and reads
// the key's history with credentials that refresh their access token. The test reads what the
// libraries and the plugin printed on standard error.
import { once } from "node:events";
import { createServer } from "node:http";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { UserRefreshClient } from "google-auth-library";
import type { KmsKeyAdapter, KmsKeyConfig } from "hardhat-kms/types";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsGcp from "../../src/index.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { loggingTransport } from "../../src/internal/logging-client.ts";
import { KEY_VERSION_NAME } from "../helpers/fake-gcp-kms.ts";
import { localSdk, startKmsServer } from "../helpers/kms-server.ts";
import { startLoggingServer } from "../helpers/logging-server.ts";

/** The access token the local token endpoint hands out; the test looks for it in the output. */
const ACCESS_TOKEN = "fixture-access-token";

const kmsServer = await startKmsServer(secp256k1.utils.randomSecretKey());
const loggingServer = await startLoggingServer();
const tokenServer = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 }),
    );
  });
});
tokenServer.listen(0, "127.0.0.1");
await once(tokenServer, "listening");
const tokenAddress = tokenServer.address();
if (tokenAddress === null || typeof tokenAddress === "string") {
  throw new Error("the token server has no port");
}

/** The end of the hook chain: no other provider claims the key. */
async function unclaimed(): Promise<KmsKeyAdapter> {
  return await Promise.reject(new Error("unclaimed"));
}

try {
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKmsGcp],
    kms: { keys: { deployer: { provider: "gcp", keyVersionName: KEY_VERSION_NAME } } },
  });
  // The plugin's own handler, with the real SDK and the real Cloud Logging call pointed at the
  // local servers, and the process's warning.
  hre.hooks.registerHandlers(
    "kms",
    kmsHandlers(
      undefined,
      async () => localSdk(kmsServer.port),
      async (userAgent) =>
        await Promise.resolve(
          loggingTransport(
            new UserRefreshClient({
              clientId: "fixture-client",
              clientSecret: "fixture-secret",
              refreshToken: "fixture-refresh-token",
              endpoints: { oauth2TokenUrl: `http://127.0.0.1:${tokenAddress.port}/token` },
            }),
            userAgent,
            loggingServer.endpoint,
          ),
        ),
    ),
  );
  const key = hre.config.kms.keys.deployer;
  if (key === undefined) {
    throw new Error("no key");
  }
  const adapters = [
    await hre.hooks.runHandlerChain("kms", "createKeyAdapter", [key], unclaimed),
    await hre.hooks.runHandlerChain("kms", "createKeyAdapter", [key], unclaimed),
  ];
  const context = {
    signal: new AbortController().signal,
    displayMessage: async () => {},
    requestId: "r1",
  };
  await adapters[0]?.getPublicKey?.(context);
  await adapters[0]?.signDigest?.({ digest: new Uint8Array(32).fill(1) }, context);
  await Promise.all(adapters.map(async (adapter) => await adapter.close?.()));
  await hre.hooks.runHandlerChain(
    "kms",
    "readSignHistory",
    [
      {
        key,
        since: new Date("2026-10-01T00:00:00Z"),
        until: new Date("2026-10-02T00:00:00Z"),
        limit: 1,
      },
    ],
    async (_context, request: { key: KmsKeyConfig }) =>
      await Promise.reject(new Error(`unclaimed ${request.key.name}`)),
  );
  process.stdout.write("done\n");
} finally {
  tokenServer.close();
  await Promise.all([kmsServer.close(), loggingServer.close()]);
}
