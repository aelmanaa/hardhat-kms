import type { NewTaskActionFunction } from "hardhat/types/tasks";

import type { KmsKeyConfig } from "../../types.ts";
import { readSignHistory } from "../history/read.ts";
import {
  buildHistoryReport,
  historyNotes,
  type KmsHistoryReport,
  renderHistoryTable,
} from "../history/report.ts";
import { historyRange } from "../history/time.ts";
import { builtinProvider } from "../providers/registry.ts";
import { findTaskKey, printLine, printNote } from "./keys.ts";

/** The arguments of `kms history`. */
interface HistoryArguments {
  key: string;
  since: string | undefined;
  until: string | undefined;
  limit: number;
  json: boolean;
  showIds: boolean;
}

/**
 * The value of a built-in key's identifier when it differs from what the display id shows, that
 * is, when it comes from a configuration variable. The report hides it like a key resource.
 * Empty for a literal identifier, a third-party key, or a variable that cannot be read.
 */
async function hiddenIdentifierValues(key: KmsKeyConfig): Promise<string[]> {
  const identifier =
    "keyVersionName" in key
      ? key.keyVersionName
      : key.provider === "aws" || key.provider === "azure"
        ? key.keyId
        : undefined;
  if (identifier === undefined) {
    return [];
  }
  try {
    const value = await identifier.get();
    return value === identifier.display ? [] : [value];
  } catch {
    // The reader read the same identifier, so this cannot fail after a successful read; if it
    // does, there is no value to hide.
    return [];
  }
}

/**
 * `kms history <key>`: lists the key's sign events from its provider's audit log, newest first.
 * The events come only from the log, through the reader that the provider's plugin adds to the
 * `kms` hook; the plugin stores nothing and fills in nothing. Notes on standard error say what an
 * empty or recent range cannot show.
 *
 * @param args - The task arguments.
 * @param hre - The Hardhat runtime.
 * @returns The report that `--json` prints.
 */
const kmsHistory: NewTaskActionFunction<HistoryArguments> = async (args, hre) => {
  const now = new Date();
  const range = historyRange(args, now);
  const key = findTaskKey(hre, args.key);
  if (args.showIds) {
    printNote(
      "--show-ids prints key ids, account ids and provider error messages in full. Check the output before you share it.",
    );
  }
  const result = await readSignHistory(hre, {
    key,
    since: range.since,
    until: range.until,
    limit: range.limit,
  });
  const report: KmsHistoryReport = buildHistoryReport({
    name: args.key,
    key,
    range,
    result,
    notes: historyNotes(result, range, now, builtinProvider(key.provider)?.name ?? key.provider),
    showIds: args.showIds,
    hiddenValues: await hiddenIdentifierValues(key),
  });
  for (const note of report.notes) {
    printNote(note.message);
  }
  if (report.truncated) {
    printNote(
      `the log holds more events in this range than --limit ${range.limit}; these are the newest ${report.events.length}. Narrow the range with --since and --until, or raise --limit.`,
    );
  }
  if (args.json) {
    printLine(JSON.stringify(report, null, 2));
  } else {
    for (const line of renderHistoryTable(report)) {
      printLine(line);
    }
  }
  return report;
};

export default kmsHistory;
