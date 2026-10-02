import type { NewTaskActionFunction } from "hardhat/types/tasks";

import type { KmsAuditConfig, KmsIdentifier, KmsKeyConfig } from "../../types.ts";
import { hiddenSet, masker } from "../history/mask.ts";
import { readSignHistory } from "../history/read.ts";
import {
  buildHistoryReport,
  historyNotes,
  type KmsHistoryReport,
  renderHistoryTable,
} from "../history/report.ts";
import { historyRange } from "../history/time.ts";
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
 * An identifier's value when it differs from what its display shows, that is, when it comes from
 * a configuration variable. Empty for a literal, or for a variable that cannot be read: the reader
 * fails on it first.
 */
async function variableValue(identifier: KmsIdentifier | undefined): Promise<string[]> {
  if (identifier === undefined) {
    return [];
  }
  try {
    const value = await identifier.get();
    return value === identifier.display ? [] : [value];
  } catch {
    return [];
  }
}

/**
 * The values `kms history` hides before it reads anything: a built-in key's identifier and the
 * Azure workspace id, when they come from configuration variables. The report adds what the
 * reader returns, and each value's parts that identify the key on their own.
 */
async function configuredHiddenValues(key: KmsKeyConfig, audit: KmsAuditConfig): Promise<string[]> {
  const identifier =
    "keyVersionName" in key
      ? key.keyVersionName
      : key.provider === "aws" || key.provider === "azure"
        ? key.keyId
        : undefined;
  return [...(await variableValue(identifier)), ...(await variableValue(audit.azure?.workspaceId))];
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
      "--show-ids prints key ids, provider id fields and error messages in full. Check the output before you share it.",
    );
  }
  const configured = await configuredHiddenValues(key, hre.config.kms.audit);
  const result = await readSignHistory(
    hre,
    { key, since: range.since, until: range.until, limit: range.limit },
    args.showIds ? (text) => text : masker(hiddenSet(configured), key.displayId),
  );
  const report: KmsHistoryReport = buildHistoryReport({
    name: args.key,
    key,
    range,
    result,
    notes: historyNotes(result, range, now),
    showIds: args.showIds,
    hiddenValues: configured,
  });
  for (const note of report.notes) {
    printNote(note.message);
  }
  if (report.truncatedReason === "limit") {
    printNote(
      `the log holds more events in this range than --limit ${range.limit}; these are the newest ${report.events.length}. Narrow the range with --since and --until, or raise --limit.`,
    );
  } else if (report.truncatedReason === "scan-limit") {
    printNote(
      `the reader stopped before reading the whole range; these are the newest ${report.events.length} events it found, and older ones in the range may be missing. Narrow the range with --since and --until.`,
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
