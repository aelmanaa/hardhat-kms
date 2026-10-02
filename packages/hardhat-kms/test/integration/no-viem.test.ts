// A project without viem: viem is an optional peer dependency, loaded only by
// connection.kms.getAccount. In a process where viem cannot be resolved, every `kms` task and the
// JSON-RPC path work, nothing tries to load viem before getAccount, and getAccount fails with a
// message that names the package. scripts/consumer-typecheck.ts checks the types of such a project.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("a project without viem", { timeout: 120_000 }, () => {
  it("runs every kms task and the RPC path, and getAccount names the package", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hardhat-kms-no-viem-log-"));
    const log = path.join(directory, "resolve.log");
    try {
      const result = spawnSync(
        process.execPath,
        [
          // --import takes a module specifier: on Windows an absolute path is not one, a file URL is.
          "--import",
          pathToFileURL(path.join(here, "../fixtures/no-viem/register.mjs")).href,
          path.join(here, "../fixtures/no-viem-run.ts"),
        ],
        {
          encoding: "utf8",
          env: { ...process.env, NODE_V8_COVERAGE: "", HARDHAT_KMS_NO_VIEM_LOG: log },
          timeout: 110_000,
        },
      );
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      const line = result.stdout.split("\n").find((text) => text.startsWith("RESULT "));
      assert.ok(line !== undefined, result.stdout);
      assert.deepEqual(JSON.parse(line.slice("RESULT ".length)), {
        ran: [
          "accounts",
          "address",
          "public-key",
          "sign",
          "sign",
          "sign",
          "verify",
          "sign-tx",
          "sign-auth",
        ],
        hash: "string",
        signed: true,
        getAccountError:
          "getAccount: connection.kms.getAccount needs the viem package, which could not be loaded (Error, ERR_MODULE_NOT_FOUND). Install it with `npm install --save-dev viem`",
      });
      // viem was asked for only by getAccount.
      const lines = readFileSync(log, "utf8").trim().split("\n");
      assert.equal(lines[0], "getAccount");
      assert.deepEqual(lines.slice(1), ["resolve viem"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
