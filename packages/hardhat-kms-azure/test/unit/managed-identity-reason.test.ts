// Checks the managed identity's reason for a request that fails on the network, with the real
// ManagedIdentityCredential. It has a file of its own because MSAL keeps the HTTP client of the
// first managed identity that asks for a token for the whole process, and node runs each test file
// in its own process.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RestError } from "@azure/core-rest-pipeline";
import * as identity from "@azure/identity";

import { managedIdentityReason } from "../../src/internal/credential-reasons.ts";

/** Variables that would select another managed identity endpoint. */
const AZURE_VARIABLES = /^(AZURE_|MSI_|IDENTITY_|IMDS_)/;

describe("the reason of the managed identity", () => {
  it("is no token from its endpoint when the request fails on the network", async () => {
    for (const name of Object.keys(process.env)) {
      if (AZURE_VARIABLES.test(name)) {
        delete process.env[name];
      }
    }
    const credential = new identity.ManagedIdentityCredential({
      httpClient: {
        sendRequest: async (request) =>
          await Promise.reject(
            new RestError("connect ECONNREFUSED", { code: "ECONNREFUSED", request }),
          ),
      },
      retryOptions: { maxRetries: 0 },
    });
    let thrown: unknown;
    await credential.getToken("https://vault.azure.net/.default").catch((error: unknown) => {
      thrown = error;
    });
    assert.ok(thrown instanceof Error && thrown.name === "CredentialUnavailableError");
    assert.equal(
      managedIdentityReason(thrown, false),
      "managed identity: its endpoint gave no token, as happens outside Azure",
    );
  });
});
