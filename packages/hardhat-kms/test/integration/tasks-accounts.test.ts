import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import { isResult } from "hardhat/utils/result";

import hardhatKms from "../../src/index.ts";
import type { AccountEntry, AccountsReport, KmsKeyUserConfig } from "../../src/types.ts";
import { type FakeAdapter, fakeAdapter, type FakeAdapterOptions } from "../helpers/fake-adapter.ts";
import { vaultKey } from "../helpers/vault-key.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "../helpers/vectors.ts";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));

const VARIABLES = ["AWS_KMS_KEY_ID", "HHKMS_TEST_DEPLOYER_ID", "HHKMS_TEST_UNSET_ID"];
const saved = new Map(VARIABLES.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
});

/** A fake adapter that counts how often it was closed. */
type ClosableAdapter = FakeAdapter & { closed: number };

function closableAdapter(options: Partial<FakeAdapterOptions> = {}): ClosableAdapter {
  const adapter = Object.assign(
    fakeAdapter({ secretKey: hex(HARDHAT_ACCOUNT_0.secretKey), ...options }),
    { closed: 0 },
  );
  adapter.close = async () => {
    adapter.closed++;
  };
  return adapter;
}

/**
 * A runtime with the given `kms.keys`, `local` and `other` networks with `kmsAccounts`, and a `kms`
 * hook handler that serves every key named in `adapters` with a closable fake adapter. Any other
 * key reaches the end of the hook chain and fails.
 */
async function runtime(
  options: {
    keys?: Record<string, KmsKeyUserConfig>;
    kmsAccounts?: Array<string | KmsKeyUserConfig>;
    otherAccounts?: Array<string | KmsKeyUserConfig>;
    adapters?: Record<string, () => ClosableAdapter>;
    kms?: string;
    network?: string;
    simulatedBalance?: bigint;
    otherUrl?: string;
  } = {},
) {
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms],
      kms: {
        keys: options.keys ?? {},
        ...(options.simulatedBalance === undefined
          ? {}
          : { simulatedBalance: options.simulatedBalance }),
      },
      networks: {
        local: { type: "edr-simulated", kmsAccounts: options.kmsAccounts ?? [] },
        other: {
          type: "http",
          url: options.otherUrl ?? "http://127.0.0.1:1",
          kmsAccounts: options.otherAccounts ?? [],
        },
      },
    },
    {
      ...(options.kms === undefined ? {} : { kms: options.kms }),
      ...(options.network === undefined ? {} : { network: options.network }),
    },
  );
  const created: ClosableAdapter[] = [];
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (context, key, next) => {
      const make = options.adapters?.[key.name];
      if (make === undefined) {
        return await next(context, key);
      }
      const adapter = make();
      created.push(adapter);
      return adapter;
    },
  });
  return { hre, created };
}

/** A fake adapter that also signs messages itself, so the test sees what it was asked to sign. */
function messageAdapter(signed: string[], options: Partial<FakeAdapterOptions> = {}) {
  return (): ClosableAdapter => {
    const adapter = closableAdapter(options);
    const signDigest = adapter.signDigest?.bind(adapter);
    assert.ok(signDigest !== undefined);
    adapter.signMessage = async ({ message, digest }, ctx) => {
      signed.push(Buffer.from(message).toString("utf8"));
      return await signDigest({ digest }, ctx);
    };
    return adapter;
  };
}

/**
 * A fake adapter that records the `r` and `s` of each signature it returns, as 64 hex digits each,
 * so a test can look for them in the output.
 */
function signatureRecorder(seen: string[]) {
  return (): ClosableAdapter => {
    const adapter = closableAdapter();
    const signDigest = adapter.signDigest?.bind(adapter);
    assert.ok(signDigest !== undefined);
    adapter.signDigest = async (request, ctx) => {
      const output = await signDigest(request, ctx);
      assert.ok("format" in output && output.format === "der", "the fake adapter returns DER");
      const { r, s } = secp256k1.Signature.fromBytes(output.bytes, "der");
      seen.push(r.toString(16).padStart(64, "0"), s.toString(16).padStart(64, "0"));
      return output;
    };
    return adapter;
  };
}

/**
 * Counts the connections a runtime opens and closes, through a network hook that runs for every
 * connection.
 */
function countConnections(hre: Awaited<ReturnType<typeof runtime>>["hre"]) {
  const counts = { opened: 0, closed: 0 };
  hre.hooks.registerHandlers("network", {
    newConnection: async (context, next) => {
      const connection = await next(context);
      counts.opened++;
      return connection;
    },
    closeConnection: async (context, connection, next) => {
      counts.closed++;
      await next(context, connection);
    },
  });
  return counts;
}

/** A fake adapter whose KMS refuses to sign. */
function refusing(): ClosableAdapter {
  const adapter = closableAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) });
  adapter.signDigest = async () => {
    throw new Error("AccessDeniedException for 10.0.0.1");
  };
  return adapter;
}

interface AccountsRun {
  success: boolean;
  accounts: AccountEntry[];
  printed: string;
  stderr: string;
}

function isReport(value: unknown): value is AccountsReport {
  return (
    typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "accounts"))
  );
}

/** Runs `kms accounts` and returns its result and what it printed on each stream. */
async function accounts(
  hre: Awaited<ReturnType<typeof runtime>>["hre"],
  args: { json?: boolean; showIds?: boolean; balances?: boolean; checkSign?: boolean } = {},
): Promise<AccountsRun> {
  let printed = "";
  let stderr = "";
  const write = mock.method(process.stdout, "write", (chunk: unknown) => {
    printed += String(chunk);
    return true;
  });
  const writeError = mock.method(process.stderr, "write", (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  let result: unknown;
  try {
    result = await hre.tasks.getTask(["kms", "accounts"]).run({
      json: args.json ?? false,
      showIds: args.showIds ?? false,
      balances: args.balances ?? false,
      checkSign: args.checkSign ?? false,
    });
  } finally {
    write.mock.restore();
    writeError.mock.restore();
  }
  assert.ok(isResult(result, isReport, isReport), "kms accounts returns a Result of a report");
  const report: AccountsReport = result.success ? result.value : result.error;
  return { success: result.success, accounts: report.accounts, printed, stderr };
}

/** The table's lines, without trailing spaces. */
function lines(printed: string): string[] {
  return printed.split("\n").filter((line) => line !== "");
}

describe("kms accounts", () => {
  it("is a subtask of kms", async () => {
    const { hre } = await runtime();

    assert.ok(hre.tasks.getTask("kms").subtasks.has("accounts"));
  });

  it("lists every key with its provider, source, key id, address and pin, and closes every adapter", async () => {
    process.env.AWS_KMS_KEY_ID = "alias/from-env";
    const { hre, created } = await runtime({
      keys: {
        deployer: vaultKey("deployer", HARDHAT_ACCOUNT_0.address),
        ops: vaultKey("ops"),
      },
      kmsAccounts: ["deployer", vaultKey("inline")],
      kms: "aws",
      adapters: {
        deployer: () => closableAdapter(),
        ops: () => closableAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }),
        "local.kmsAccounts[1]": () => closableAdapter({ identity: "address" }),
        AWS_KMS_KEY_ID: () => closableAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }),
      },
    });

    const run = await accounts(hre);

    assert.equal(run.success, true);
    assert.deepEqual(run.accounts, [
      {
        name: "deployer",
        otherNames: [],
        provider: "myvault",
        source: "kms.keys",
        keyId: "myvault:deployer",
        address: HARDHAT_ACCOUNT_0.address,
        pin: HARDHAT_ACCOUNT_0.address,
        pinStatus: "match",
        error: null,
      },
      {
        name: "ops",
        otherNames: [],
        provider: "myvault",
        source: "kms.keys",
        keyId: "myvault:ops",
        address: COW_ACCOUNT.address,
        pin: null,
        pinStatus: "none",
        error: null,
      },
      {
        name: "local.kmsAccounts[1]",
        otherNames: [],
        provider: "myvault",
        source: "kmsAccounts",
        keyId: "myvault:local.kmsAccounts[1]",
        address: HARDHAT_ACCOUNT_0.address,
        pin: null,
        pinStatus: "none",
        error: null,
      },
      {
        name: "AWS_KMS_KEY_ID",
        otherNames: [],
        provider: "aws",
        source: "--kms",
        keyId: "aws:<AWS_KMS_KEY_ID>",
        region: null,
        profile: null,
        address: COW_ACCOUNT.address,
        pin: null,
        pinStatus: "none",
        error: null,
      },
    ]);
    assert.deepEqual(lines(run.printed), [
      "NAME                  PROVIDER  SOURCE       ADDRESS                                     PIN      KEY ID",
      `deployer              myvault   kms.keys     ${HARDHAT_ACCOUNT_0.address}  matches  myvault:deployer`,
      `ops                   myvault   kms.keys     ${COW_ACCOUNT.address}  none     myvault:ops`,
      `local.kmsAccounts[1]  myvault   kmsAccounts  ${HARDHAT_ACCOUNT_0.address}  none     myvault:local.kmsAccounts[1]`,
      `AWS_KMS_KEY_ID        aws       --kms        ${COW_ACCOUNT.address}  none     aws:<AWS_KMS_KEY_ID>`,
      "Address pins to add to each key's config:",
      `  kms.keys.ops: address: "${COW_ACCOUNT.address}",`,
      `  networks.local.kmsAccounts[1]: address: "${HARDHAT_ACCOUNT_0.address}",`,
    ]);
    assert.equal(run.stderr, "");
    assert.deepEqual(
      created.map((adapter) => adapter.closed),
      [1, 1, 1, 1],
    );
  });

  it("tries every key, shows each failure next to its key and returns a failed result", async () => {
    const { hre, created } = await runtime({
      keys: {
        broken: vaultKey("broken"),
        good: vaultKey("good"),
        unclaimed: vaultKey("unclaimed"),
        unset: { provider: "aws", keyId: configVariable("HHKMS_TEST_UNSET_ID") },
      },
      adapters: {
        broken: () => closableAdapter({ throwError: new Error("socket hang up at 10.0.0.1") }),
        good: () => closableAdapter(),
      },
    });

    const run = await accounts(hre);

    assert.equal(run.success, false);
    assert.deepEqual(
      run.accounts.map((entry) => [entry.name, entry.address]),
      [
        ["broken", null],
        ["good", HARDHAT_ACCOUNT_0.address],
        ["unclaimed", null],
        ["unset", null],
      ],
    );
    const [broken, , unclaimed, unset] = run.accounts;
    // An adapter's own error text can carry request details: only its class name is shown.
    assert.equal(broken?.error?.includes("10.0.0.1"), false, broken?.error ?? "");
    assert.match(broken?.error ?? "", /get public key/);
    assert.match(unclaimed?.error ?? "", /myvault/);
    assert.match(unset?.error ?? "", /HHKMS_TEST_UNSET_ID/);
    assert.equal(unset?.pinStatus, null);

    const printed = lines(run.printed);
    for (const name of ["broken", "unclaimed", "unset"]) {
      const row = printed.findIndex((line) => line.startsWith(`${name} `));
      assert.match(printed[row] ?? "", / FAILED /);
      assert.match(printed[row + 1] ?? "", /^ {2}error: /);
    }
    assert.deepEqual(
      created.map((adapter) => adapter.closed),
      [1, 1],
    );
  });

  it("prints both addresses when a pin does not match", async () => {
    const { hre } = await runtime({
      keys: { deployer: vaultKey("deployer", COW_ACCOUNT.address) },
      adapters: { deployer: () => closableAdapter() },
    });

    const run = await accounts(hre);

    assert.equal(run.success, false);
    const message = `the key derives to ${HARDHAT_ACCOUNT_0.address}, but the configured address is ${COW_ACCOUNT.address}`;
    assert.ok(run.accounts[0]?.error?.includes(message), run.accounts[0]?.error ?? "");
    assert.equal(run.accounts[0]?.pin, COW_ACCOUNT.address);
    assert.ok(run.printed.includes(message), run.printed);
  });

  it("shows a failure on one line under its row, and keeps the message as it is in the JSON", async () => {
    const message = "the vault is sealed.\n  Unseal it, then run again";
    const { hre } = await runtime({
      keys: { deployer: vaultKey("deployer") },
      adapters: {
        deployer: () => closableAdapter({ throwError: new HardhatPluginError("myvault", message) }),
      },
    });

    const run = await accounts(hre);

    assert.equal(run.accounts[0]?.error, message);
    assert.deepEqual(lines(run.printed).slice(1), [
      "deployer  myvault   kms.keys  FAILED   -    myvault:deployer",
      "  error: the vault is sealed. Unseal it, then run again",
    ]);
  });

  it("marks a pin the provider cannot check, and suggests no pin for it", async () => {
    const { hre } = await runtime({
      keys: { deployer: vaultKey("deployer", COW_ACCOUNT.address) },
      adapters: { deployer: () => closableAdapter({ identity: "none" }) },
    });

    const run = await accounts(hre);

    assert.equal(run.success, true);
    assert.equal(run.accounts[0]?.address, COW_ACCOUNT.address);
    assert.equal(run.accounts[0]?.pinStatus, "unchecked");
    assert.match(run.printed, / not checked /);
    assert.equal(run.printed.includes("Address pins"), false);
  });

  describe("key ids", () => {
    it("masks values read from configuration variables", async () => {
      process.env.HHKMS_TEST_DEPLOYER_ID = "alias/secret-deployer";
      const { hre } = await runtime({
        keys: { deployer: { provider: "aws", keyId: configVariable("HHKMS_TEST_DEPLOYER_ID") } },
        adapters: { deployer: () => closableAdapter() },
      });

      for (const json of [false, true]) {
        const run = await accounts(hre, { json });

        assert.equal(run.accounts[0]?.keyId, "aws:<HHKMS_TEST_DEPLOYER_ID>");
        assert.ok(run.printed.includes("aws:<HHKMS_TEST_DEPLOYER_ID>"), run.printed);
        assert.equal(`${run.printed}${run.stderr}`.includes("secret-deployer"), false);
        assert.equal(run.stderr, "");
      }
    });

    it("shows them with --show-ids, after a warning on standard error", async () => {
      process.env.HHKMS_TEST_DEPLOYER_ID = "alias/secret-deployer";
      const { hre } = await runtime({
        keys: {
          deployer: { provider: "aws", keyId: configVariable("HHKMS_TEST_DEPLOYER_ID") },
          gcp: {
            provider: "gcp",
            keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
          },
          azure: { provider: "azure", keyId: "https://v.vault.azure.net/keys/k" },
          vault: vaultKey("vault"),
          unset: { provider: "aws", keyId: configVariable("HHKMS_TEST_UNSET_ID") },
        },
        adapters: {
          deployer: () => closableAdapter(),
          gcp: () => closableAdapter(),
          azure: () => closableAdapter(),
          vault: () => closableAdapter(),
        },
      });

      const run = await accounts(hre, { showIds: true });

      assert.deepEqual(
        run.accounts.map((entry) => entry.keyId),
        [
          "aws:alias/secret-deployer",
          "gcp:projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
          "azure:https://v.vault.azure.net/keys/k",
          // A third-party key has only its display id; an unset variable stays masked.
          "myvault:vault",
          "aws:<HHKMS_TEST_UNSET_ID>",
        ],
      );
      assert.ok(run.printed.includes("aws:alias/secret-deployer"), run.printed);
      assert.match(run.stderr, /^\[hardhat-kms\] --show-ids prints key ids in full[^\n]*\n$/);
    });
  });

  it("shows where AWS keys whose ids read the same are looked up, and endpoints only with --show-ids", async () => {
    const id = { provider: "aws", keyId: "alias/deployer" } as const;
    const { hre } = await runtime({
      keys: {
        plain: id,
        elsewhere: { ...id, region: "eu-west-1" },
        ops: { ...id, profile: "ops" },
        local: { ...id, endpoint: "http://10.0.0.7:4566" },
        other: { provider: "aws", keyId: "alias/other", region: "eu-west-1" },
      },
      adapters: Object.fromEntries(
        ["plain", "elsewhere", "ops", "local", "other"].map((name) => [
          name,
          () => closableAdapter(),
        ]),
      ),
    });

    const run = await accounts(hre);

    assert.deepEqual(
      lines(run.printed)
        .slice(1, 6)
        .map((line) => line.split(/ {2,}/).at(-1)),
      [
        "aws:alias/deployer (region default, profile default, default endpoint)",
        // Every setting that varies among the rows with this id, on each of them.
        "aws:alias/deployer (region eu-west-1, profile default, default endpoint)",
        "aws:alias/deployer (region default, profile ops, default endpoint)",
        "aws:alias/deployer (region default, profile default, custom endpoint)",
        // Its id reads differently, so nothing is added.
        "aws:alias/other",
      ],
    );
    assert.equal(run.printed.includes("10.0.0.7"), false);
    assert.deepEqual(
      run.accounts.map((entry) => [entry.region, entry.profile, "endpoint" in entry]),
      [
        [null, null, false],
        ["eu-west-1", null, false],
        [null, "ops", false],
        [null, null, false],
        ["eu-west-1", null, false],
      ],
    );

    const shown = await accounts(hre, { showIds: true });
    assert.match(
      shown.printed,
      /aws:alias\/deployer \(region default, profile default, endpoint http:\/\/10\.0\.0\.7:4566\)/,
    );
    assert.match(
      shown.printed,
      /aws:alias\/deployer \(region default, profile default, endpoint default\)/,
    );
    assert.deepEqual(
      shown.accounts.map((entry) => entry.endpoint),
      [null, null, null, "http://10.0.0.7:4566", null],
    );
  });

  it("prints JSON with --json and nothing else on standard output", async () => {
    const { hre } = await runtime({
      keys: { deployer: vaultKey("deployer"), broken: vaultKey("broken") },
      adapters: {
        deployer: () => closableAdapter(),
        broken: () => closableAdapter({ throwError: new Error("nope") }),
      },
    });

    const run = await accounts(hre, { json: true });

    const parsed: unknown = JSON.parse(run.printed);
    assert.deepEqual(parsed, { version: 1, accounts: run.accounts });
    assert.deepEqual(Object.keys(run.accounts[0] ?? {}), [
      "name",
      "source",
      "otherNames",
      "provider",
      "keyId",
      "address",
      "pin",
      "pinStatus",
      "error",
    ]);
    assert.equal(run.success, false);
    assert.equal(run.accounts[1]?.address, null);
    assert.equal(typeof run.accounts[1]?.error, "string");
  });

  describe("without --network", () => {
    it("lists a KMS key once under its first name, whatever else names it", async () => {
      process.env.AWS_KMS_KEY_ID = "alias/deployer";
      const { hre, created } = await runtime({
        keys: { deployer: { provider: "aws", keyId: "alias/deployer" } },
        kmsAccounts: ["deployer", { provider: "aws", keyId: "alias/deployer" }],
        otherAccounts: [{ provider: "aws", keyId: "alias/deployer" }],
        kms: "aws",
        adapters: { deployer: () => closableAdapter() },
      });

      const run = await accounts(hre);

      assert.equal(run.success, true);
      assert.deepEqual(run.accounts[0]?.otherNames, [
        { name: "local.kmsAccounts[1]", source: "kmsAccounts" },
        { name: "other.kmsAccounts[0]", source: "kmsAccounts" },
        { name: "AWS_KMS_KEY_ID", source: "--kms" },
      ]);
      assert.equal(run.accounts.length, 1);
      // The other names go on a line of their own, and every config entry gets its pin line.
      assert.deepEqual(lines(run.printed), [
        "NAME      PROVIDER  SOURCE    ADDRESS                                     PIN   KEY ID",
        `deployer  aws       kms.keys  ${HARDHAT_ACCOUNT_0.address}  none  aws:alias/deployer`,
        "  also: local.kmsAccounts[1], other.kmsAccounts[0], AWS_KMS_KEY_ID",
        "Address pins to add to each key's config:",
        `  kms.keys.deployer: address: "${HARDHAT_ACCOUNT_0.address}",`,
        `  networks.local.kmsAccounts[1]: address: "${HARDHAT_ACCOUNT_0.address}",`,
        `  networks.other.kmsAccounts[0]: address: "${HARDHAT_ACCOUNT_0.address}",`,
      ]);
      assert.equal(created.length, 1);
    });

    it("keeps keys apart when their pin, region or provider differ", async () => {
      const { hre } = await runtime({
        keys: {
          plain: { provider: "aws", keyId: "alias/deployer" },
          pinned: { provider: "aws", keyId: "alias/deployer", address: HARDHAT_ACCOUNT_0.address },
          elsewhere: { provider: "aws", keyId: "alias/deployer", region: "eu-west-1" },
          vaultA: vaultKey("same"),
          vaultB: vaultKey("same"),
        },
        adapters: {
          plain: () => closableAdapter(),
          pinned: () => closableAdapter(),
          elsewhere: () => closableAdapter(),
          vaultA: () => closableAdapter(),
          vaultB: () => closableAdapter(),
        },
      });

      const run = await accounts(hre);

      assert.deepEqual(
        run.accounts.map((entry) => entry.name),
        ["plain", "pinned", "elsewhere", "vaultA", "vaultB"],
      );
    });
  });

  describe("with --network", () => {
    it("lists that network's keys in order, then the --kms keys, without merging them", async () => {
      process.env.AWS_KMS_KEY_ID = "alias/deployer";
      const { hre } = await runtime({
        keys: { deployer: { provider: "aws", keyId: "alias/deployer" }, ops: vaultKey("ops") },
        kmsAccounts: [{ provider: "aws", keyId: "alias/deployer" }, "deployer"],
        otherAccounts: ["ops"],
        kms: "aws",
        network: "local",
        adapters: {
          deployer: () => closableAdapter(),
          "local.kmsAccounts[0]": () => closableAdapter(),
          AWS_KMS_KEY_ID: () => closableAdapter(),
        },
      });

      const run = await accounts(hre);

      assert.deepEqual(
        run.accounts.map((entry) => [entry.name, entry.source]),
        [
          ["local.kmsAccounts[0]", "kmsAccounts"],
          ["deployer", "kms.keys"],
          ["AWS_KMS_KEY_ID", "--kms"],
        ],
      );
      assert.equal(run.success, true);
      assert.equal(
        run.stderr,
        "[hardhat-kms] AWS_KMS_KEY_ID names the same KMS key as local.kmsAccounts[0]; connections to local refuse two entries for one key, so use one of them.\n",
      );
    });

    it("lists only the --kms keys of a network without kmsAccounts", async () => {
      process.env.AWS_KMS_KEY_ID = "alias/deployer";
      const { hre } = await runtime({
        keys: { ops: vaultKey("ops") },
        kms: "aws",
        network: "other",
        adapters: { AWS_KMS_KEY_ID: () => closableAdapter() },
      });

      const run = await accounts(hre);

      assert.deepEqual(
        run.accounts.map((entry) => entry.name),
        ["AWS_KMS_KEY_ID"],
      );
    });

    it("refuses a network that is not configured", async () => {
      const { hre } = await runtime({ network: "nowhere" });

      await assert.rejects(
        accounts(hre),
        (error: unknown) =>
          error instanceof HardhatPluginError &&
          error.message.includes('unknown network "nowhere"'),
      );
    });
  });

  it("says how to add keys when none are configured", async () => {
    const { hre } = await runtime();

    const run = await accounts(hre);
    assert.equal(run.success, true);
    assert.deepEqual(run.accounts, []);
    assert.equal(run.printed, "");
    assert.match(run.stderr, /no KMS keys are configured/);

    assert.equal(
      (await accounts(hre, { json: true })).printed,
      '{\n  "version": 1,\n  "accounts": []\n}\n',
    );
  });

  it("asks the KMS about at most 8 keys at once", async () => {
    let inFlight = 0;
    let most = 0;
    const slow = (): ClosableAdapter => {
      const adapter = closableAdapter();
      const getPublicKey = adapter.getPublicKey?.bind(adapter);
      assert.ok(getPublicKey !== undefined);
      adapter.getPublicKey = async (ctx) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return await getPublicKey(ctx);
      };
      return adapter;
    };
    const names = Array.from({ length: 20 }, (_, index) => `key${index}`);
    const { hre, created } = await runtime({
      keys: Object.fromEntries(names.map((name) => [name, vaultKey(name)])),
      adapters: Object.fromEntries(names.map((name) => [name, slow])),
    });

    const run = await accounts(hre);

    assert.equal(run.accounts.length, 20);
    assert.deepEqual(
      run.accounts.map((entry) => entry.name),
      names,
    );
    assert.equal(most, 8);
    assert.equal(
      created.every((adapter) => adapter.closed === 1),
      true,
    );
  });

  describe("--balances", () => {
    it("is refused without --network, with a message that names --network", async () => {
      const { hre, created } = await runtime({
        keys: { deployer: vaultKey("deployer") },
        adapters: { deployer: () => closableAdapter() },
      });

      await assert.rejects(
        accounts(hre, { balances: true }),
        (error: unknown) =>
          error instanceof HardhatPluginError &&
          error.message.includes("--balances reads balances on one network: pass --network"),
      );
      // Refused before any key is opened.
      assert.equal(created.length, 0);
    });

    it("shows kms.simulatedBalance for each key of a simulated network", async () => {
      const balance = 1_500_000_000_000_000_001n;
      const { hre } = await runtime({
        kmsAccounts: [vaultKey("deployer"), vaultKey("ops")],
        network: "local",
        simulatedBalance: balance,
        adapters: {
          "local.kmsAccounts[0]": () => closableAdapter(),
          "local.kmsAccounts[1]": () => closableAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }),
        },
      });

      const connections = countConnections(hre);

      const run = await accounts(hre, { balances: true });

      assert.equal(run.success, true, run.printed);
      // The task closes the connection it opened for the balances.
      assert.deepEqual(connections, { opened: 1, closed: 1 });
      assert.deepEqual(
        run.accounts.map((entry) => [entry.address, entry.balance]),
        [
          [HARDHAT_ACCOUNT_0.address, balance.toString()],
          [COW_ACCOUNT.address, balance.toString()],
        ],
      );
      assert.deepEqual(lines(run.printed).slice(0, 3), [
        "NAME                  PROVIDER  SOURCE       ADDRESS                                     PIN   BALANCE (ETH)         KEY ID",
        `local.kmsAccounts[0]  myvault   kmsAccounts  ${HARDHAT_ACCOUNT_0.address}  none  1.500000000000000001  myvault:local.kmsAccounts[0]`,
        `local.kmsAccounts[1]  myvault   kmsAccounts  ${COW_ACCOUNT.address}  none  1.500000000000000001  myvault:local.kmsAccounts[1]`,
      ]);

      const json = await accounts(hre, { json: true, balances: true });
      const parsed: unknown = JSON.parse(json.printed);
      assert.deepEqual(parsed, { version: 1, accounts: json.accounts });
      assert.deepEqual(Object.keys(json.accounts[0] ?? {}), [
        "name",
        "source",
        "otherNames",
        "provider",
        "keyId",
        "address",
        "pin",
        "pinStatus",
        "balance",
        "error",
      ]);
    });

    it("fails only the row whose balance cannot be read", async () => {
      const { hre } = await runtime({
        kmsAccounts: [vaultKey("deployer"), vaultKey("ops")],
        network: "local",
        adapters: {
          "local.kmsAccounts[0]": () => closableAdapter(),
          "local.kmsAccounts[1]": () => closableAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }),
        },
      });
      hre.hooks.registerHandlers("network", {
        onRequest: async (context, connection, request, next) => {
          const [address]: unknown[] = Array.isArray(request.params) ? request.params : [];
          if (request.method === "eth_getBalance" && address === COW_ACCOUNT.address) {
            // Not a hex quantity.
            return { jsonrpc: "2.0", id: request.id, result: 12 };
          }
          return await next(context, connection, request);
        },
      });

      const connections = countConnections(hre);

      const run = await accounts(hre, { balances: true, checkSign: true });

      assert.equal(run.success, false);
      assert.deepEqual(connections, { opened: 1, closed: 1 });
      const [deployer, ops] = run.accounts;
      assert.equal(deployer?.error, null);
      assert.equal(typeof deployer?.balance, "string");
      assert.equal(deployer?.signCheck, "ok");
      assert.equal(ops?.balance, null);
      // The sign check still ran on the failed row.
      assert.equal(ops?.signCheck, "ok");
      assert.equal(ops?.address, COW_ACCOUNT.address);
      assert.equal(
        ops?.error,
        "could not read the balance: eth_getBalance: the node answered eth_getBalance with number, not a hex quantity",
      );
      const printed = lines(run.printed);
      const row = printed.findIndex((line) => line.startsWith("local.kmsAccounts[1] "));
      assert.match(printed[row] ?? "", / none {2}FAILED {9,}ok /);
      assert.match(printed[row + 1] ?? "", /^ {2}error: could not read the balance: /);
    });

    it("keeps its result when closing the balance connection fails", async () => {
      const { hre } = await runtime({
        kmsAccounts: [vaultKey("deployer")],
        network: "local",
        adapters: { "local.kmsAccounts[0]": () => closableAdapter() },
      });
      let closes = 0;
      hre.hooks.registerHandlers("network", {
        closeConnection: async (context, connection, next) => {
          closes++;
          await next(context, connection);
          throw new Error("close failed");
        },
      });

      const run = await accounts(hre, { balances: true });

      assert.equal(closes, 1);
      assert.equal(run.success, true, run.printed);
      assert.equal(run.accounts[0]?.error, null);
      assert.equal(typeof run.accounts[0]?.balance, "string");
    });

    it("fails every row's balance, and still checks the keys, when the network cannot be reached", async () => {
      const { hre } = await runtime({
        otherAccounts: [vaultKey("deployer")],
        network: "other",
        adapters: { "other.kmsAccounts[0]": () => closableAdapter() },
      });

      const run = await accounts(hre, { balances: true, checkSign: true });

      assert.equal(run.success, false);
      assert.equal(run.accounts[0]?.address, HARDHAT_ACCOUNT_0.address);
      assert.equal(run.accounts[0]?.signCheck, "ok");
      assert.equal(run.accounts[0]?.balance, null);
      assert.match(run.accounts[0]?.error ?? "", /^could not read the balance: /);
    });

    it("fails every row's balance when opening the connection fails", async () => {
      // Funding a simulated network's accounts needs every key; the broken one fails the connection.
      const { hre } = await runtime({
        kmsAccounts: [vaultKey("deployer"), vaultKey("broken")],
        network: "local",
        simulatedBalance: 1n,
        adapters: {
          "local.kmsAccounts[0]": () => closableAdapter(),
          "local.kmsAccounts[1]": () => closableAdapter({ throwError: new Error("nope") }),
        },
      });

      const run = await accounts(hre, { balances: true });

      assert.equal(run.success, false);
      const [deployer, broken] = run.accounts;
      assert.equal(deployer?.address, HARDHAT_ACCOUNT_0.address);
      assert.equal(deployer?.balance, null);
      assert.match(deployer?.error ?? "", /^could not read the balance: .*get public key/);
      // A key that fails first shows its own error, and its checks show "-".
      assert.equal(broken?.balance, null);
      assert.match(broken?.error ?? "", /get public key/);
      const printed = lines(run.printed);
      assert.match(
        printed.find((line) => line.startsWith("local.kmsAccounts[1] ")) ?? "",
        / - {2,}- /,
      );
    });
  });

  describe("--check-sign", () => {
    it("has each key sign a random EIP-191 message once, with no extra public key read", async () => {
      const signed: string[] = [];
      const { hre, created } = await runtime({
        keys: { deployer: vaultKey("deployer"), ops: vaultKey("ops") },
        adapters: {
          deployer: () => closableAdapter(),
          ops: messageAdapter(signed, { secretKey: hex(COW_ACCOUNT.secretKey) }),
        },
      });

      const run = await accounts(hre, { checkSign: true });

      assert.equal(run.success, true, run.printed);
      assert.deepEqual(
        run.accounts.map((entry) => [entry.name, entry.signCheck, entry.error]),
        [
          ["deployer", "ok", null],
          ["ops", "ok", null],
        ],
      );
      // One signature per key, and the public key read for the address is reused to check it.
      assert.deepEqual(
        created.map((adapter) => [adapter.calls.signDigest, adapter.calls.getPublicKey]),
        [
          [1, 1],
          [1, 1],
        ],
      );
      assert.equal(signed.length, 1);
      assert.match(signed[0] ?? "", /^hardhat-kms check-sign [0-9a-f]{64}$/);
      assert.deepEqual(lines(run.printed).slice(0, 3), [
        "NAME      PROVIDER  SOURCE    ADDRESS                                     PIN   SIGN  KEY ID",
        `deployer  myvault   kms.keys  ${HARDHAT_ACCOUNT_0.address}  none  ok    myvault:deployer`,
        `ops       myvault   kms.keys  ${COW_ACCOUNT.address}  none  ok    myvault:ops`,
      ]);
    });

    it("signs a different message each run", async () => {
      const signed: string[] = [];
      const { hre } = await runtime({
        keys: { deployer: vaultKey("deployer") },
        adapters: { deployer: messageAdapter(signed) },
      });

      await accounts(hre, { checkSign: true });
      await accounts(hre, { checkSign: true });

      assert.equal(signed.length, 2);
      assert.notEqual(signed[0], signed[1]);
    });

    it("prints no signature on standard output, in the table or in JSON", async () => {
      const seen: string[] = [];
      const { hre } = await runtime({
        kmsAccounts: [vaultKey("deployer")],
        network: "local",
        simulatedBalance: 10n ** 18n,
        adapters: { "local.kmsAccounts[0]": signatureRecorder(seen) },
      });

      for (const json of [false, true]) {
        seen.length = 0;
        const run = await accounts(hre, { json, balances: true, checkSign: true });

        // The task's adapter signed once: its r and s appear nowhere, in any case.
        assert.equal(seen.length, 2);
        const report = JSON.stringify({ version: 1, accounts: run.accounts }).toLowerCase();
        for (const value of seen) {
          assert.equal(run.printed.toLowerCase().includes(value), false, "r or s on stdout");
          assert.equal(run.stderr.toLowerCase().includes(value), false, "r or s on stderr");
          assert.equal(report.includes(value), false, "r or s in the report");
        }

        assert.equal(run.success, true, run.printed);
        assert.equal(run.accounts[0]?.signCheck, "ok");
        // A 65-byte signature is 130 hex digits; nothing that long is printed or returned.
        assert.doesNotMatch(run.printed, /[0-9a-fA-F]{130}/);
        assert.doesNotMatch(run.stderr, /[0-9a-fA-F]{130}/);
        assert.doesNotMatch(JSON.stringify(run.accounts), /[0-9a-fA-F]{130}/);
        assert.deepEqual(Object.keys(run.accounts[0] ?? {}).slice(-3), [
          "balance",
          "signCheck",
          "error",
        ]);
      }
    });

    it("fails only the row of a key that refuses to sign, and returns a failed result", async () => {
      const { hre } = await runtime({
        keys: {
          deployer: vaultKey("deployer"),
          refusing: vaultKey("refusing"),
          ops: vaultKey("ops"),
        },
        adapters: {
          deployer: () => closableAdapter(),
          refusing,
          ops: () => closableAdapter({ secretKey: hex(COW_ACCOUNT.secretKey) }),
        },
      });

      const run = await accounts(hre, { checkSign: true });

      assert.equal(run.success, false);
      assert.deepEqual(
        run.accounts.map((entry) => [entry.name, entry.signCheck, entry.address]),
        [
          ["deployer", "ok", HARDHAT_ACCOUNT_0.address],
          ["refusing", null, COW_ACCOUNT.address],
          ["ops", "ok", COW_ACCOUNT.address],
        ],
      );
      const refused = run.accounts[1]?.error ?? "";
      assert.match(
        refused,
        /^the sign check failed: fake, sign, key myvault:refusing: the provider call failed /,
      );
      assert.equal(refused.includes("10.0.0.1"), false, refused);
      assert.equal(run.accounts[0]?.error, null);
      assert.equal(run.accounts[2]?.error, null);
      const printed = lines(run.printed);
      const row = printed.findIndex((line) => line.startsWith("refusing "));
      assert.match(printed[row] ?? "", / none {2}FAILED {2}/);
      assert.match(printed[row + 1] ?? "", /^ {2}error: the sign check failed: /);
    });

    it("fails the row of a key whose signature is from another key", async () => {
      const { hre } = await runtime({
        keys: { deployer: vaultKey("deployer") },
        adapters: {
          deployer: () => closableAdapter({ signWithSecretKey: hex(COW_ACCOUNT.secretKey) }),
        },
      });

      const run = await accounts(hre, { checkSign: true, json: true });

      assert.equal(run.success, false);
      assert.equal(run.accounts[0]?.signCheck, null);
      assert.match(run.accounts[0]?.error ?? "", /^the sign check failed: /);
    });

    it("turns a pin that was not checked into a match once the key signs", async () => {
      const { hre } = await runtime({
        keys: { deployer: vaultKey("deployer", HARDHAT_ACCOUNT_0.address) },
        adapters: { deployer: () => closableAdapter({ identity: "none" }) },
      });

      const plain = await accounts(hre);
      assert.equal(plain.accounts[0]?.pinStatus, "unchecked");

      const run = await accounts(hre, { checkSign: true });

      assert.equal(run.success, true);
      assert.equal(run.accounts[0]?.pinStatus, "match");
      assert.equal(run.accounts[0]?.signCheck, "ok");
      assert.match(run.printed, / matches {2}ok /);
    });

    it("fails a pin that was not checked when the key signs as another address", async () => {
      const { hre } = await runtime({
        keys: { deployer: vaultKey("deployer", COW_ACCOUNT.address) },
        adapters: { deployer: () => closableAdapter({ identity: "none" }) },
      });

      const run = await accounts(hre, { checkSign: true });

      assert.equal(run.success, false);
      assert.equal(run.accounts[0]?.pinStatus, "unchecked");
      assert.equal(run.accounts[0]?.signCheck, null);
      assert.match(run.accounts[0]?.error ?? "", /^the sign check failed: /);
    });

    it("skips the checks of a key that failed, and shows - for them", async () => {
      const { hre } = await runtime({
        keys: { broken: vaultKey("broken") },
        adapters: { broken: () => closableAdapter({ throwError: new Error("nope") }) },
      });

      const run = await accounts(hre, { checkSign: true });

      assert.equal(run.success, false);
      assert.equal(run.accounts[0]?.signCheck, null);
      assert.equal(run.accounts[0]?.error?.startsWith("the sign check failed"), false);
      assert.match(lines(run.printed)[1] ?? "", /^broken +myvault +kms\.keys +FAILED +- +- /);
    });
  });
});
