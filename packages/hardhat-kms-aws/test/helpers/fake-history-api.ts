import { readFileSync } from "node:fs";

import type { AwsHistoryApi, CloudTrailPage } from "../../src/internal/history-api.ts";

/** The placeholders the recorded fixtures use in place of the live ids. */
export const FIXTURE = {
  account: "111122223333",
  keyId: "1234abcd-12ab-34cd-56ef-1234567890ab",
  keyArn: "arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab",
  alias: "alias/deployer",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  principalId: "AIDAEXAMPLEPRINCIPAL1",
} as const;

/**
 * Real CloudTrail `Sign` records of the live test key, newest first, recorded on 2026-10-02 with
 * every id replaced by the placeholders above: a failed call with an algorithm the key does not
 * support, calls made with the alias and the bare key id from the AWS CLI, and calls through the
 * plugin with the key ARN.
 */
export const RECORDED: ReadonlyArray<Record<string, unknown>> = ((): Array<
  Record<string, unknown>
> => {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../fixtures/cloudtrail-sign-events.json", import.meta.url), "utf8"),
  );
  if (!Array.isArray(parsed)) {
    throw new TypeError("the fixture is not an array");
  }
  return parsed.map((record: unknown) => {
    if (typeof record !== "object" || record === null) {
      throw new TypeError("a fixture record is not an object");
    }
    return { ...record };
  });
})();

/**
 * A recorded record with some fields replaced, as the `CloudTrailEvent` JSON string.
 *
 * @param index - Which recorded record.
 * @param overrides - Fields to replace at the top level.
 * @returns The JSON string.
 */
export function recorded(index: number, overrides: Record<string, unknown> = {}): string {
  const record = RECORDED[index];
  if (record === undefined) {
    throw new RangeError(`no recorded record ${index}`);
  }
  return JSON.stringify({ ...record, ...overrides });
}

/** A recorded call to the fake. */
export interface ApiCall {
  method: "region" | "lookupSignEvents" | "callerAccount" | "resolveKeyArn" | "close";
  argument?: unknown;
  signal?: AbortSignal | undefined;
}

/** How the fake behaves. */
export interface FakeApiOptions {
  /** The pages, in order; a function builds the page for each call. */
  pages?: CloudTrailPage[] | ((index: number) => CloudTrailPage);
  account?: string | undefined;
  region?: string;
  resolvedArn?: string | undefined;
  lookupError?: unknown;
  accountError?: unknown;
  resolveError?: unknown;
  regionError?: unknown;
  /** Runs before each lookup answers, such as to abort the signal. */
  onLookup?: (index: number) => void;
}

/** Throws the configured error, as an `Error`. */
function fail(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

/**
 * A fake of the AWS calls of `kms history`, recording each call.
 *
 * @param options - How it behaves.
 * @returns The fake and its calls.
 */
export function fakeHistoryApi(options: FakeApiOptions = {}): {
  api: AwsHistoryApi;
  calls: ApiCall[];
} {
  const calls: ApiCall[] = [];
  let lookups = 0;
  const api: AwsHistoryApi = {
    region: async () => {
      calls.push({ method: "region" });
      return options.regionError === undefined
        ? (options.region ?? "us-east-1")
        : fail(options.regionError);
    },
    lookupSignEvents: async (range, nextToken, signal) => {
      calls.push({ method: "lookupSignEvents", argument: { range, nextToken }, signal });
      const index = lookups;
      lookups += 1;
      options.onLookup?.(index);
      if (options.lookupError !== undefined) {
        return fail(options.lookupError);
      }
      const pages = options.pages ?? [
        { events: RECORDED.map((_, at) => recorded(at)), nextToken: undefined },
      ];
      const page = typeof pages === "function" ? pages(index) : pages[index];
      return page ?? { events: [], nextToken: undefined };
    },
    callerAccount: async (signal) => {
      calls.push({ method: "callerAccount", signal });
      return options.accountError === undefined
        ? "account" in options
          ? options.account
          : FIXTURE.account
        : fail(options.accountError);
    },
    resolveKeyArn: async (keyId, signal) => {
      calls.push({ method: "resolveKeyArn", argument: keyId, signal });
      return options.resolveError === undefined
        ? "resolvedArn" in options
          ? options.resolvedArn
          : FIXTURE.keyArn
        : fail(options.resolveError);
    },
    close: () => {
      calls.push({ method: "close" });
    },
  };
  return { api, calls };
}

/**
 * An error shaped like an AWS SDK service error.
 *
 * @param name - The error code, such as `ThrottlingException`.
 * @returns The error.
 */
export function serviceError(name: string): Error {
  const error = new Error(`${name}: User arn:aws:iam::${FIXTURE.account}:user/deployer is denied`);
  error.name = name;
  return error;
}

/**
 * Top-level fields that give a recorded record another caller, shaped like the `userIdentity`
 * examples of the CloudTrail reference, with placeholders: a call from another account as the key
 * owner's account logs it (`AWSAccount`), an IAM Identity Center user, and an assumed role.
 *
 * @param type - Which identity.
 * @returns The fields to pass to {@link recorded}.
 */
export function identity(
  type: "AWSAccount" | "IdentityCenterUser" | "AssumedRole",
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../fixtures/cloudtrail-identities.json", import.meta.url), "utf8"),
  );
  const fields: unknown =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, type) : undefined;
  if (typeof fields !== "object" || fields === null) {
    throw new TypeError(`no identity fixture ${type}`);
  }
  return { ...fields };
}
