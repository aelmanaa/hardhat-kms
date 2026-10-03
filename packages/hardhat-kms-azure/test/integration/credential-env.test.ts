import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/** Variables that would give the chain another way to a token, or change the endpoint. */
const AZURE_VARIABLES = /^(AZURE_|MSI_|IDENTITY_|IMDS_|AZD_|DEBUG)/;

/** Values planted in the user variables: no output may hold them. */
const CANARY = { user: "canary-user-0d93e1", password: "canary-password-4c7a52" };

const REFUSAL =
  "AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_USERNAME and AZURE_PASSWORD are set, with no client secret or certificate, which selects username and password sign-in";

/** Runs the fixture with `env` on top of a copy of this process's environment without Azure's. */
async function run(
  task: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../fixtures/credential-env.ts",
  );
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !AZURE_VARIABLES.test(name)),
  );
  const child = spawn(process.execPath, [fixture], {
    env: {
      ...base,
      // Only node's own directory: no az or azd that could answer.
      PATH: path.dirname(process.execPath),
      HHKMS_FIXTURE_TASK: task,
      NODE_V8_COVERAGE: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 60_000);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return { code, stdout, stderr };
}

function assertNoCanary(output: string): void {
  for (const value of Object.values(CANARY)) {
    assert.ok(!output.includes(value), `${value} was printed:\n${output}`);
  }
}

describe("username and password in the environment", () => {
  const refused = {
    AZURE_TENANT_ID: "11111111-1111-1111-1111-111111111111",
    AZURE_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
    AZURE_USERNAME: CANARY.user,
    AZURE_PASSWORD: CANARY.password,
    DEBUG: "hardhat:kms:*",
  };

  for (const task of ["accounts", "history"]) {
    it(`fail kms ${task} with the catalogued error, and print no value`, async () => {
      const { code, stdout, stderr } = await run(task, refused);
      const output = `${stdout}\n${stderr}`;
      assert.equal(code, 0, output);
      assert.ok(output.includes(REFUSAL), output);
      assertNoCanary(output);
    });
  }

  it("ignores a stray AZURE_USERNAME, and names it in the debug output only", async () => {
    const { code, stdout, stderr } = await run("adapter", {
      AZURE_USERNAME: CANARY.user,
      DEBUG: "hardhat:kms:*",
    });
    const output = `${stdout}\n${stderr}`;
    assert.equal(code, 0, output);
    assert.match(stdout, /^adapter created$/m, output);
    assert.match(
      stderr,
      /hardhat:kms:azure ignored AZURE_USERNAME: hardhat-kms does not sign in with a username and password/,
      output,
    );
    assert.ok(!output.includes(REFUSAL), output);
    assertNoCanary(output);
  });
});
