// Runs every project in examples/ the way its README does, against LocalStack's KMS and the real
// AWS SDK: `pnpm run test:examples`. Needs Docker. The examples are unchanged: the standard AWS
// variables point the SDK at LocalStack, and AWS_KMS_KEY_ID names a key created here.
//
// Each example's deploy script prints `Deployer:`, `Counter:`, `Owner:` and `Count:` lines. The
// test checks that the deployer and the contract's owner are the address of the LocalStack key,
// computed here from its public key, and that the count read back from the contract is 7 + 5.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CreateKeyCommand, GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { isolateAwsEnvironment } from "../helpers/aws-env.ts";
import { type LocalStack, startLocalStack } from "../helpers/localstack.ts";

const REGION = "us-east-1";
const EXAMPLES_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../examples",
);
const EXPECTED_COUNT = 12n;
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
// .cmd files need a shell on Windows (CVE-2024-27980 hardening in child_process).
const shell = process.platform === "win32";
const run = promisify(execFile);

const examples = readdirSync(EXAMPLES_DIRECTORY, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted();

let localstack: LocalStack;
let restoreEnvironment: () => void;
let environment: NodeJS.ProcessEnv;
let kmsAddress: string;

/** The Ethereum address of a KMS key, from the SPKI DER public key that GetPublicKey returns. */
function addressOf(spki: Uint8Array): string {
  // An uncompressed secp256k1 point is the last 65 bytes of its SPKI encoding.
  const point = secp256k1.Point.fromBytes(spki.subarray(-65)).toBytes(false);
  const hash = keccak_256(point.subarray(1));
  return `0x${Buffer.from(hash.subarray(-20)).toString("hex")}`;
}

/**
 * Runs pnpm in an example's directory with the LocalStack environment.
 *
 * @returns The command's standard output; a failure carries its output in the error message.
 */
async function pnpmIn(example: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(pnpm, args, {
      cwd: path.join(EXAMPLES_DIRECTORY, example),
      env: environment,
      shell,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stdout: unknown = Reflect.get(Object(error), "stdout");
    const stderr: unknown = Reflect.get(Object(error), "stderr");
    throw new Error(
      `examples/${example}: pnpm ${args.join(" ")} failed\n${String(stdout)}\n${String(stderr)}`,
      { cause: error },
    );
  }
}

/** The value printed after `label:` on its own line of `output`. */
function printed(output: string, label: string): string {
  const match = new RegExp(`^${label}: (\\S+)$`, "m").exec(output);
  assert.ok(match?.[1] !== undefined, `no "${label}:" line in:\n${output}`);
  return match[1];
}

describe("examples on LocalStack KMS", { timeout: 600_000 }, () => {
  before(async () => {
    restoreEnvironment = isolateAwsEnvironment();
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
  });

  it("finds the viem, ethers and Ignition examples", () => {
    for (const name of ["viem", "ethers", "ignition"]) {
      assert.ok(examples.includes(name), `examples/${name} is missing`);
    }
  });

  for (const example of examples) {
    it(`${example}: builds, typechecks and deploys from the KMS account`, async () => {
      // `hardhat build` writes the artifact types that the scripts' typecheck needs.
      await pnpmIn(example, ["exec", "hardhat", "build"]);
      await pnpmIn(example, ["exec", "tsc", "-p", "."]);

      const output = await pnpmIn(example, ["run", "deploy", "--network", "rehearsal"]);
      assert.equal(printed(output, "Deployer").toLowerCase(), kmsAddress);
      assert.match(printed(output, "Counter"), /^0x[0-9a-fA-F]{40}$/);
      assert.equal(printed(output, "Owner").toLowerCase(), kmsAddress);
      assert.equal(BigInt(printed(output, "Count")), EXPECTED_COUNT);
    });

    const modules = path.join(EXAMPLES_DIRECTORY, example, "ignition", "modules");
    if (existsSync(modules)) {
      for (const file of readdirSync(modules).filter((name) => name.endsWith(".ts"))) {
        it(`${example}: ignition deploy ${file} with the KMS account as default sender`, async () => {
          const output = await pnpmIn(example, [
            "exec",
            "hardhat",
            "ignition",
            "deploy",
            `ignition/modules/${file}`,
            "--network",
            "rehearsal",
            "--default-sender",
            kmsAddress,
          ]);
          assert.match(output, /successfully deployed/);
          assert.match(output, /#\w+ - 0x[0-9a-fA-F]{40}/);
        });
      }
    }
  }
});
