import type { NewTaskActionFunction } from "hardhat/types/tasks";

import type { AwsKmsKeyConfig, KmsAuditConfig, KmsIdentifier, KmsKeyConfig } from "../../types.ts";
import { identifierParts } from "../config/identifiers.ts";
import { errorMasker, type HiddenSources, hiddenSet } from "../history/mask.ts";
import { readSignHistory } from "../history/read.ts";
import {
  buildHistoryReport,
  historyNotes,
  type KmsHistoryReport,
  renderHistoryTable,
} from "../history/report.ts";
import { historyRange } from "../history/time.ts";
import { parseAwsKeyId } from "../providers/aws/key-id.ts";
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
 * An identifier's value when it comes from a configuration variable: when it differs from what its
 * display shows. Empty for a literal, or for a variable that cannot be read: the reader fails on
 * it first.
 */
async function variableValue(identifier: KmsIdentifier): Promise<string[]> {
  try {
    const value = await identifier.get();
    return value === identifier.display ? [] : [value];
  } catch {
    return [];
  }
}

/** An identifier's value, literal or from configuration variables; empty when it cannot be read. */
async function anyValue(identifier: KmsIdentifier): Promise<string[]> {
  try {
    return [await identifier.get()];
  } catch {
    return [];
  }
}

/**
 * The values of an AWS key's region and profile that come from configuration variables. They are
 * read as the AWS reader reads them: the region not at all when the key id is a key ARN with a
 * region, and `kms.defaults.aws.region` only when the key's own region is empty, so a variable the
 * run does not need never prompts for a keystore password.
 *
 * @param key - The AWS key.
 * @param keyId - The key id's value, or `undefined` when it cannot be read.
 */
async function awsSettingValues(
  key: AwsKmsKeyConfig,
  keyId: string | undefined,
): Promise<string[]> {
  const values = key.profile === undefined ? [] : await variableValue(key.profile);
  if (
    key.region === undefined ||
    keyId === undefined ||
    parseAwsKeyId(keyId)?.region !== undefined
  ) {
    return values;
  }
  const parts = identifierParts(key.region);
  for (const candidate of parts.length === 0 ? [key.region] : parts) {
    let value: string;
    try {
      value = await candidate.get();
    } catch {
      // The reader fails on it first.
      break;
    }
    if (value !== candidate.display) {
      values.push(value);
    }
    if (value !== "") {
      break;
    }
  }
  return values;
}

/**
 * The values `kms history` hides before it reads anything:
 *
 * - as the key: a built-in key's identifier, literal or from configuration variables, so that the
 *   message of an error a reader throws is masked even for a literal key;
 * - as `<hidden>`: the value of each configuration variable part of a joined identifier, such as a
 *   Google Cloud project id; for an AWS key, the values of its region and profile that come from
 *   configuration variables; and, for an Azure key only, the workspace id when it comes from a
 *   configuration variable. Other keys never read the workspace variable, so they never prompt
 *   for it.
 *
 * The report adds what the reader returns, and each value's parts that name something on their own.
 */
async function configuredHiddenValues(
  key: KmsKeyConfig,
  audit: KmsAuditConfig,
): Promise<HiddenSources> {
  const identifier =
    "keyVersionName" in key
      ? key.keyVersionName
      : key.provider === "aws" || key.provider === "azure"
        ? key.keyId
        : undefined;
  if (identifier === undefined) {
    return { keys: [], others: [] };
  }
  const parts = await Promise.all(identifierParts(identifier).map(variableValue));
  const workspace =
    key.provider === "azure" && audit.azure !== undefined
      ? await variableValue(audit.azure.workspaceId)
      : [];
  const keys = await anyValue(identifier);
  const settings = key.provider === "aws" ? await awsSettingValues(key, keys[0]) : [];
  return {
    keys,
    others: [...parts.flat(), ...workspace, ...settings],
  };
}

/** `n event` or `n events`. */
function eventCount(count: number): string {
  return `${count} event${count === 1 ? "" : "s"}`;
}

/**
 * What standard error says about a truncated report, or `undefined` when it is complete.
 *
 * @param report - The report.
 * @param limit - The `--limit` it was read with.
 * @returns The note.
 */
function truncationNote(report: KmsHistoryReport, limit: number): string | undefined {
  const shown = report.events.length;
  if (report.truncatedReason === "limit") {
    return `the log holds more events in this range than --limit ${limit}; these are the newest ${eventCount(shown)}. Narrow the range with --since and --until, or raise --limit.`;
  }
  if (report.truncatedReason === "scan-limit") {
    return `${
      shown === 0
        ? "the reader stopped before reading the whole range and found no sign events before it stopped"
        : `the reader stopped before reading the whole range; these are the newest ${eventCount(shown)} it found`
    }, so the range may hold events it did not read. Narrow the range with --since and --until.`;
  }
  return undefined;
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
    args.showIds ? (text) => text : errorMasker(hiddenSet(configured), key.displayId),
  );
  const report: KmsHistoryReport = buildHistoryReport({
    name: args.key,
    key,
    range,
    result,
    notes: historyNotes(result, range, now),
    showIds: args.showIds,
    hidden: configured,
  });
  for (const note of report.notes) {
    printNote(note.message);
  }
  const truncation = truncationNote(report, range.limit);
  if (truncation !== undefined) {
    printNote(truncation);
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
