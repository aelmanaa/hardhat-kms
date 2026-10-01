import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import hardhatKmsAws from "../../src/index.ts";
import { isolateAwsEnvironment } from "../helpers/aws-env.ts";
import { type KmsServer, startKmsServer } from "../helpers/kms-server.ts";

// Hardhat's first default account and a personal_sign vector from Hardhat's own local-accounts
// tests: a KMS key holding the same private key must give the same signature.
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

describe("hardhat-kms-aws through a network connection", () => {
  let server: KmsServer;
  let restoreEnvironment: () => void;

  before(async () => {
    server = await startKmsServer(new Uint8Array(Buffer.from(ACCOUNT_0.secretKey, "hex")));
    restoreEnvironment = isolateAwsEnvironment();
  });

  after(async () => {
    restoreEnvironment();
    await server.close();
  });

  it("lists the AWS account and signs personal_sign through the real SDK", async () => {
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKmsAws],
      kms: {
        keys: {
          deployer: {
            provider: "aws",
            keyId: "alias/deployer",
            region: "eu-west-1",
            endpoint: server.url,
          },
        },
      },
      // The http network is unreachable: only the KMS account can be listed, and every answer
      // below must come from the plugin.
      networks: {
        remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["deployer"] },
      },
    });
    const connection = await hre.network.create("remote");
    server.requests.length = 0;

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
    // One key lookup, then one signature with the key ARN.
    assert.deepEqual(
      server.requests.map(({ headers }) => headers["x-amz-target"]),
      ["TrentService.GetPublicKey", "TrentService.Sign"],
    );
    await connection.close();
  });

  it("signs eth_signTransaction through the real SDK like Hardhat's local accounts", async () => {
    const hre = await createHardhatRuntimeEnvironment({
      plugins: [hardhatKmsAws],
      kms: {
        keys: {
          deployer: {
            provider: "aws",
            keyId: "alias/deployer",
            region: "eu-west-1",
            endpoint: server.url,
          },
        },
      },
      networks: { local: { type: "edr-simulated", kmsAccounts: ["deployer"] } },
    });
    const connection = await hre.network.create("local");
    server.requests.length = 0;

    // Every field is set, so filling reads only the chain id and the bytes are fixed.
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
    assert.deepEqual(
      server.requests.map(({ headers }) => headers["x-amz-target"]),
      ["TrentService.GetPublicKey", "TrentService.Sign"],
    );
    await connection.close();
  });

  it("lets the process exit after signing, without closing the connection", async () => {
    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../fixtures/sign-and-exit.ts",
    );
    const child = spawn(process.execPath, [fixture], {
      env: { ...process.env, HHKMS_FIXTURE_ENDPOINT: server.url, NODE_V8_COVERAGE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const started = Date.now();
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
    assert.ok(Date.now() - started < 30_000);
  });
});
