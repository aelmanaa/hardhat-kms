import { HardhatError } from "@nomicfoundation/hardhat-errors";
import { HardhatPluginError } from "hardhat/plugins";
import type { HookContext } from "hardhat/types/hooks";

import type { KmsKeyConfig } from "../../types.ts";
import { kmsDebug } from "../debug.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError, type ErrorDetails, errorName } from "../errors.ts";
import { builtinProvider } from "../providers/registry.ts";
import { parseLoggedTime } from "./time.ts";
import type {
  KmsHistoryEvent,
  KmsHistoryExtraValue,
  KmsHistoryField,
  KmsHistoryNote,
  KmsHistoryRequest,
  KmsHistoryResult,
  KmsHistoryScope,
} from "./types.ts";

const log = kmsDebug("history");

/** Every field a reader may list as not logged, in the order the output shows them. */
const HISTORY_FIELDS: readonly KmsHistoryField[] = [
  "principal",
  "sourceIp",
  "userAgent",
  "requestId",
  "keyVersion",
  "digest",
];

/** The note codes the plugin adds itself, which a reader may not use. */
const CORE_NOTE_CODES: readonly string[] = [
  "logging-not-confirmed",
  "recent-events-may-be-missing",
  "before-retention",
];

const NOTE_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DIGEST = /^0x[0-9a-f]{64}$/;
const KEY_VERSION = /^[A-Za-z0-9._-]{1,64}$/;

/** Explains why no reader claimed a key: its provider package is missing, or no plugin reads it. */
function noReaderError(key: KmsKeyConfig, details: ErrorDetails): Error {
  const provider = builtinProvider(key.provider);
  if (provider !== undefined && "package" in provider.adapter) {
    return catalogError(
      ERRORS.historyNoReaderBuiltin,
      { name: provider.name, package: provider.adapter.package },
      details,
    );
  }
  return catalogError(ERRORS.historyNoReader, { provider: key.provider }, details);
}

/**
 * Reads a key's sign events: runs the `kms.readSignHistory` hook chain, then checks what the
 * reader returned against the contract. Events come back newest first, at most `limit` of them.
 *
 * @param context - The Hardhat runtime.
 * @param request - The key, the range and the limit.
 * @param mask - Hides key ids in the message of an error the reader throws.
 * @returns The checked result.
 */
export async function readSignHistory(
  context: HookContext,
  request: KmsHistoryRequest,
  mask: (text: string) => string,
): Promise<KmsHistoryResult> {
  const { key } = request;
  const details = { provider: key.provider, operation: "history", key: key.displayId };
  log("reading the audit log of %s", key.displayId);
  let result: unknown;
  try {
    result = await context.hooks.runHandlerChain(
      "kms",
      "readSignHistory",
      [request],
      async (_finalContext, finalRequest) => {
        log("%s: no plugin reads this provider's audit log", finalRequest.key.displayId);
        return await Promise.reject(noReaderError(finalRequest.key, details));
      },
    );
  } catch (error) {
    // As for adapters: the plugin's and Hardhat's errors are written to be shown; anything else
    // may carry request details, so only its class name is kept.
    if (HardhatPluginError.isHardhatPluginError(error) || HardhatError.isHardhatError(error)) {
      // A reader's error message should hold no ids; mask any it holds anyway.
      error.message = mask(error.message);
      throw error;
    }
    log("%s: reading the audit log failed (%s)", key.displayId, errorName(error));
    throw catalogError(ERRORS.historyReadFailed, { errorName: errorName(error) }, details);
  }
  const problems: string[] = [];
  const checked = parseHistoryResult(result, request, problems);
  if (checked === undefined || problems.length > 0) {
    throw catalogError(
      ERRORS.historyReaderInvalid,
      { problem: problems.slice(0, 3).join("; ") },
      details,
    );
  }
  return checked;
}

/** Reads a property of an object that is not known to be a record. */
function property(value: object, name: string): unknown {
  return Reflect.get(value, name);
}

/** The value as an object, or `undefined` when it is not a non-array object. */
function asObject(value: unknown): object | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

/** A string or `null` field, or a problem when it is anything else. */
function nullableString(
  source: object,
  name: string,
  path: string,
  problems: string[],
): string | null {
  const value = property(source, name);
  if (value === null || typeof value === "string") {
    return value;
  }
  problems.push(`${path}.${name} must be a string or null`);
  return null;
}

function nonEmptyString(source: object, name: string, path: string, problems: string[]): string {
  const value = property(source, name);
  if (typeof value === "string" && value !== "") {
    return value;
  }
  problems.push(`${path}.${name} must be a non-empty string`);
  return "";
}

function optionalCount(source: object, name: string, problems: string[]): number | undefined {
  const value = property(source, name);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  problems.push(`${name} must be a positive number when set`);
  return undefined;
}

/** `extra`: scalars by name, or `undefined` when absent. */
function extraFields(
  source: object,
  path: string,
  problems: string[],
): Record<string, KmsHistoryExtraValue> | undefined {
  const value = property(source, "extra");
  if (value === undefined) {
    return undefined;
  }
  const fields = asObject(value);
  if (fields === undefined) {
    problems.push(`${path}.extra must be an object`);
    return undefined;
  }
  const entries: Array<[string, KmsHistoryExtraValue]> = [];
  for (const field of Object.keys(fields)) {
    const item = property(fields, field);
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      entries.push([field, item]);
    } else {
      problems.push(`${path}.extra.${field} must be a string, a finite number, a boolean or null`);
    }
  }
  return Object.fromEntries(entries);
}

/** `extraIds`: strings or `null` by name, or `undefined` when absent. */
function extraIdFields(
  source: object,
  path: string,
  problems: string[],
): Record<string, string | null> | undefined {
  const value = property(source, "extraIds");
  if (value === undefined) {
    return undefined;
  }
  const fields = asObject(value);
  if (fields === undefined) {
    problems.push(`${path}.extraIds must be an object`);
    return undefined;
  }
  const entries: Array<[string, string | null]> = [];
  for (const field of Object.keys(fields)) {
    const item = property(fields, field);
    if (item === null || typeof item === "string") {
      entries.push([field, item]);
    } else {
      problems.push(`${path}.extraIds.${field} must be a string or null`);
    }
  }
  return Object.fromEntries(entries);
}

function parseEvent(
  input: unknown,
  path: string,
  request: KmsHistoryRequest,
  notLogged: readonly KmsHistoryField[],
  problems: string[],
): KmsHistoryEvent | undefined {
  const value = asObject(input);
  if (value === undefined) {
    problems.push(`${path} must be an object`);
    return undefined;
  }
  const time = nonEmptyString(value, "time", path, problems);
  const parsed = parseLoggedTime(time);
  if (parsed === undefined) {
    problems.push(`${path}.time must be an existing ISO 8601 date and time with a time zone`);
  } else if (parsed < request.since.getTime() || parsed > request.until.getTime()) {
    problems.push(`${path}.time is outside the requested range`);
  }
  const outcome = property(value, "outcome");
  if (outcome !== "success" && outcome !== "failed") {
    problems.push(`${path}.outcome must be "success" or "failed"`);
  }
  const errorCode = nullableString(value, "errorCode", path, problems);
  const errorMessage = nullableString(value, "errorMessage", path, problems);
  if (outcome === "success" && (errorCode !== null || errorMessage !== null)) {
    problems.push(`${path} succeeded but has an error`);
  }
  const fields = {
    principal: nullableString(value, "principal", path, problems),
    sourceIp: nullableString(value, "sourceIp", path, problems),
    userAgent: nullableString(value, "userAgent", path, problems),
    requestId: nullableString(value, "requestId", path, problems),
    keyVersion: nullableString(value, "keyVersion", path, problems),
    digest: nullableString(value, "digest", path, problems),
  };
  for (const field of notLogged) {
    if (fields[field] !== null) {
      problems.push(`${path}.${field} has a value, but the reader lists it as not logged`);
    }
  }
  if (fields.digest !== null && !DIGEST.test(fields.digest)) {
    problems.push(`${path}.digest must be 0x-prefixed lowercase hex of 32 bytes`);
  }
  if (fields.keyVersion !== null && !KEY_VERSION.test(fields.keyVersion)) {
    problems.push(`${path}.keyVersion must be a version id alone, not a resource name`);
  }
  const event: KmsHistoryEvent = {
    time: parsed === undefined ? time : new Date(parsed).toISOString(),
    operation: nonEmptyString(value, "operation", path, problems),
    outcome: outcome === "failed" ? "failed" : "success",
    errorCode,
    errorMessage,
    ...fields,
    keyResource: nullableString(value, "keyResource", path, problems),
  };
  const extra = extraFields(value, path, problems);
  const extraIds = extraIdFields(value, path, problems);
  return {
    ...event,
    ...(extra === undefined ? {} : { extra }),
    ...(extraIds === undefined ? {} : { extraIds }),
  };
}

function parseNote(input: unknown, path: string, problems: string[]): KmsHistoryNote | undefined {
  const value = asObject(input);
  if (value === undefined) {
    problems.push(`${path} must be an object`);
    return undefined;
  }
  const code = nonEmptyString(value, "code", path, problems);
  const message = nonEmptyString(value, "message", path, problems);
  if (!NOTE_CODE.test(code) || CORE_NOTE_CODES.includes(code)) {
    problems.push(`${path}.code must be lowercase words joined by - and not a code of the plugin`);
  }
  return { code, message };
}

function parseScope(source: object, problems: string[]): KmsHistoryScope | undefined {
  const input = property(source, "scope");
  if (input === undefined) {
    return undefined;
  }
  const value = asObject(input);
  if (value === undefined) {
    problems.push("scope must be an object when set");
    return undefined;
  }
  const description = nonEmptyString(value, "description", "scope", problems);
  const rawIds = property(value, "ids");
  if (rawIds === undefined) {
    return { description };
  }
  const idFields = asObject(rawIds);
  const ids: Array<[string, string]> = [];
  for (const field of idFields === undefined ? [] : Object.keys(idFields)) {
    const item = idFields === undefined ? undefined : property(idFields, field);
    if (typeof item === "string" && item !== "") {
      ids.push([field, item]);
    } else {
      problems.push(`scope.ids.${field} must be a non-empty string`);
    }
  }
  if (idFields === undefined) {
    problems.push("scope.ids must be an object when set");
  }
  return { description, ids: Object.fromEntries(ids) };
}

function parseHiddenValues(source: object, problems: string[]): string[] {
  const input = property(source, "hiddenValues");
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input)) {
    problems.push("hiddenValues must be an array when set");
    return [];
  }
  const values: string[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      values.push(item);
    } else {
      problems.push("hiddenValues must hold strings only");
    }
  }
  return values;
}

/**
 * Checks a reader's result against the contract and copies it, sorted newest first and cut to the
 * limit. A result with more than `limit` events, or `truncated` without a reason, is truncated by
 * `limit`. Problems are added to `problems`; the result is `undefined` when it is not an object.
 *
 * @param value - What the reader returned.
 * @param request - The request it answered.
 * @param problems - Collects what is wrong.
 * @returns The checked copy.
 */
export function parseHistoryResult(
  input: unknown,
  request: KmsHistoryRequest,
  problems: string[],
): KmsHistoryResult | undefined {
  const value = asObject(input);
  if (value === undefined) {
    problems.push("the result must be an object");
    return undefined;
  }
  const source = nonEmptyString(value, "source", "result", problems);
  if (source !== "" && !NOTE_CODE.test(source)) {
    problems.push("result.source must be lowercase words joined by -");
  }
  const listed = property(value, "notLogged");
  const notLogged: KmsHistoryField[] = [];
  if (Array.isArray(listed)) {
    for (const item of listed) {
      const field = HISTORY_FIELDS.find((known) => known === item);
      if (field === undefined) {
        problems.push(
          `notLogged holds an unknown field: ${typeof item === "string" ? item : typeof item}`,
        );
      } else if (!notLogged.includes(field)) {
        notLogged.push(field);
      }
    }
  } else {
    problems.push("notLogged must be an array");
  }
  const rawEvents = property(value, "events");
  const events: KmsHistoryEvent[] = [];
  if (Array.isArray(rawEvents)) {
    rawEvents.forEach((event: unknown, index: number) => {
      const parsed = parseEvent(event, `events[${index}]`, request, notLogged, problems);
      if (parsed !== undefined) {
        events.push(parsed);
      }
    });
    if (rawEvents.length > request.limit + 1) {
      problems.push(`events must hold at most limit + 1 (${request.limit + 1}) entries`);
    }
  } else {
    problems.push("events must be an array");
  }
  const truncated = property(value, "truncated");
  if (typeof truncated !== "boolean") {
    problems.push("truncated must be a boolean");
  }
  const truncatedReason = property(value, "truncatedReason");
  if (
    truncatedReason !== undefined &&
    truncatedReason !== "limit" &&
    truncatedReason !== "scan-limit"
  ) {
    problems.push('truncatedReason must be "limit" or "scan-limit" when set');
  } else if (truncatedReason !== undefined && truncated !== true) {
    problems.push("truncatedReason is set, but truncated is not true");
  }
  const completeForKey = property(value, "completeForKey");
  if (typeof completeForKey !== "boolean") {
    problems.push("completeForKey must be a boolean");
  }
  const scope = parseScope(value, problems);
  const hiddenValues = parseHiddenValues(value, problems);
  const setupHint = property(value, "setupHint");
  if (setupHint !== undefined && typeof setupHint !== "string") {
    problems.push("setupHint must be a string when set");
  }
  const rawNotes = property(value, "notes");
  const notes: KmsHistoryNote[] = [];
  if (Array.isArray(rawNotes)) {
    rawNotes.forEach((note: unknown, index: number) => {
      const parsed = parseNote(note, `notes[${index}]`, problems);
      if (parsed !== undefined) {
        notes.push(parsed);
      }
    });
  } else if (rawNotes !== undefined) {
    problems.push("notes must be an array when set");
  }
  const deliveryDelayMinutes = optionalCount(value, "deliveryDelayMinutes", problems);
  const retentionDays = optionalCount(value, "retentionDays", problems);

  // Newest first; the sort is stable, so events logged at the same time keep the reader's order.
  const sorted = events.toSorted((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const isTruncated = truncated === true || sorted.length > request.limit;
  return {
    source,
    notLogged,
    events: sorted.slice(0, request.limit),
    truncated: isTruncated,
    ...(isTruncated
      ? { truncatedReason: truncatedReason === "scan-limit" ? "scan-limit" : "limit" }
      : {}),
    completeForKey: completeForKey === true,
    ...(scope === undefined ? {} : { scope }),
    ...(hiddenValues.length === 0 ? {} : { hiddenValues }),
    ...(typeof setupHint === "string" && setupHint !== "" ? { setupHint } : {}),
    ...(deliveryDelayMinutes === undefined ? {} : { deliveryDelayMinutes }),
    ...(retentionDays === undefined ? {} : { retentionDays }),
    notes,
  };
}
