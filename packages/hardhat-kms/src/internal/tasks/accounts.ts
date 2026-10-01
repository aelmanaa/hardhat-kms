import { HardhatError } from "@nomicfoundation/hardhat-errors";
import { HardhatPluginError } from "hardhat/plugins";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { errorResult, successfulResult } from "hardhat/utils/result";

import type { KmsKeyConfig } from "../../types.ts";
import { keyIdentity } from "../config/key-identity.ts";
import { errorName, kmsError } from "../errors.ts";
import { commandLineKeys } from "../hook-handlers/hre.ts";
import { printLine, printNote, type TaskKey, taskKeys, withTaskSigners } from "./keys.ts";

/** How many keys `kms accounts` asks the KMS about at once. */
const ACCOUNTS_CONCURRENCY = 8;

/** The arguments of `kms accounts`. */
interface AccountsArguments {
  json: boolean;
  showIds: boolean;
}

/** One key in the output of `kms accounts`. */
export interface AccountEntry {
  /** The name a task takes for this key. */
  name: string;
  /** Other names of the same KMS key with the same pin, listed once without `--network`. */
  otherNames: string[];
  provider: string;
  source: TaskKey["source"];
  /**
   * The key id. Values read from configuration variables show as `<VARIABLE_NAME>` unless
   * `--show-ids` is given.
   */
  keyId: string;
  /** The EIP-55 address, or `null` if the key failed. */
  address: string | null;
  /** The configured `address` pin, or `null`. */
  pin: string | null;
  /**
   * `match`: the KMS confirmed the pin. `none`: no pin. `unchecked`: the provider cannot report the
   * address, so `address` is the pin. `null` if the key failed.
   */
  pinStatus: "match" | "none" | "unchecked" | null;
  /** Why the key failed, or `null`. A pin mismatch names both addresses. */
  error: string | null;
}

/** What `kms accounts` returns, in a successful result or, if any key failed, a failed one. */
export interface AccountsReport {
  accounts: AccountEntry[];
}

/** A key to list, with every name it goes by. */
interface ListedKey {
  task: TaskKey;
  otherNames: string[];
}

/**
 * `kms accounts`: lists every configured key with its provider, source, key id and address, and
 * checks that each one is reachable and matches its `address` pin. With `--network`, it lists
 * that network's keys; without it, every key, each KMS key once.
 *
 * Every key is tried, and a failure is shown next to its key. The task returns a failed result
 * if any key failed, which makes the Hardhat CLI exit with code 1.
 *
 * @param args - The task arguments.
 * @param hre - The Hardhat runtime.
 * @returns The entries, in a successful result, or in a failed one if any key failed.
 */
const kmsAccounts: NewTaskActionFunction<AccountsArguments> = async ({ json, showIds }, hre) => {
  if (showIds) {
    printNote(
      "--show-ids prints key ids in full, including values read from configuration variables. Check the output before you share it.",
    );
  }
  const network = hre.globalOptions.network;
  const listed =
    network === undefined ? await distinctKeys(taskKeys(hre)) : networkKeys(hre, network);
  const accounts = await withTaskSigners(
    hre,
    async (signerFor) =>
      await mapWithLimit(listed, ACCOUNTS_CONCURRENCY, async ({ task, otherNames }) => {
        const entry: AccountEntry = {
          name: task.name,
          otherNames,
          provider: task.key.provider,
          source: task.source,
          keyId: showIds ? await revealedId(task.key) : task.key.displayId,
          address: null,
          pin: task.key.address ?? null,
          pinStatus: null,
          error: null,
        };
        try {
          const { address, confirmed } = await (await signerFor(task.key)).confirmedAddress();
          entry.address = address;
          entry.pinStatus = confirmed ? (entry.pin === null ? "none" : "match") : "unchecked";
        } catch (error) {
          entry.error = describeError(error);
        }
        return entry;
      }),
  );

  if (json) {
    printLine(JSON.stringify({ accounts }, null, 2));
  } else {
    printTable(accounts);
  }
  const report: AccountsReport = { accounts };
  return accounts.some((entry) => entry.error !== null)
    ? errorResult(report)
    : successfulResult(report);
};

export default kmsAccounts;

/**
 * The keys of one network: its `kmsAccounts`, then the `--kms` keys, which belong to the selected
 * network. A key is named as a task names it.
 */
function networkKeys(hre: HardhatRuntimeEnvironment, name: string): ListedKey[] {
  const config = hre.config.networks[name];
  if (config === undefined) {
    throw kmsError(`unknown network "${name}"`);
  }
  const named = new Set(Object.values(hre.config.kms.keys));
  return [
    ...config.kmsAccounts.map((key): ListedKey => ({
      task: { name: key.name, source: named.has(key) ? "kms.keys" : "kmsAccounts", key },
      otherNames: [],
    })),
    ...commandLineKeys(hre).map((key): ListedKey => ({
      task: { name: key.name, source: "--kms", key },
      otherNames: [],
    })),
  ];
}

/**
 * Lists each KMS key once: keys with the same identity and the same pin are one entry, under the
 * first name, with the others in `otherNames`. Keys of third-party providers, and keys whose
 * identifier cannot be read, are never merged; reading them fails again when they are resolved.
 */
async function distinctKeys(keys: TaskKey[]): Promise<ListedKey[]> {
  const identities = await Promise.all(
    keys.map(async ({ key }) => {
      try {
        const identity = await keyIdentity(key);
        return identity === undefined ? undefined : `${identity}\0${key.address ?? ""}`;
      } catch {
        return undefined;
      }
    }),
  );
  const listed: ListedKey[] = [];
  const byIdentity = new Map<string, ListedKey>();
  keys.forEach((task, index) => {
    const identity = identities[index];
    const existing = identity === undefined ? undefined : byIdentity.get(identity);
    if (existing !== undefined) {
      existing.otherNames.push(task.name);
      return;
    }
    const entry: ListedKey = { task, otherNames: [] };
    listed.push(entry);
    if (identity !== undefined) {
      byIdentity.set(identity, entry);
    }
  });
  return listed;
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
 * Prints the accounts as a table on standard output, each failure on the line under its key, and
 * then an `address` line to paste into the config of each key that has no pin.
 */
function printTable(accounts: AccountEntry[]): void {
  if (accounts.length === 0) {
    printNote(
      "no KMS keys are configured: add them to kms.keys or a network's kmsAccounts, or pass --kms.",
    );
    return;
  }
  const header = ["NAME", "PROVIDER", "SOURCE", "ADDRESS", "PIN", "KEY ID"];
  const rows = accounts.map((entry) => [
    [entry.name, ...entry.otherNames].join(", "),
    entry.provider,
    entry.source,
    entry.address ?? "FAILED",
    entry.pinStatus === null ? "-" : PIN_LABELS[entry.pinStatus],
    entry.keyId,
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
  rows.forEach((row, index) => {
    printLine(format(row));
    const error = accounts[index]?.error;
    if (error !== null && error !== undefined) {
      printLine(`  error: ${error}`);
    }
  });

  const pins = accounts.flatMap((entry) => {
    const path = configPath(entry);
    return entry.pinStatus === "none" && entry.address !== null && path !== undefined
      ? [`  ${path}: address: "${entry.address}",`]
      : [];
  });
  if (pins.length > 0) {
    printLine("");
    printLine("Address pins to add to each key's config:");
    for (const pin of pins) {
      printLine(pin);
    }
  }
}

/** Where a key's `address` pin goes, or `undefined` for a `--kms` key, which has no config. */
function configPath(entry: AccountEntry): string | undefined {
  if (entry.source === "kms.keys") {
    return `kms.keys.${entry.name}`;
  }
  return entry.source === "kmsAccounts" ? `networks.${entry.name}` : undefined;
}
