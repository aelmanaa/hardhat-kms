import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsGcp from "../../src/index.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { KEY_VERSION_NAME } from "../helpers/fake-gcp-kms.ts";
import {
  isolateGcpEnvironment,
  type KmsServer,
  localSdk,
  startKmsServer,
} from "../helpers/kms-server.ts";

// Hardhat's first default account and a personal_sign vector from Hardhat's own local-accounts
// tests: a KMS key holding the same private key must give the same signature. The local server
// returns every signature with a high S, so the plugin must fold it to match.
const ACCOUNT_0 = {
  secretKey: "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
};
const MESSAGE = "0x5417aa2a18a44da0675524453ff108c545382f0d7e26605c56bba47c21b5e979";
const SIGNATURE =
  "0x9c73dd4937a37eecab3abb54b74b6ec8e500080431d36afedb1726624587ee6710296e10c1194dded7376f13ff03ef6c9e797eb86bae16c20c57776fc69344271c";
// What Hardhat's local accounts send for the eth_signTransaction request below, on chain 31337:
// an EIP-1559 transfer of 1 wei to Hardhat's second account, signed by account 0.
const SIGNED_TRANSACTION =
  "0x02f868827a698001843b9aca008252089470997970c51812dc3a010c7d01b50e0d17dc79c80180c080a09a383148f3856d41c63a9f5f1aa23ecdb6bbfbbeb5cd0721ce040291d890df62a01e03ff1466ba6e09588cddddd8d21cd72db773ab8a490216c55a42a10b1e302e";

describe("hardhat-kms-gcp through a network connection", () => {
  let server: KmsServer;
  let restoreEnvironment: () => void;

  before(async () => {
    server = await startKmsServer(new Uint8Array(Buffer.from(ACCOUNT_0.secretKey, "hex")));
    restoreEnvironment = isolateGcpEnvironment();
  });

  after(async () => {
    restoreEnvironment();
    await server.close();
  });

  async function connect(network: "remote" | "local") {
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKmsGcp],
      kms: { keys: { deployer: { provider: "gcp", keyVersionName: KEY_VERSION_NAME } } },
      networks: {
        remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["deployer"] },
        local: { type: "edr-simulated", kmsAccounts: ["deployer"] },
      },
    });
    hre.hooks.registerHandlers(
      "kms",
      kmsHandlers(undefined, async () => localSdk(server.port)),
    );
    const connection = await hre.network.create(network);
    server.requests.length = 0;
    return connection;
  }

  it("lists the Google Cloud account and signs personal_sign, folding the high S", async () => {
    // The http network is unreachable: every answer below must come from the plugin.
    const connection = await connect("remote");

    assert.deepEqual(await connection.provider.request({ method: "eth_accounts" }), [
      ACCOUNT_0.address,
    ]);
    assert.equal(
      await connection.provider.request({
        method: "personal_sign",
        params: [MESSAGE, ACCOUNT_0.address],
      }),
      SIGNATURE,
    );
    assert.deepEqual(
      server.requests.map(({ method }) => method),
      ["GET", "POST"],
    );
    await connection.close();
  });

  it("signs eth_signTransaction like Hardhat's local accounts", async () => {
    const connection = await connect("local");

    const raw = await connection.provider.request({
      method: "eth_signTransaction",
      params: [
        {
          from: ACCOUNT_0.address,
          to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          value: "0x1",
          gas: "0x5208",
          maxFeePerGas: "0x3b9aca00",
          maxPriorityFeePerGas: "0x1",
          nonce: "0x0",
        },
      ],
    });
    assert.equal(raw, SIGNED_TRANSACTION);
    await connection.close();
  });

  it("refuses a signature that is not strict DER, even with a matching checksum", async () => {
    const connection = await connect("remote");
    await connection.provider.request({ method: "eth_accounts" });
    server.faults.signature = Uint8Array.of(0x30, 0x02, 0x01, 0x01);
    try {
      await assert.rejects(
        connection.provider.request({
          method: "personal_sign",
          params: [MESSAGE, ACCOUNT_0.address],
        }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /invalid signature/);
          return true;
        },
      );
    } finally {
      server.faults.signature = undefined;
      await connection.close();
    }
  });

  it("lets the process exit after signing, without closing the connection", async () => {
    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../fixtures/sign-and-exit.ts",
    );
    const child = spawn(process.execPath, [fixture], {
      env: { ...process.env, HHKMS_FIXTURE_PORT: String(server.port), NODE_V8_COVERAGE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, 30_000);
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });

    assert.equal(code, 0, `the process did not exit by itself:\n${output}`);
    assert.match(output, /signed/);
  });
});
