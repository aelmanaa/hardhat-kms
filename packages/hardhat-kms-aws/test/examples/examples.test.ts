// Runs every project in examples/ the way its README does, against LocalStack's KMS and the real
// AWS SDK: `pnpm run test:examples`. Needs Docker. The examples are unchanged: the standard AWS
// variables point the SDK at LocalStack, and AWS_KMS_KEY_ID names a key created here.
//
// Registry mode: with HARDHAT_KMS_EXAMPLES_VERSION set to an exact version, the test copies the
// examples to a temporary directory with hardhat-kms and @hardhat-kms/aws at that version, as a
// user copies one, installs each copy with npm from the registry (HARDHAT_KMS_EXAMPLES_REGISTRY
// names another registry, for a rehearsal) and runs the same checks there, with npm in place of
// pnpm. The lint step stays with the workspace run: the copy has the same sources.
//
// Each example's deploy script prints `Deployer:`, `Counter:`, `Owner:` and `Count:` lines. The
// test checks that the deployer and the contract's owner are the address of the LocalStack key,
// computed here from its public key, and that the count read back from the contract is 7 + 5.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CreateKeyCommand, GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { isolateAwsEnvironment } from "../helpers/aws-env.ts";
import { copyExamples } from "../helpers/examples-copy.ts";
import { type LocalStack, startLocalStack } from "../helpers/localstack.ts";

const REGION = "us-east-1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SOURCE_DIRECTORY = path.join(ROOT, "examples");
/** The exact version the copies install from the registry; unset for the workspace run. */
const REGISTRY_VERSION = process.env.HARDHAT_KMS_EXAMPLES_VERSION?.trim() ?? "";
const REGISTRY_URL = process.env.HARDHAT_KMS_EXAMPLES_REGISTRY?.trim() ?? "";
const fromRegistry = REGISTRY_VERSION !== "";
const EXPECTED_COUNT = 12n;
/** The guide whose `--kms` rehearsal command the Ignition example runs as written. */
const IGNITION_GUIDE = path.join(ROOT, "docs", "user", "guides", "deploy-with-ignition.md");
/** Hardhat's built-in `localhost` network, where `hardhat node` listens by default. */
const NODE_URL = "http://127.0.0.1:8545";
/** The selectors of `owner()` and `count()` in contracts/Counter.sol. */
const OWNER_SELECTOR = "0x8da5cb5b";
const COUNT_SELECTOR = "0x06661abd";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// .cmd files need a shell on Windows (CVE-2024-27980 hardening in child_process).
const shell = process.platform === "win32";
const run = promisify(execFile);

const examples = readdirSync(SOURCE_DIRECTORY, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted();

let localstack: LocalStack;
let restoreEnvironment: () => void;
let environment: NodeJS.ProcessEnv;
let kmsAddress: string;
/** Where the examples run: examples/ itself, or the copies in registry mode. */
let examplesDirectory = SOURCE_DIRECTORY;

/** The Ethereum address of a KMS key, from the SPKI DER public key that GetPublicKey returns. */
function addressOf(spki: Uint8Array): string {
  // An uncompressed secp256k1 point is the last 65 bytes of its SPKI encoding.
  const point = secp256k1.Point.fromBytes(spki.subarray(-65)).toBytes(false);
  const hash = keccak_256(point.subarray(1));
  return `0x${Buffer.from(hash.subarray(-20)).toString("hex")}`;
}

/**
 * Runs a package manager in a directory with the LocalStack environment.
 *
 * @returns The command's standard output; a failure carries its output in the error message.
 */
async function managerAt(command: string, cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(command, args, {
      cwd,
      env: environment,
      shell,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stdout: unknown = Reflect.get(Object(error), "stdout");
    const stderr: unknown = Reflect.get(Object(error), "stderr");
    throw new Error(
      `${path.relative(ROOT, cwd)}: ${command} ${args.join(" ")} failed\n${String(stdout)}\n${String(stderr)}`,
      { cause: error },
    );
  }
}

const pnpmAt = async (cwd: string, args: string[]): Promise<string> =>
  await managerAt(pnpm, cwd, args);

/**
 * Runs `exec <bin> ...` or `run <script> ...` in an example: with pnpm in the workspace, with npm
 * in a copy, which needs `--` before a script's arguments.
 */
async function runIn(example: string, args: string[]): Promise<string> {
  const cwd = path.join(examplesDirectory, example);
  if (!fromRegistry) {
    return await pnpmAt(cwd, args);
  }
  const [verb, name, ...rest] = args;
  assert.ok(name !== undefined && (verb === "exec" || verb === "run"), args.join(" "));
  return await managerAt(
    npm,
    cwd,
    verb === "exec" ? ["exec", "--", name, ...rest] : ["run", name, "--", ...rest],
  );
}

/** The version of hardhat-kms a copy resolves, from the installed manifest. */
function installedVersion(directory: string): string {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(directory, "node_modules", "hardhat-kms", "package.json"), "utf8"),
  );
  return String(Reflect.get(Object(manifest), "version"));
}

/** The value printed after `label:` on its own line of `output`. */
function printed(output: string, label: string): string {
  const match = new RegExp(`^${label}: (\\S+)$`, "m").exec(output);
  assert.ok(match?.[1] !== undefined, `no "${label}:" line in:\n${output}`);
  return match[1];
}

/**
 * The arguments after `npx hardhat` of the Ignition guide's `--kms aws` command, with the guide's
 * `0x…` placeholder replaced by the key's address. The guide sets `AWS_KMS_KEY_ID` on the command;
 * here the environment already holds the LocalStack key's id.
 */
function guideKmsDeployArguments(address: string): string[] {
  const guide = readFileSync(IGNITION_GUIDE, "utf8");
  const match = /^AWS_KMS_KEY_ID=\S+ npx hardhat (ignition deploy .*--kms aws.*)$/m.exec(guide);
  assert.ok(
    match?.[1] !== undefined,
    `no "--kms aws" ignition deploy command in ${IGNITION_GUIDE}`,
  );
  return match[1].split(" ").map((argument) => (argument === "0x…" ? address : argument));
}

/** Sends one JSON-RPC request to the Hardhat node and returns its result. */
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(NODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json();
  const error: unknown = Reflect.get(Object(body), "error");
  if (error !== undefined) {
    throw new Error(`${method} failed: ${JSON.stringify(error)}`);
  }
  return Reflect.get(Object(body), "result");
}

/** Reads a 32-byte word from a contract with `eth_call`. */
async function callWord(to: string, data: string): Promise<string> {
  const result = await rpc("eth_call", [{ to, data }, "latest"]);
  assert.ok(typeof result === "string" && /^0x[0-9a-f]{64}$/.test(result), String(result));
  return result;
}

/**
 * Starts `hardhat node` in an example's directory and waits until it answers on the `localhost`
 * network's URL.
 *
 * @returns The node's process.
 */
async function startNode(example: string): Promise<ChildProcess> {
  const alreadyRunning = await rpc("eth_chainId", []).then(
    () => true,
    () => false,
  );
  assert.ok(!alreadyRunning, `something already listens on ${NODE_URL}; stop it and run again`);
  // Node runs Hardhat's CLI directly, without pnpm in between, so that kill() stops the server.
  const directory = path.join(examplesDirectory, example);
  const cli = path.join(directory, "node_modules", "hardhat", "dist", "src", "cli.js");
  const node = spawn(process.execPath, [cli, "node"], {
    cwd: directory,
    env: environment,
    stdio: "ignore",
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (
      await rpc("eth_chainId", []).then(
        () => true,
        () => false,
      )
    ) {
      return node;
    }
    if (node.exitCode !== null || Date.now() > deadline) {
      node.kill();
      throw new Error(`hardhat node did not start in examples/${example}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe("examples on LocalStack KMS", { timeout: 600_000 }, () => {
  before(async () => {
    restoreEnvironment = isolateAwsEnvironment();
    if (fromRegistry) {
      examplesDirectory = mkdtempSync(path.join(tmpdir(), "hhkms-examples-"));
      copyExamples(SOURCE_DIRECTORY, examplesDirectory, REGISTRY_VERSION);
    }
    localstack = await startLocalStack();
    const kms = new KMSClient({ region: REGION, endpoint: localstack.endpoint });
    try {
      const created = await kms.send(
        new CreateKeyCommand({ KeySpec: "ECC_SECG_P256K1", KeyUsage: "SIGN_VERIFY" }),
      );
      const keyId = created.KeyMetadata?.KeyId;
      assert.ok(keyId !== undefined);
      const { PublicKey } = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
      assert.ok(PublicKey !== undefined);
      kmsAddress = addressOf(PublicKey);
      environment = {
        ...process.env,
        AWS_REGION: REGION,
        AWS_ENDPOINT_URL_KMS: localstack.endpoint,
        AWS_KMS_KEY_ID: keyId,
      };
    } finally {
      kms.destroy();
    }
  });

  after(() => {
    localstack?.stop();
    restoreEnvironment();
    // Only a copy is removed, never examples/: the path must be the one `before` created.
    if (
      fromRegistry &&
      path.dirname(examplesDirectory) === path.resolve(tmpdir()) &&
      path.basename(examplesDirectory).startsWith("hhkms-examples-")
    ) {
      rmSync(examplesDirectory, { recursive: true, force: true });
    }
  });

  it("finds the viem, ethers and Ignition examples", () => {
    for (const name of ["viem", "ethers", "ignition"]) {
      assert.ok(examples.includes(name), `examples/${name} is missing`);
    }
  });

  for (const example of examples) {
    if (fromRegistry) {
      it(`${example}: a copy installs ${REGISTRY_VERSION} with npm from the registry`, async () => {
        const directory = path.join(examplesDirectory, example);
        await managerAt(npm, directory, [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          ...(REGISTRY_URL === "" ? [] : ["--registry", REGISTRY_URL]),
        ]);
        assert.equal(installedVersion(directory), REGISTRY_VERSION);
      });
    }

    it(`${example}: builds, typechecks, lints and deploys from the KMS account`, async () => {
      // `hardhat build` writes the artifact types that the typecheck and type-aware lint need,
      // which is why the root lint skips examples/ and this test lints them instead.
      await runIn(example, ["exec", "hardhat", "build"]);
      await runIn(example, ["exec", "tsc", "-p", "."]);
      if (!fromRegistry) {
        await pnpmAt(ROOT, [
          "exec",
          "oxlint",
          "--config",
          "examples/oxlint.json",
          `examples/${example}`,
        ]);
      }

      const output = await runIn(example, ["run", "deploy", "--network", "rehearsal"]);
      assert.equal(printed(output, "Deployer").toLowerCase(), kmsAddress);
      assert.match(printed(output, "Counter"), /^0x[0-9a-fA-F]{40}$/);
      assert.equal(printed(output, "Owner").toLowerCase(), kmsAddress);
      assert.equal(BigInt(printed(output, "Count")), EXPECTED_COUNT);
    });

    const modules = path.join(SOURCE_DIRECTORY, example, "ignition", "modules");
    if (existsSync(modules)) {
      for (const file of readdirSync(modules).filter((name) => name.endsWith(".ts"))) {
        // A simulated network keeps no state after the task exits, so this deploys to a Hardhat
        // node through the `localhost` network, with the key added by `--kms aws`, and reads the
        // counter back from the node.
        it(`${example}: ignition deploy ${file} from the KMS account to a Hardhat node`, async () => {
          const node = await startNode(example);
          try {
            await rpc("hardhat_setBalance", [kmsAddress, "0xde0b6b3a7640000"]);
            const output = await runIn(example, [
              "exec",
              "hardhat",
              "ignition",
              "deploy",
              `ignition/modules/${file}`,
              "--network",
              "localhost",
              "--kms",
              "aws",
              "--default-sender",
              kmsAddress,
            ]);
            assert.match(output, /successfully deployed/);
            const address = /#Counter - (0x[0-9a-fA-F]{40})/.exec(output)?.[1];
            assert.ok(address !== undefined, `no Counter address in:\n${output}`);
            const owner = await callWord(address, OWNER_SELECTOR);
            assert.equal(`0x${owner.slice(-40)}`, kmsAddress);
            assert.equal(BigInt(await callWord(address, COUNT_SELECTOR)), EXPECTED_COUNT);
          } finally {
            node.kill();
            rmSync(path.join(examplesDirectory, example, "ignition", "deployments"), {
              recursive: true,
              force: true,
            });
          }
        });
      }
    }
  }

  // Runs after the example's own test, which builds it. The guide's command runs on a simulated
  // network that lists no KMS keys, so `--kms aws` adds the key there and `kms.simulatedBalance`
  // funds it. Ignition fails if the counter's `add`, which only the deployer may call, reverts.
  it("ignition: the deploy-with-ignition guide's --kms command deploys as written", async () => {
    const commandArguments = guideKmsDeployArguments(kmsAddress);
    assert.ok(commandArguments.includes(kmsAddress), commandArguments.join(" "));
    const output = await runIn("ignition", ["exec", "hardhat", ...commandArguments]);
    assert.match(output, /successfully deployed/);
    assert.match(output, /#Counter - 0x[0-9a-fA-F]{40}/);
  });

  // Runs after the viem example's own test, which builds it with AWS_KMS_PROFILE and
  // AWS_KMS_REGION unset. Here the environment holds no keys and no AWS_REGION, so the deploy
  // works only if the config reads the profile and the region from its variables.
  it("viem: deploys with the profile and region from the config's variables", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hhkms-example-profile-"));
    const configFile = path.join(directory, "config");
    writeFileSync(
      configFile,
      [
        "[profile hhkms-example]",
        "aws_access_key_id = test",
        "aws_secret_access_key = test",
        "",
      ].join("\n"),
    );
    const {
      AWS_ACCESS_KEY_ID: _keyId,
      AWS_SECRET_ACCESS_KEY: _secret,
      AWS_REGION: _region,
      ...rest
    } = environment;
    const saved = environment;
    environment = {
      ...rest,
      AWS_CONFIG_FILE: configFile,
      AWS_KMS_PROFILE: "hhkms-example",
      AWS_KMS_REGION: REGION,
    };
    try {
      const output = await runIn("viem", ["run", "deploy", "--network", "rehearsal"]);
      assert.equal(printed(output, "Deployer").toLowerCase(), kmsAddress);
      assert.equal(printed(output, "Owner").toLowerCase(), kmsAddress);
    } finally {
      environment = saved;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
