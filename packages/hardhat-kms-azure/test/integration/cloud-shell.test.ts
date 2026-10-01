import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

describe("the real managed identity in Cloud Shell", () => {
  it("is left out when AZURE_CLIENT_ID is set", async () => {
    // MSI_ENDPOINT alone is how MSAL recognises Cloud Shell, where a client id is refused. MSAL
    // caches the managed identity source for the whole process, so this runs in a child process.
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../fixtures/cloud-shell.ts", import.meta.url))],
      {
        env: { ...process.env, MSI_ENDPOINT: "http://127.0.0.1:50342/oauth2/token" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", resolve);
    });

    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), "direct: CredentialUnavailableError; chain: built");
  });
});
