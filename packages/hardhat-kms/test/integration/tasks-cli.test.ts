// Runs the kms tasks through the real Hardhat CLI. The fake adapter holds a timer that keeps the
// process alive, as an SDK client's sockets do, until the adapter is closed; so a task that does
// not close its signers never exits, and the run times out.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { privateKeyToAccount } from "viem/accounts";

import { type HardhatRun, runHardhat } from "../helpers/hardhat-cli.ts";
import { startRecordingNode } from "../helpers/recording-node.ts";
import { createTempProject, removeTempProject } from "../helpers/temp-project.ts";
import {
  COW_ACCOUNT,
  EIP712_MAIL,
  EIP712_MAIL_SIGNATURE,
  HARDHAT_ACCOUNT_0,
  PERSONAL_SIGN_VECTORS,
} from "../helpers/vectors.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let project: string;
/** The signal of the running test. */
let signal: AbortSignal | undefined;

/**
 * Runs the Hardhat CLI in the project without blocking this process, so a node served from it can
 * answer. The run has no READY marker, so it gets the helper's one limit for startup and task.
 *
 * @param args - The CLI arguments.
 * @param env - Extra environment variables.
 * @returns How the run ended, with its output.
 */
async function hardhat(args: string[], env: Record<string, string> = {}): Promise<HardhatRun> {
  return await runHardhat(args, { cwd: project, env, signal });
}

const CONFIG = (
  plugin: string,
  adapter: string,
  utils: string,
) => `import { HardhatError } from "@nomicfoundation/hardhat-errors";
import { HardhatPluginError } from "hardhat/plugins";
import kms from ${JSON.stringify(plugin)};
import { auditLogAccessDenied } from ${JSON.stringify(utils)};
import { fakeAdapter } from ${JSON.stringify(adapter)};

const secretKey = new Uint8Array(Buffer.from(${JSON.stringify(HARDHAT_ACCOUNT_0.secretKey)}, "hex"));

// Serves "myvault" keys and the --kms key AWS_KMS_KEY_ID with a fake adapter whose open handle
// keeps the process running until the adapter is closed.
const vault = {
  id: "hardhat-kms-tasks-cli-test",
  hookHandlers: {
    kms: async () => ({
      default: async () => ({
        createKeyAdapter: async (context, key, next) => {
          if (key.provider !== "myvault" && key.name !== "AWS_KMS_KEY_ID") {
            return await next(context, key);
          }
          const adapter = fakeAdapter({ secretKey });
          const handle = setInterval(() => {}, 1000);
          adapter.close = async () => clearInterval(handle);
          if (key.name === "chatty") {
            // A status line, as an adapter waiting on a slow KMS shows one.
            const getPublicKey = adapter.getPublicKey;
            adapter.getPublicKey = async (ctx) => {
              await ctx.displayMessage("waiting for the KMS");
              return await getPublicKey(ctx);
            };
          }
          return adapter;
        },
        // kms history: an empty log for deployer, a refused read for pinned, no reader otherwise.
        readSignHistory: async (context, request, next) => {
          if (request.key.name === "deployer") {
            return { source: "fake-log", notLogged: [], events: [], truncated: false, completeForKey: false };
          }
          if (request.key.name === "pinned") {
            throw auditLogAccessDenied("logs:Read");
          }
          // Reader errors that carry the key ARN where masking the message cannot reach it.
          if (request.key.name === "AWS_KMS_KEY_ID") {
            const id = process.env.AWS_KMS_KEY_ID;
            if (process.env.HHKMS_CLI_HISTORY_ERROR === "hardhat") {
              throw new HardhatError(HardhatError.ERRORS.CORE.INTERNAL.ASSERTION_ERROR, {
                message: "lookup of " + id + " failed",
              });
            }
            throw new HardhatPluginError("a-reader", "lookup failed", new Error("for " + id));
          }
          return await next(context, request);
        },
      }),
    }),
  },
};

export default {
  plugins: [kms, vault],
  kms: {
    keys: {
      deployer: { provider: "myvault", name: "deployer" },
      chatty: { provider: "myvault", name: "chatty" },
      pinned: { provider: "myvault", name: "pinned", address: ${JSON.stringify(COW_ACCOUNT.address)} },
    },
  },
  networks: {
    // Hardhat funds a simulated network's KMS accounts when it creates a connection.
    local: { type: "edr-simulated", kmsAccounts: ["deployer"] },
    // No chainId: kms sign --data reads it from the node.
    remote: {
      type: "http",
      url: process.env.TASKS_CLI_NODE_URL || "http://127.0.0.1:1",
      kmsAccounts: ["deployer"],
    },
  },
};
`;

describe("kms tasks from the Hardhat CLI", () => {
  // Stops a run when its test ends or times out.
  beforeEach((t) => {
    signal = t.signal;
  });

  before(() => {
    project = createTempProject("tasks-cli-");
    writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "p", type: "module" }),
    );
    writeFileSync(
      path.join(project, "hardhat.config.ts"),
      CONFIG(
        pathToFileURL(path.join(repo, "src/index.ts")).href,
        pathToFileURL(path.join(repo, "test/helpers/fake-adapter.ts")).href,
        pathToFileURL(path.join(repo, "src/provider-utils.ts")).href,
      ),
    );
  });

  after(async () => {
    await removeTempProject(project);
  });

  it("prints the address and exits on its own", async () => {
    const run = await hardhat(["kms", "address", "deployer"]);

    assert.equal(run.status, 0, `the task failed or did not exit:\n${run.report}`);
    assert.equal(run.stdout, `${HARDHAT_ACCOUNT_0.address}\n`);
  });

  it("prints the public key and exits on its own", async () => {
    const run = await hardhat(["kms", "public-key", "deployer"]);

    assert.equal(run.status, 0, `the task failed or did not exit:\n${run.report}`);
    assert.match(run.stdout, /^0x04[0-9a-f]{128}\n$/);
  });

  it("names a --kms key by its variable", async () => {
    const run = await hardhat(["--kms", "aws", "kms", "address", "AWS_KMS_KEY_ID"], {
      AWS_KMS_KEY_ID: "alias/from-env",
    });

    assert.equal(run.status, 0, run.report);
    assert.equal(run.stdout, `${HARDHAT_ACCOUNT_0.address}\n`);
  });

  it("fails on an unknown key with the known names", async () => {
    const run = await hardhat(["kms", "address", "nobody"]);

    assert.notEqual(run.status, null, `the task did not exit:\n${run.report}`);
    assert.notEqual(run.status, 0, run.report);
    assert.match(run.output, /unknown key "nobody"\. Known keys: deployer, chatty, pinned\./);
  });

  it("fails on a pin mismatch after opening the adapter, and still exits on its own", async () => {
    const run = await hardhat(["kms", "address", "pinned"]);

    assert.equal(run.status, 1, `the task did not fail and exit:\n${run.report}`);
    assert.equal(run.stdout.includes("0x"), false, run.stdout);
    assert.ok(
      run.stderr.includes(
        `the key derives to ${HARDHAT_ACCOUNT_0.address}, but the configured address is ${COW_ACCOUNT.address}`,
      ),
      run.report,
    );
  });

  it("prints status messages on standard error, so standard output holds only the result", async () => {
    const run = await hardhat(["kms", "address", "chatty"]);

    assert.equal(run.status, 0, run.report);
    assert.equal(run.stdout, `${HARDHAT_ACCOUNT_0.address}\n`);
    assert.match(run.stderr, /\[hardhat-kms\] waiting for the KMS/);
  });

  it("lists every key, shows a failing key and exits 1 on its own", async () => {
    const run = await hardhat(["kms", "accounts"]);

    assert.equal(run.status, 1, `the task did not fail and exit:\n${run.report}`);
    assert.match(
      run.stdout,
      new RegExp(`^deployer +myvault +kms\\.keys +${HARDHAT_ACCOUNT_0.address} `, "m"),
    );
    assert.match(run.stdout, /^pinned +myvault +kms\.keys +FAILED /m);
    assert.ok(
      run.stdout.includes(`but the configured address is ${COW_ACCOUNT.address}`),
      run.report,
    );
  });

  it("exits 0 with --json when every key works", async () => {
    const run = await hardhat(
      ["--network", "default", "--kms", "aws", "kms", "accounts", "--json"],
      {
        AWS_KMS_KEY_ID: "alias/from-env",
      },
    );

    assert.equal(run.status, 0, run.report);
    const parsed: unknown = JSON.parse(run.stdout);
    assert.deepEqual(parsed, {
      version: 1,
      accounts: [
        {
          name: "AWS_KMS_KEY_ID",
          source: "--kms",
          otherNames: [],
          provider: "aws",
          keyId: "aws:<AWS_KMS_KEY_ID>",
          region: null,
          profile: null,
          address: HARDHAT_ACCOUNT_0.address,
          pin: null,
          pinStatus: "none",
          error: null,
        },
      ],
    });
  });

  it("shows balances and sign checks on --network, prints no signature, and exits", async () => {
    const run = await hardhat([
      "--network",
      "local",
      "kms",
      "accounts",
      "--balances",
      "--check-sign",
    ]);

    assert.equal(run.status, 0, `the task failed or did not exit:\n${run.report}`);
    // The simulated network's first default account holds 10000 ETH.
    assert.match(
      run.stdout,
      new RegExp(
        `^deployer +myvault +kms\\.keys +${HARDHAT_ACCOUNT_0.address} +none +10000 +ok +`,
        "m",
      ),
    );
    assert.doesNotMatch(run.output, /[0-9a-fA-F]{130}/);
  });

  it("refuses --balances without --network and exits 1", async () => {
    const run = await hardhat(["kms", "accounts", "--balances"]);

    assert.equal(run.status, 1, `the task did not fail and exit:\n${run.report}`);
    assert.match(run.stderr, /--balances reads balances on one network: pass --network <name>/);
    assert.equal(run.stdout, "");
  });

  it("signs a transaction on --network, prints only it, the hash on stderr, and exits", async () => {
    const tx = path.join(project, "tx.json");
    writeFileSync(tx, JSON.stringify({ to: COW_ACCOUNT.address, value: "0x1" }));
    const run = await hardhat(["--network", "default", "kms", "sign-tx", "deployer", tx]);

    assert.equal(run.status, 0, `the task failed or did not exit:\n${run.report}`);
    assert.match(run.stdout, /^0x02[0-9a-f]+\n$/);
    assert.match(run.stderr, /\[hardhat-kms\] hash 0x[0-9a-f]{64}\n/);
  });

  it("fails without --network and exits on its own", async () => {
    const run = await hardhat(["kms", "sign-tx", "deployer", "tx.json"]);

    assert.equal(run.status, 1, `the task did not fail and exit:\n${run.report}`);
    assert.match(run.stderr, /kms sign-tx: --network is required/);
  });

  it("lists the tasks under kms", async () => {
    const run = await hardhat(["kms"]);

    assert.equal(run.status, 0, run.report);
    assert.match(run.output, /accounts\s+List the KMS keys/);
    assert.match(run.output, /address\s+Print a KMS key's address/);
    assert.match(
      run.output,
      /history\s+List a KMS key's sign events from its provider's audit log/,
    );
    assert.match(run.output, /public-key\s+Print a KMS key's uncompressed public key/);
    assert.match(run.output, /sign-tx\s+Fill and sign a transaction on --network/);
    assert.match(run.output, /sign\s+Sign a message, typed data or a raw digest with a KMS key/);
    assert.match(run.output, /sign-auth\s+Sign an EIP-7702 authorization with a KMS key/);
    assert.match(run.output, /verify\s+Check that an address signed a message or typed data/);
  });

  it("prints the history as JSON on standard output and the notes on standard error", async () => {
    const run = await hardhat([
      "kms",
      "history",
      "--json",
      "--since",
      "2d",
      "--until",
      "1d",
      "deployer",
    ]);

    assert.equal(run.status, 0, `the task failed or did not exit:\n${run.report}`);
    const report: unknown = JSON.parse(run.stdout);
    assert.ok(typeof report === "object" && report !== null);
    assert.equal(Reflect.get(report, "version"), 1);
    assert.deepEqual(Reflect.get(report, "events"), []);
    assert.match(run.stderr, /The log returned no sign events in this range/);
  });

  it("exits with code 1 when the log cannot be read or no plugin reads it", async () => {
    // In parallel, so the test fits its timeout when each run takes its whole limit.
    const [refused, unread] = await Promise.all([
      hardhat(["kms", "history", "pinned"]),
      hardhat(["kms", "history", "chatty"]),
    ]);

    assert.equal(refused.status, 1, refused.report);
    assert.match(refused.stderr, /cannot read the audit log: the credentials lack logs:Read/);
    assert.equal(refused.stdout, "");
    assert.equal(unread.status, 1, unread.report);
    assert.match(unread.stderr, /no plugin reads the audit log of "myvault" keys/);
  });

  it("never prints a key id from a reader's error, even with --show-stack-traces", async () => {
    const arn = "arn:aws:kms:eu-west-1:444455556666:key/0a1b2c3d-1111-4222-8333-944455556666";
    const args = ["--show-stack-traces", "--kms", "aws", "kms", "history", "AWS_KMS_KEY_ID"];
    const [fromArguments, fromCause] = await Promise.all([
      hardhat(args, { AWS_KMS_KEY_ID: arn, HHKMS_CLI_HISTORY_ERROR: "hardhat" }),
      hardhat(args, { AWS_KMS_KEY_ID: arn, HHKMS_CLI_HISTORY_ERROR: "plugin" }),
    ]);

    assert.equal(fromArguments.status, 1, fromArguments.report);
    assert.match(fromArguments.stderr, /lookup of aws:<AWS_KMS_KEY_ID> failed/);
    assert.equal(fromCause.status, 1, fromCause.report);
    assert.match(fromCause.stderr, /lookup failed/);
    for (const run of [fromArguments, fromCause]) {
      // The stack trace is printed, so the check covers it and any cause chain.
      assert.match(run.stderr, /\n\s+at /);
      assert.doesNotMatch(run.output, /444455556666|0a1b2c3d/);
    }
  });

  it("signs a 0x message as bytes, prints only the signature and exits on its own", async () => {
    const [vector] = PERSONAL_SIGN_VECTORS;
    const run = await hardhat(["kms", "sign", "deployer", `0x${vector.message}`]);

    assert.equal(run.status, 0, `the task failed or did not exit:\n${run.report}`);
    assert.equal(run.stdout, `${vector.signature}\n`);
  });

  it("signs UTF-8 text", async () => {
    const run = await hardhat(["kms", "sign", "deployer", "hello world"]);

    assert.equal(run.status, 0, run.report);
    assert.equal(
      run.stdout,
      `${await privateKeyToAccount(`0x${HARDHAT_ACCOUNT_0.secretKey}`).signMessage({ message: "hello world" })}\n`,
    );
  });

  it("signs a raw digest with --no-hash, with the warning on stderr only", async () => {
    const digest: `0x${string}` = `0x${"ab".repeat(32)}`;
    const run = await hardhat(["kms", "sign", "--no-hash", "deployer", digest]);

    assert.equal(run.status, 0, run.report);
    assert.equal(
      run.stdout,
      `${await privateKeyToAccount(`0x${HARDHAT_ACCOUNT_0.secretKey}`).sign({ hash: digest })}\n`,
    );
    assert.match(run.stderr, /\[hardhat-kms\] --no-hash signs the 32 bytes as they are/);
  });

  it("refuses a --no-hash value that is not 32 bytes", async () => {
    const run = await hardhat(["kms", "sign", "--no-hash", "deployer", `0x${"ab".repeat(31)}`]);

    assert.notEqual(run.status, null, `the task did not exit:\n${run.report}`);
    assert.notEqual(run.status, 0, run.report);
    assert.equal(run.stdout, "");
    assert.match(run.output, /--no-hash needs a 32-byte digest, got 31 bytes/);
  });

  it("signs typed data from a file with --data --from-file", async () => {
    const file = path.join(project, "mail.json");
    writeFileSync(file, JSON.stringify(EIP712_MAIL));
    const run = await hardhat([
      "kms",
      "sign",
      "--data",
      "--from-file",
      "--chain",
      "1",
      "deployer",
      file,
    ]);

    assert.equal(run.status, 0, run.report);
    const { domain, types, primaryType, message } = EIP712_MAIL;
    assert.equal(
      run.stdout,
      `${await privateKeyToAccount(`0x${HARDHAT_ACCOUNT_0.secretKey}`).signTypedData({ domain, types, primaryType, message })}\n`,
    );
  });

  it("checks typed data against a simulated --network's configured chain and exits", async () => {
    const typedData = { ...EIP712_MAIL, domain: { ...EIP712_MAIL.domain, chainId: 31337 } };
    const run = await hardhat([
      "kms",
      "sign",
      "--data",
      "--network",
      "local",
      "deployer",
      JSON.stringify(typedData),
    ]);

    assert.equal(run.status, 0, `the task failed or did not exit:\n${run.report}`);
    assert.match(run.stdout, /^0x[0-9a-f]{130}\n$/);
  });

  it("asks a --network node without a configured chainId, closes the connection and exits", async () => {
    const node = await startRecordingNode();
    try {
      const run = await hardhat(
        ["kms", "sign", "--data", "--network", "remote", "deployer", JSON.stringify(EIP712_MAIL)],
        { TASKS_CLI_NODE_URL: node.url },
      );

      assert.notEqual(run.status, null, `the task did not exit:\n${run.report}`);
      assert.notEqual(run.status, 0, run.report);
      assert.match(run.output, /the typed data is for chain 1, but network remote is chain 31337/);
      assert.ok(node.methods.includes("eth_chainId"), node.methods.join(", "));
    } finally {
      await node.server.close();
    }
  });

  it("refuses typed data for a chain when none is given to compare", async () => {
    const run = await hardhat(["kms", "sign", "--data", "deployer", JSON.stringify(EIP712_MAIL)]);

    assert.notEqual(run.status, null, `the task did not exit:\n${run.report}`);
    assert.notEqual(run.status, 0, run.report);
    assert.match(
      run.output,
      /the typed data is for chain 1, and there is no chain to compare it with/,
    );
  });

  describe("kms verify", () => {
    const [{ message, signature }] = PERSONAL_SIGN_VECTORS;

    it("exits 0 and prints one line on a match with --address", async () => {
      const run = await hardhat([
        "kms",
        "verify",
        "--address",
        HARDHAT_ACCOUNT_0.address.toLowerCase(),
        `0x${message}`,
        signature,
      ]);

      assert.equal(run.status, 0, run.report);
      assert.equal(run.stdout, `Valid: ${HARDHAT_ACCOUNT_0.address} signed this message.\n`);
      assert.equal(run.stderr, "");
    });

    it("exits 1 on a mismatch, with both addresses on stderr and nothing on stdout", async () => {
      const run = await hardhat([
        "kms",
        "verify",
        "--address",
        COW_ACCOUNT.address,
        `0x${message}`,
        signature,
      ]);

      assert.equal(run.status, 1, run.report);
      assert.equal(run.stdout, "");
      assert.equal(
        run.stderr,
        `Invalid: the signature over this message recovers to ${HARDHAT_ACCOUNT_0.address}, not to the expected signer ${COW_ACCOUNT.address}.\n`,
      );
    });

    it("checks against a key's address with --key, and exits on its own", async () => {
      const run = await hardhat(["kms", "verify", "--key", "deployer", `0x${message}`, signature]);

      assert.equal(run.status, 0, `the task failed or did not exit:\n${run.report}`);
      assert.equal(run.stdout, `Valid: ${HARDHAT_ACCOUNT_0.address} signed this message.\n`);
    });

    it("reads typed data inline with --data, or from a file with --data --from-file", async () => {
      const file = path.join(project, "verify-mail.json");
      writeFileSync(file, JSON.stringify(EIP712_MAIL));

      const [inline, fromFile, mismatch] = await Promise.all([
        hardhat([
          "kms",
          "verify",
          "--data",
          "--address",
          COW_ACCOUNT.address,
          JSON.stringify(EIP712_MAIL),
          EIP712_MAIL_SIGNATURE,
        ]),
        hardhat([
          "kms",
          "verify",
          "--data",
          "--from-file",
          "--address",
          COW_ACCOUNT.address,
          file,
          EIP712_MAIL_SIGNATURE,
        ]),
        hardhat([
          "kms",
          "verify",
          "--data",
          "--from-file",
          "--key",
          "deployer",
          file,
          EIP712_MAIL_SIGNATURE,
        ]),
      ]);

      assert.equal(inline.status, 0, inline.report);
      assert.equal(inline.stdout, `Valid: ${COW_ACCOUNT.address} signed this typed data.\n`);
      assert.equal(fromFile.status, 0, fromFile.report);
      assert.equal(fromFile.stdout, inline.stdout);
      assert.equal(mismatch.status, 1, mismatch.report);
    });

    it("takes a message that starts with - after --", async () => {
      const text = "-not-an-option";
      const sig = await privateKeyToAccount(`0x${HARDHAT_ACCOUNT_0.secretKey}`).signMessage({
        message: text,
      });

      const run = await hardhat([
        "kms",
        "verify",
        "--address",
        HARDHAT_ACCOUNT_0.address,
        "--",
        text,
        sig,
      ]);

      assert.equal(run.status, 0, run.report);
      assert.equal(run.stdout, `Valid: ${HARDHAT_ACCOUNT_0.address} signed this message.\n`);
    });

    it("exits 1 with a clear error on a malformed signature", async () => {
      const run = await hardhat([
        "kms",
        "verify",
        "--address",
        HARDHAT_ACCOUNT_0.address,
        `0x${message}`,
        "0x1234",
      ]);

      assert.equal(run.status, 1, run.report);
      assert.equal(run.stdout, "");
      // Hardhat colours the error prefix when it detects colour support.
      assert.match(
        stripVTControlCharacters(run.output),
        /Error in community plugin hardhat-kms: kms verify: invalid signature: expected a 65-byte signature/,
      );
    });
  });

  it("signs an EIP-7702 authorization, prints only the JSON tuple and exits", async () => {
    const delegate = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
    const run = await hardhat([
      "kms",
      "sign-auth",
      "--chain",
      "1",
      "--nonce",
      "0",
      "deployer",
      delegate,
    ]);

    assert.equal(run.status, 0, `the task failed or did not exit:\n${run.report}`);
    const signed = await privateKeyToAccount(`0x${HARDHAT_ACCOUNT_0.secretKey}`).signAuthorization({
      address: delegate,
      chainId: 1,
      nonce: 0,
    });
    assert.equal(
      run.stdout,
      `${JSON.stringify({ chainId: "0x1", address: delegate, nonce: "0x0", yParity: `0x${signed.yParity}`, r: signed.r, s: signed.s })}\n`,
    );
  });

  it("reads the nonce from a simulated --network, adds one with --self-broadcast and exits", async () => {
    const run = await hardhat([
      "kms",
      "sign-auth",
      "--network",
      "local",
      "--self-broadcast",
      "deployer",
      "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    ]);

    assert.equal(run.status, 0, `the task failed or did not exit:\n${run.report}`);
    assert.match(
      run.stdout,
      /^\{"chainId":"0x7a69","address":"0x5FbDB2315678afecb367f032d93F642f64180aa3","nonce":"0x1",/,
    );
    assert.match(
      run.stderr,
      /\[hardhat-kms\] the authorization uses nonce 1: send it in a transaction from this key with nonce 0/,
    );
    assert.ok(
      run.stderr.includes(
        `[hardhat-kms] authority ${HARDHAT_ACCOUNT_0.address}, chain 31337 (from --network local), nonce 1, delegate 0x5FbDB2315678afecb367f032d93F642f64180aa3\n`,
      ),
      run.stderr,
    );
  });

  it("refuses chain 0 without --force", async () => {
    const run = await hardhat([
      "kms",
      "sign-auth",
      "--chain",
      "0",
      "--nonce",
      "0",
      "deployer",
      "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    ]);

    assert.notEqual(run.status, null, `the task did not exit:\n${run.report}`);
    assert.notEqual(run.status, 0, run.report);
    assert.equal(run.stdout, "");
    assert.match(
      run.output,
      /an authorization for chain 0 is valid on every chain where the account's nonce matches\. Pass --force/,
    );
  });
});
