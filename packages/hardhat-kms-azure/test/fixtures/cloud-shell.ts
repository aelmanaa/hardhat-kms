// Builds the credential chain with the real @azure/identity in a process that looks like Azure
// Cloud Shell (MSI_ENDPOINT set) with AZURE_CLIENT_ID set. MSAL caches the managed identity source
// for the whole process, so this runs in a child process of its own.
import * as identity from "@azure/identity";

import { createAzureCredential } from "../../src/internal/credential.ts";

let direct = "constructed";
try {
  const credential = new identity.ManagedIdentityCredential({ clientId: "client" });
  direct = typeof credential.getToken === "function" ? "constructed" : "invalid";
} catch (error) {
  direct = error instanceof Error ? error.name : typeof error;
}
createAzureCredential(identity, { AZURE_CLIENT_ID: "client" });
process.stdout.write(`direct: ${direct}; chain: built\n`);
