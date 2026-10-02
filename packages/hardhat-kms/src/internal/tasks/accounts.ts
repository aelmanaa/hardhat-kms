import { HardhatError } from "@nomicfoundation/hardhat-errors";
import { HardhatPluginError } from "hardhat/plugins";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { NetworkConnection } from "hardhat/types/network";
import type { NewTaskActionFunction } from "hardhat/types/tasks";
import type { Result } from "hardhat/types/utils";
import { errorResult, successfulResult } from "hardhat/utils/result";

import type { KmsKeyConfig } from "../../types.ts";
import { keyIdentity } from "../config/key-identity.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError, catalogMessage, errorName } from "../errors.ts";
import { commandLineKeys } from "../hook-handlers/hre.ts";
import type { KmsSigner } from "../signer/kms-signer.ts";
import { checkSignMessage, formatEther, parseBalance } from "./account-checks.ts";
import { printLine, printNote, type TaskKey, taskKeys, withTaskSigners } from "./keys.ts";

/** How many keys `kms accounts` asks the KMS about at once. */
const ACCOUNTS_CONCURRENCY = 8;

/** The arguments of `kms accounts`. */
interface AccountsArguments {
  json: boolean;
  showIds: boolean;
  balances: boolean;
  checkSign: boolean;
}

/** Where a key listed by `kms accounts` is defined. */
export type AccountSource = "kms.keys" | "kmsAccounts" | "--kms";

/** A name a key goes by, and where that entry is defined. */
export interface AccountName {
  /** The name a task takes for this entry. */
  name: string;
  source: AccountSource;
}

/** One key in the output of `kms accounts`. */
export interface AccountEntry extends AccountName {
  /**
   * Other entries for the same KMS key with the same pin, listed in this row without `--network`.
   */
  otherNames: AccountName[];
  provider: string;
  /**
   * The key id. Values read from configuration variables show as `<VARIABLE_NAME>` unless
   * `--show-ids` is given. A merged row shows the id of its first entry.
   */
  keyId: string;
  /** AWS keys only: the configured region, or `null` for the SDK's default. */
  region?: string | null;
  /** AWS keys only: the configured profile, or `null` for the SDK's default. */
  profile?: string | null;
  /** AWS keys only, and only with `--show-ids`: the configured endpoint, or `null`. */
  endpoint?: string | null;
  /** The EIP-55 address, or `null` if the key failed. */
  address: string | null;
  /** The configured `address` pin, or `null`. */
  pin: string | null;
  /**
   * `match`: the KMS confirmed the pin. `none`: no pin. `unchecked`: the provider cannot report the
   * address, so `address` is the pin. `null` if the key failed.
   */
  pinStatus: "match" | "none" | "unchecked" | null;
  /**
   * Only with `--balances`: the address's balance on the `--network` network, in wei, as a decimal
   * string, or `null` if the key or the read failed.
   */
  balance?: string | null;
  /**
   * Only with `--check-sign`: `ok` when the key signed a random EIP-191 message and the signature
   * recovered to its address, or `null` if the key or the signature failed.
   */
  signCheck?: "ok" | null;
  /**
   * Why the key failed, or `null`. A pin mismatch names both addresses. A failed balance read and a
   * failed sign check are each described, separated by `; `.
   */
  error: string | null;
}

/**
 * What `kms accounts` returns, in a successful result or, if any key failed, a failed one, and
 * what `--json` prints.
 */
export interface AccountsReport {
  /** The version of this shape. */
  version: 1;
  accounts: AccountEntry[];
}

/** A key to list, with the other entries that name the same KMS key. */
interface ListedKey {
  task: TaskKey;
  others: TaskKey[];
}

/** How `--balances` reads a balance: a connection to the network, or why there is none. */
type BalanceSource =
  | { kind: "off" }
  | { kind: "connected"; connection: NetworkConnection }
  | { kind: "failed"; reason: string };

/**
 * `kms accounts`: lists every configured key with its provider, source, key id and address, and
 * checks that each one is reachable and matches its `address` pin. With `--network`, it lists
 * that network's keys; without it, every key, each KMS key once. `--balances` adds each address's
 * balance on the `--network` network, and `--check-sign` has each key sign a random EIP-191
 * message, which proves the credentials may sign and not only read the public key.
 *
 * Every key is tried, and a failure is shown next to its key. The task returns a failed result
 * if any key failed, which makes the Hardhat CLI exit with code 1.
 *
 * @param args - The task arguments.
 * @param hre - The Hardhat runtime.
 * @returns The entries, in a successful result, or in a failed one if any key failed.
 */
const kmsAccounts: NewTaskActionFunction<AccountsArguments> = async (
  { json, showIds, balances, checkSign },
  hre,
) => {
  const network = hre.globalOptions.network;
  if (balances && network === undefined) {
    throw catalogError(ERRORS.balancesNeedNetwork, {}, { operation: "kms accounts" });
  }
  if (showIds) {
    printNote(
      "--show-ids prints key ids in full, including values read from configuration variables. Check the output before you share it.",
    );
  }
  const listed =
    network === undefined ? await distinctKeys(taskKeys(hre)) : await networkKeys(hre, network);
  const source: BalanceSource =
    balances && network !== undefined ? await connect(hre, network) : { kind: "off" };
  try {
    return await listAccounts(hre, listed, { json, showIds, checkSign, source });
  } finally {
    if (source.kind === "connected") {
      await source.connection.close();
    }
  }
};

export default kmsAccounts;

/**
 * Opens the connection `--balances` reads from. Opening it runs the network hook, which may call
 * the KMS, for example to fund a simulated network's accounts; if that fails, every row's balance
 * read fails with the reason, and the other checks still run.
 */
async function connect(hre: HardhatRuntimeEnvironment, network: string): Promise<BalanceSource> {
  try {
    return { kind: "connected", connection: await hre.network.create(network) };
  } catch (error) {
    return { kind: "failed", reason: describeError(error) };
  }
}

/** Checks and prints the listed keys. */
async function listAccounts(
  hre: HardhatRuntimeEnvironment,
  listed: ListedKey[],
  options: { json: boolean; showIds: boolean; checkSign: boolean; source: BalanceSource },
): Promise<Result<AccountsReport, AccountsReport>> {
  const { json, showIds, checkSign, source } = options;
  const rows = await withTaskSigners(
    hre,
    async (signerFor) =>
      await mapWithLimit(listed, ACCOUNTS_CONCURRENCY, async ({ task, others }) => {
        const entry: AccountEntry = {
          name: task.name,
          source: task.source,
          otherNames: others.map((other) => ({ name: other.name, source: other.source })),
          provider: task.key.provider,
          keyId: showIds ? await revealedId(task.key) : task.key.displayId,
          ...awsLocation(task.key, showIds),
          address: null,
          pin: task.key.address ?? null,
          pinStatus: null,
          ...(source.kind === "off" ? {} : { balance: null }),
          ...(checkSign ? { signCheck: null } : {}),
          error: null,
        };
        let signer: KmsSigner;
        try {
          signer = await signerFor(task.key);
          const { address, confirmed } = await signer.confirmedAddress();
          entry.address = address;
          entry.pinStatus = confirmed ? (entry.pin === null ? "none" : "match") : "unchecked";
        } catch (error) {
          entry.error = describeError(error);
          return { entry, key: task.key };
        }
        const failures: string[] = [];
        if (source.kind === "failed") {
          failures.push(catalogMessage(ERRORS.balanceReadFailed, { reason: source.reason }));
        } else if (source.kind === "connected") {
          try {
            entry.balance = (await readBalance(source.connection, entry.address)).toString();
          } catch (error) {
            failures.push(
              catalogMessage(ERRORS.balanceReadFailed, { reason: describeError(error) }),
            );
          }
        }
        if (checkSign) {
          try {
            // The signer checks that the signature recovers to the key's address before it
            // returns it. The signature itself is dropped: it is never printed or returned.
            await signer.signPersonalMessage(checkSignMessage());
            entry.signCheck = "ok";
            // A pin the provider could not report is the address the signature recovered to.
            if (entry.pinStatus === "unchecked") {
              entry.pinStatus = "match";
            }
          } catch (error) {
            failures.push(catalogMessage(ERRORS.checkSignFailed, { reason: describeError(error) }));
          }
        }
        entry.error = failures.length === 0 ? null : failures.join("; ");
        return { entry, key: task.key };
      }),
  );
  const accounts = rows.map(({ entry }) => entry);

  const report: AccountsReport = { version: 1, accounts };
  if (json) {
    printLine(JSON.stringify(report, null, 2));
  } else {
    printTable(accounts, keyIdCells(rows, showIds), {
      balances: source.kind !== "off",
      checkSign,
    });
  }
  return accounts.some((entry) => entry.error !== null)
    ? errorResult(report)
    : successfulResult(report);
}

/** Reads an address's balance in wei on the `--balances` connection. */
async function readBalance(connection: NetworkConnection, address: string): Promise<bigint> {
  return parseBalance(
    await connection.provider.request({
      method: "eth_getBalance",
      params: [address, "latest"],
    }),
  );
}

/**
 * The keys of one network: its `kmsAccounts`, then the `--kms` keys, which belong to the selected
 * network. A key is named as a task names it. A `--kms` key that repeats one of the network's keys
 * gets a note, since a connection to the network refuses the pair.
 */
async function networkKeys(hre: HardhatRuntimeEnvironment, name: string): Promise<ListedKey[]> {
  const config = hre.config.networks[name];
  if (config === undefined) {
    throw catalogError(ERRORS.unknownNetwork, { name });
  }
  const named = new Set(Object.values(hre.config.kms.keys));
  const fromConfig = config.kmsAccounts.map((key): TaskKey => ({
    name: key.name,
    source: named.has(key) ? "kms.keys" : "kmsAccounts",
    key,
  }));
  const fromCommandLine = commandLineKeys(hre).map((key): TaskKey => ({
    name: key.name,
    source: "--kms",
    key,
  }));
  const configIds = await Promise.all(fromConfig.map(async ({ key }) => await identityOf(key)));
  for (const task of fromCommandLine) {
    const id = await identityOf(task.key);
    const repeated = id === undefined ? undefined : fromConfig[configIds.indexOf(id)];
    if (repeated !== undefined) {
      printNote(
        `${task.name} names the same KMS key as ${repeated.name}; connections to ${name} refuse two entries for one key, so use one of them.`,
      );
    }
  }
  return [...fromConfig, ...fromCommandLine].map((task) => ({ task, others: [] }));
}

/** A key's identity, or `undefined` for a third-party key or one whose identifier cannot be read. */
async function identityOf(key: KmsKeyConfig): Promise<string | undefined> {
  try {
    return await keyIdentity(key);
  } catch {
    return undefined;
  }
}

/**
 * Lists each KMS key once: keys with the same identity and the same pin are one entry, under the
 * first name, with the others in `otherNames`. Keys of third-party providers, and keys whose
 * identifier cannot be read, are never merged; reading them fails again when they are resolved.
 */
async function distinctKeys(keys: TaskKey[]): Promise<ListedKey[]> {
  const identities = await Promise.all(
    keys.map(async ({ key }) => {
      const identity = await identityOf(key);
      return identity === undefined ? undefined : `${identity}\0${key.address ?? ""}`;
    }),
  );
  const listed: ListedKey[] = [];
  const byIdentity = new Map<string, ListedKey>();
  keys.forEach((task, index) => {
    const identity = identities[index];
    const existing = identity === undefined ? undefined : byIdentity.get(identity);
    if (existing !== undefined) {
      existing.others.push(task);
      return;
    }
    const entry: ListedKey = { task, others: [] };
    listed.push(entry);
    if (identity !== undefined) {
      byIdentity.set(identity, entry);
    }
  });
  return listed;
}

/**
 * Where an AWS key is looked up: its region and profile, and with `--show-ids` its endpoint, which
 * can be an internal URL. Empty for other providers.
 */
function awsLocation(
  key: KmsKeyConfig,
  showIds: boolean,
): Pick<AccountEntry, "region" | "profile" | "endpoint"> {
  if (key.provider !== "aws") {
    return {};
  }
  return {
    region: key.region ?? null,
    profile: key.profile ?? null,
    ...(showIds ? { endpoint: key.endpoint ?? null } : {}),
  };
}

/**
 * The KEY ID column. Rows whose ids read the same but whose AWS keys are looked up in different
 * places get the differing settings after the id. Without `--show-ids`, an endpoint shows only as
 * custom or default.
 */
function keyIdCells(
  rows: Array<{ entry: AccountEntry; key: KmsKeyConfig }>,
  showIds: boolean,
): string[] {
  const location = (key: KmsKeyConfig): Map<string, string> =>
    new Map(
      key.provider === "aws"
        ? [
            ["region", `region ${key.region ?? "default"}`],
            ["profile", `profile ${key.profile ?? "default"}`],
            [
              "endpoint",
              showIds
                ? `endpoint ${key.endpoint ?? "default"}`
                : key.endpoint === undefined
                  ? "default endpoint"
                  : "custom endpoint",
            ],
          ]
        : [],
    );
  return rows.map(({ entry, key }) => {
    const mine = location(key);
    const twins = rows
      .filter((other) => other.entry !== entry && other.entry.keyId === entry.keyId)
      .map((other) => location(other.key));
    const differing = [...mine].filter(([field, text]) =>
      twins.some((twin) => twin.has(field) && twin.get(field) !== text),
    );
    return differing.length === 0
      ? entry.keyId
      : `${entry.keyId} (${differing.map(([, text]) => text).join(", ")})`;
  });
}

/** The key id with configuration variables read, for `--show-ids`. */
async function revealedId(key: KmsKeyConfig): Promise<string> {
  try {
    if ("keyVersionName" in key) {
      return `gcp:${await key.keyVersionName.get()}`;
    }
    if (key.provider === "aws" || key.provider === "azure") {
      return `${key.provider}:${await key.keyId.get()}`;
    }
  } catch {
    // The variable is unset or invalid; the key's own error says so.
  }
  return key.displayId;
}

/**
 * Describes a failure in words that are safe to print: the plugin's and Hardhat's errors are
 * written for users and carry no identifier values, while other errors could carry request details,
 * so only their class name is shown.
 */
function describeError(error: unknown): string {
  if (error instanceof HardhatPluginError || HardhatError.isHardhatError(error)) {
    return error.message;
  }
  return `failed with ${errorName(error)}`;
}

/** Runs `run` on every item, at most `limit` at a time, and keeps the items' order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  // The workers share one iterator, so each item is taken once.
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) {
      results[index] = await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The text of the PIN column. */
const PIN_LABELS: Record<NonNullable<AccountEntry["pinStatus"]>, string> = {
  match: "matches",
  none: "none",
  unchecked: "not checked",
};

/**
 * Prints the accounts as a table on standard output, with a key's other names and its failure on
 * the lines under it, then an `address` line to paste into each config entry of a key that has no
 * pin.
 */
function printTable(
  accounts: AccountEntry[],
  keyIds: string[],
  columns: { balances: boolean; checkSign: boolean },
): void {
  if (accounts.length === 0) {
    printNote(
      "no KMS keys are configured: add them to kms.keys or a network's kmsAccounts, or pass --kms.",
    );
    return;
  }
  const header = [
    "NAME",
    "PROVIDER",
    "SOURCE",
    "ADDRESS",
    "PIN",
    ...(columns.balances ? ["BALANCE (ETH)"] : []),
    ...(columns.checkSign ? ["SIGN"] : []),
    "KEY ID",
  ];
  // A check that did not run, because the key failed first, shows `-`.
  const checkCell = (entry: AccountEntry, value: string | undefined): string =>
    value ?? (entry.address === null ? "-" : "FAILED");
  const rows = accounts.map((entry, index) => [
    entry.name,
    entry.provider,
    entry.source,
    entry.address ?? "FAILED",
    entry.pinStatus === null ? "-" : PIN_LABELS[entry.pinStatus],
    ...(columns.balances
      ? [
          checkCell(
            entry,
            typeof entry.balance === "string" ? formatEther(BigInt(entry.balance)) : undefined,
          ),
        ]
      : []),
    ...(columns.checkSign ? [checkCell(entry, entry.signCheck ?? undefined)] : []),
    keyIds[index] ?? entry.keyId,
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const format = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  printLine(format(header));
  accounts.forEach((entry, index) => {
    printLine(format(rows[index] ?? []));
    if (entry.otherNames.length > 0) {
      printLine(`  also: ${entry.otherNames.map(({ name }) => name).join(", ")}`);
    }
    if (entry.error !== null) {
      printLine(`  error: ${entry.error}`);
    }
  });

  const pins = accounts.flatMap((entry) =>
    entry.pinStatus === "none" && entry.address !== null
      ? [entry, ...entry.otherNames].flatMap((named) => {
          const path = configPath(named);
          return path === undefined ? [] : [`  ${path}: address: "${entry.address}",`];
        })
      : [],
  );
  if (pins.length > 0) {
    printLine("");
    printLine("Address pins to add to each key's config:");
    for (const pin of pins) {
      printLine(pin);
    }
  }
}

/** Where an entry's `address` pin goes, or `undefined` for a `--kms` key, which has no config. */
function configPath({ name, source }: AccountName): string | undefined {
  if (source === "kms.keys") {
    return `kms.keys.${name}`;
  }
  return source === "kmsAccounts" ? `networks.${name}` : undefined;
}
