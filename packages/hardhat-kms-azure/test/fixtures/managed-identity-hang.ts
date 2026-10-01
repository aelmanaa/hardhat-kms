// Asks the real credential chain for a token when only a managed identity endpoint that never
// answers is available, then returns without calling process.exit. The test that runs it points
// AZURE_POD_IDENTITY_AUTHORITY_HOST at that endpoint, leaves az and azd off PATH, and checks that
// the process exits on its own soon after the chain gives up.
import * as identity from "@azure/identity";

import { createAzureCredential } from "../../src/internal/credential.ts";

const started = Date.now();
let outcome = "token";
try {
  await createAzureCredential(identity, undefined).getToken("https://vault.azure.net/.default");
} catch (error) {
  outcome = error instanceof Error ? error.name : typeof error;
}
process.stdout.write(`${outcome} after ${Date.now() - started} ms\n`);
