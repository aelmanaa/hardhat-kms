import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import { HardhatPluginError } from "hardhat/plugins";
import { isResult } from "hardhat/utils/result";

import hardhatKms from "../../src/index.ts";
import type { AccountEntry, AccountsReport } from "../../src/internal/tasks/accounts.ts";
import type { KmsKeyUserConfig } from "../../src/types.ts";
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
  } = {},
) {
  const hre = await createHardhatRuntimeEnvironment(
    {
      plugins: [hardhatKms],
      kms: { keys: options.keys ?? {} },
      networks: {
        local: { type: "edr-simulated", kmsAccounts: options.kmsAccounts ?? [] },
        other: {
          type: "http",
          url: "http://127.0.0.1:1",
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
  args: { json?: boolean; showIds?: boolean } = {},
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
    result = await hre.tasks
      .getTask(["kms", "accounts"])
      .run({ json: args.json ?? false, showIds: args.showIds ?? false });
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
    assert.deepEqual(parsed, { accounts: run.accounts });
    assert.deepEqual(Object.keys(run.accounts[0] ?? {}), [
      "name",
      "otherNames",
      "provider",
      "source",
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
      assert.deepEqual(
        run.accounts.map((entry) => [entry.name, entry.otherNames]),
        [["deployer", ["local.kmsAccounts[1]", "other.kmsAccounts[0]", "AWS_KMS_KEY_ID"]]],
      );
      assert.match(
        lines(run.printed)[1] ?? "",
        /^deployer, local\.kmsAccounts\[1\], other\.kmsAccounts\[0\], AWS_KMS_KEY_ID {2}aws/,
      );
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

    assert.equal((await accounts(hre, { json: true })).printed, '{\n  "accounts": []\n}\n');
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
});
