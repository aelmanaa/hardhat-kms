import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AwsKmsKeyConfig, KmsHistoryRequest, KmsHistoryResult } from "hardhat-kms/types";
import { HardhatPluginError } from "hardhat/plugins";

import {
  HISTORY_SOURCE,
  MAX_PAGES,
  PAGE_INTERVAL_MS,
  readAwsSignHistory,
  SCAN_BUDGET_MS,
  type Sleep,
} from "../../src/internal/history.ts";
import {
  type ApiCall,
  FIXTURE,
  fakeHistoryApi,
  type FakeApiOptions,
  identity,
  RECORDED,
  recorded,
  serviceError,
} from "../helpers/fake-history-api.ts";

const SINCE = new Date("2026-10-02T09:00:00Z");
const UNTIL = new Date("2026-10-02T10:00:00Z");
const OTHER_KEY_ARN = "arn:aws:kms:us-east-1:111122223333:key/0000abcd-12ab-34cd-56ef-1234567890ab";

/**
 * A resolved AWS key, as hardhat-kms passes it to the reader, read from a configuration variable
 * so that no id is in its display id.
 */
function awsKey(keyId: string): AwsKmsKeyConfig {
  return {
    provider: "aws",
    name: "deployer",
    keyId: { get: async () => await Promise.resolve(keyId), display: "{AWS_KMS_KEY_ID}" },
    timeoutMs: 1000,
    displayId: "aws:{AWS_KMS_KEY_ID}",
  };
}

/** The index of the first recorded record that matches. */
function recordWhere(match: (record: Record<string, unknown>) => boolean): number {
  const index = RECORDED.findIndex(match);
  assert.ok(index >= 0, "no recorded record matches");
  return index;
}

/** What the caller passed as the key, from a record's request parameters. */
function requestKeyId(record: Record<string, unknown>): unknown {
  const parameters: unknown = record.requestParameters;
  return typeof parameters === "object" && parameters !== null
    ? Reflect.get(parameters, "keyId")
    : undefined;
}

const PLUGIN = recordWhere((record) => String(record.userAgent).includes("hardhat-kms/"));
const FAILED = recordWhere((record) => typeof record.errorCode === "string");
const BY_ALIAS = recordWhere((record) => requestKeyId(record) === FIXTURE.alias);
const BY_KEY_ID = recordWhere((record) => requestKeyId(record) === FIXTURE.keyId);

interface Run {
  result: KmsHistoryResult;
  calls: ApiCall[];
  sleeps: number[];
}

/** Reads the history of `keyId` with a fake API. */
async function read(
  options: FakeApiOptions = {},
  keyId: string = FIXTURE.keyArn,
  request: Partial<KmsHistoryRequest> = {},
  now?: () => number,
): Promise<Run> {
  const { api, calls } = fakeHistoryApi(options);
  const sleeps: number[] = [];
  const sleep: Sleep = async (milliseconds) => {
    sleeps.push(milliseconds);
    await Promise.resolve();
  };
  const key = awsKey(keyId);
  const result = await readAwsSignHistory(
    key,
    { key, since: SINCE, until: UNTIL, limit: 100, ...request },
    api,
    { sleep, ...(now === undefined ? {} : { now }) },
  );
  return { result, calls, sleeps };
}

/** Reads, expecting a plugin error whose message holds each part and none of the ids. */
async function readFails(
  options: FakeApiOptions,
  includes: string[],
  keyId: string = FIXTURE.keyArn,
): Promise<void> {
  const { api } = fakeHistoryApi(options);
  const key = awsKey(keyId);
  await assert.rejects(
    readAwsSignHistory(key, { key, since: SINCE, until: UNTIL, limit: 100 }, api, {
      sleep: async () => {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof HardhatPluginError, String(error));
      for (const part of includes) {
        assert.ok(error.message.includes(part), `"${error.message}" should include "${part}"`);
      }
      assert.doesNotMatch(error.message, /111122223333|1234abcd/);
      return true;
    },
  );
}

/** The plugin record without `resources`, as if the caller had passed `keyId`. */
function noResources(keyId: unknown): string {
  return recorded(PLUGIN, { resources: undefined, requestParameters: { keyId } });
}

/** A page of the given records. */
function page(events: Array<string | undefined>, nextToken?: string) {
  return { events, nextToken };
}

describe("AWS history reader", () => {
  it("maps a recorded plugin Sign event field by field", async () => {
    const { result } = await read({ pages: [page([recorded(PLUGIN)])] });

    assert.equal(result.source, HISTORY_SOURCE);
    assert.deepEqual(result.notLogged, ["keyVersion", "digest"]);
    assert.equal(result.events.length, 1);
    const record = RECORDED[PLUGIN] ?? {};
    assert.deepEqual(result.events[0], {
      time: record.eventTime,
      operation: "Sign",
      outcome: "success",
      errorCode: null,
      errorMessage: null,
      principal: "arn:aws:iam::111122223333:user/deployer",
      sourceIp: "203.0.113.7",
      userAgent: record.userAgent,
      requestId: record.requestID,
      keyVersion: null,
      digest: null,
      keyResource: FIXTURE.keyArn,
      extra: {
        eventId: record.eventID,
        userIdentityType: "IAMUser",
        userName: "deployer",
        crossAccount: false,
        messageType: "DIGEST",
        signingAlgorithm: "ECDSA_SHA_256",
        tlsVersion: "TLSv1.3",
        readOnly: true,
      },
      extraIds: {
        accessKeyId: FIXTURE.accessKeyId,
        principalId: FIXTURE.principalId,
        requestKeyId: FIXTURE.keyArn,
      },
    });
    assert.match(result.events[0]?.userAgent ?? "", /hardhat-kms\/0\.0\.0/);
    assert.equal(result.deliveryDelayMinutes, 5);
    assert.equal(result.retentionDays, 90);
    assert.equal(result.truncated, false);
    assert.equal(result.truncatedReason, undefined);
  });

  it("maps a failed Sign event with its error code and message", async () => {
    const { result } = await read({ pages: [page([recorded(FAILED)])] });

    const record = RECORDED[FAILED] ?? {};
    const event = result.events[0];
    assert.equal(event?.outcome, "failed");
    assert.equal(event.errorCode, record.errorCode);
    assert.equal(event.errorMessage, record.errorMessage);
    assert.equal(event.errorCode, "InvalidKeyUsageException");
  });

  it("finds Sign calls made with the key ARN, the bare key id and an alias", async () => {
    const { result } = await read();

    assert.equal(result.events.length, RECORDED.length);
    const passed = result.events.map((event) => event.extraIds?.requestKeyId);
    for (const id of [FIXTURE.keyArn, FIXTURE.keyId, FIXTURE.alias]) {
      assert.ok(passed.includes(id), `the call made with ${id} is missing`);
    }
    for (const index of [BY_ALIAS, BY_KEY_ID]) {
      assert.ok(result.events.some((event) => event.requestId === RECORDED[index]?.requestID));
    }
  });

  it("keeps only KMS Sign events on this key inside the range", async () => {
    const { result } = await read({
      pages: [
        page([
          recorded(PLUGIN, { resources: [{ ARN: OTHER_KEY_ARN, type: "AWS::KMS::Key" }] }),
          recorded(PLUGIN, {
            resources: "not a list",
            requestParameters: { keyId: OTHER_KEY_ARN },
          }),
          recorded(PLUGIN, { eventName: "GetPublicKey" }),
          recorded(PLUGIN, { eventSource: "signer.amazonaws.com" }),
          recorded(PLUGIN, { eventTime: "2026-10-02T10:00:01Z" }),
          recorded(PLUGIN, { eventTime: "2026-10-02T08:59:59Z" }),
          recorded(PLUGIN, { eventTime: "2026-10-02T10:00:00Z" }),
          recorded(PLUGIN, { eventTime: "2026-10-02T09:00:00Z" }),
        ]),
      ],
    });

    assert.deepEqual(
      result.events.map((event) => event.time),
      ["2026-10-02T10:00:00Z", "2026-10-02T09:00:00Z"],
    );
  });

  it("reports fields logged empty as null, and leaves out extras that are absent", async () => {
    const { result } = await read({
      pages: [
        page([
          recorded(PLUGIN, {
            userIdentity: { type: "AWSService", invokedBy: "cloudformation.amazonaws.com" },
            requestParameters: null,
            tlsDetails: null,
            readOnly: "true",
            sourceIPAddress: "",
            userAgent: 7,
            sharedEventID: "shared-1",
            vpcEndpointId: "vpce-0abc",
            eventID: null,
          }),
        ]),
      ],
    });

    const event = result.events[0];
    assert.equal(event?.principal, null);
    assert.equal(event.sourceIp, null);
    assert.equal(event.userAgent, null);
    assert.deepEqual(event.extra, {
      userIdentityType: "AWSService",
      invokedBy: "cloudformation.amazonaws.com",
      sharedEventId: "shared-1",
    });
    assert.deepEqual(event.extraIds, { vpcEndpointId: "vpce-0abc" });
  });

  it("asks CloudTrail for Sign events over the range, widened by one second", async () => {
    const { calls } = await read({ pages: [page([])] });

    const lookups = calls.filter((call) => call.method === "lookupSignEvents");
    assert.deepEqual(lookups[0]?.argument, {
      range: { start: SINCE, end: new Date(UNTIL.getTime() + 1000) },
      nextToken: undefined,
    });
    assert.deepEqual(
      calls.map((call) => call.method),
      ["region", "callerAccount", "lookupSignEvents"],
    );
  });

  it("pages with the next token, two requests a second at most", async () => {
    const { result, calls, sleeps } = await read({
      pages: [
        page([recorded(BY_ALIAS)], "t1"),
        page([recorded(BY_KEY_ID)], "t2"),
        page([recorded(PLUGIN)]),
      ],
    });

    const tokens = calls
      .filter((call) => call.method === "lookupSignEvents")
      .map((call): unknown => Reflect.get(Object(call.argument), "nextToken"));
    assert.deepEqual(tokens, [undefined, "t1", "t2"]);
    assert.deepEqual(sleeps, [PAGE_INTERVAL_MS, PAGE_INTERVAL_MS]);
    assert.equal(PAGE_INTERVAL_MS, 500);
    assert.equal(result.events.length, 3);
    assert.equal(result.truncated, false);
  });

  it("stops at limit + 1 events and reports truncation by the limit", async () => {
    const { result, calls } = await read(
      {
        pages: () =>
          page(
            Array.from({ length: 50 }, () => recorded(PLUGIN)),
            "more",
          ),
      },
      FIXTURE.keyArn,
      { limit: 70 },
    );

    assert.equal(result.events.length, 71);
    assert.equal(result.truncated, true);
    assert.equal(result.truncatedReason, "limit");
    assert.equal(calls.filter((call) => call.method === "lookupSignEvents").length, 2);
  });

  it("stops after the page budget and reports truncation by scan-limit", async () => {
    const { result, calls } = await read({
      pages: () => page([recorded(PLUGIN, { resources: [{ ARN: OTHER_KEY_ARN }] })], "more"),
    });

    assert.equal(calls.filter((call) => call.method === "lookupSignEvents").length, MAX_PAGES);
    assert.deepEqual(result.events, []);
    assert.equal(result.truncated, true);
    assert.equal(result.truncatedReason, "scan-limit");
  });

  it("is complete for the key when the credentials are in the key's account and Region", async () => {
    const { result } = await read();

    assert.equal(result.completeForKey, true);
    assert.deepEqual(result.scope, {
      description: "us-east-1",
      ids: { account: FIXTURE.account },
    });
    assert.deepEqual(result.notes, []);
    assert.deepEqual(result.hiddenValues, []);
    assert.ok(result.setupHint !== undefined && !/\d{5}/.test(result.setupHint));
  });

  it("is not complete when the credentials are in another account", async () => {
    const { result } = await read({ account: "444455556666" });

    assert.equal(result.completeForKey, false);
    assert.deepEqual(result.scope?.ids, { account: "444455556666" });
    assert.deepEqual(
      result.notes?.map((note) => note.code),
      ["other-account"],
    );
    assert.doesNotMatch(JSON.stringify(result.notes), /\d{5}/);
  });

  it("is not complete when STS names no account", async () => {
    const { result } = await read({ account: undefined });

    assert.equal(result.completeForKey, false);
    assert.equal(result.scope?.ids, undefined);
  });

  it("is not complete when the read is in another Region than the key's", async () => {
    const { result } = await read({ region: "eu-west-3" });

    assert.equal(result.completeForKey, false);
    assert.equal(result.scope?.description, "eu-west-3");
    assert.deepEqual(
      result.notes?.map((note) => note.code),
      ["other-region"],
    );
  });

  for (const keyId of [FIXTURE.alias, FIXTURE.keyId]) {
    it(`resolves ${keyId.startsWith("alias/") ? "an alias" : "a bare key id"} to the key ARN, which it hides`, async () => {
      const { result, calls } = await read({}, keyId);

      const resolve = calls.find((call) => call.method === "resolveKeyArn");
      assert.equal(resolve?.argument, keyId);
      // The key is in the credentials' account: no STS call.
      assert.ok(!calls.some((call) => call.method === "callerAccount"));
      assert.deepEqual(result.hiddenValues, [FIXTURE.keyArn]);
      assert.equal(result.completeForKey, true);
      assert.deepEqual(result.scope?.ids, { account: FIXTURE.account });
      assert.equal(result.events.length, RECORDED.length);
    });
  }

  it("asks STS for an alias ARN's account only through the resolved key", async () => {
    const { calls } = await read({}, "arn:aws:kms:us-east-1:111122223333:alias/deployer");

    assert.ok(calls.some((call) => call.method === "resolveKeyArn"));
    assert.ok(!calls.some((call) => call.method === "callerAccount"));
  });

  it("refuses a resolved key id that is not a key ARN", async () => {
    await readFails({ resolvedArn: undefined }, ["the response has no key ARN"], FIXTURE.alias);
    await readFails({ resolvedArn: "alias/other" }, ["the response has no key ARN"], FIXTURE.alias);
  });

  it("names cloudtrail:LookupEvents when CloudTrail refuses the read", async () => {
    for (const name of ["AccessDeniedException", "AccessDenied"]) {
      await readFails({ lookupError: serviceError(name) }, ["cloudtrail:LookupEvents"]);
    }
  });

  it("names kms:GetPublicKey when KMS refuses to resolve an alias", async () => {
    await readFails(
      { resolveError: serviceError("AccessDeniedException") },
      ["kms:GetPublicKey"],
      FIXTURE.alias,
    );
  });

  it("goes on without the account when STS fails, and says the history may be incomplete", async () => {
    for (const error of [serviceError("AccessDenied"), new Error("connect ECONNREFUSED")]) {
      const { result } = await read({ accountError: error });

      assert.equal(result.completeForKey, false);
      assert.equal(result.scope?.ids, undefined);
      assert.deepEqual(
        result.notes?.map((note) => note.code),
        ["caller-account-unknown"],
      );
      assert.equal(result.events.length, RECORDED.length);
    }
  });

  it("still stops when the signal aborts during the STS call, and explains a missing Region", async () => {
    const controller = new AbortController();
    controller.abort(new Error("deadline"));
    const { api } = fakeHistoryApi({ accountError: new Error("aborted") });
    const key = awsKey(FIXTURE.keyArn);
    await assert.rejects(
      readAwsSignHistory(
        key,
        { key, since: SINCE, until: UNTIL, limit: 100, signal: controller.signal },
        api,
      ),
      /deadline/,
    );
    await readFails({ accountError: new Error("Region is missing") }, ["no AWS region"]);
  });

  it("passes an error of the Region lookup on, without naming a CloudTrail permission", async () => {
    const error = serviceError("AccessDeniedException");
    const { api } = fakeHistoryApi({ regionError: error });
    const key = awsKey(FIXTURE.keyArn);
    await assert.rejects(
      readAwsSignHistory(key, { key, since: SINCE, until: UNTIL, limit: 100 }, api),
      (thrown: unknown) => thrown === error,
    );
  });

  it("fails as throttled, naming the limit, when CloudTrail keeps throttling", async () => {
    for (const name of ["ThrottlingException", "Throttling", "TooManyRequestsException"]) {
      await readFails({ lookupError: serviceError(name) }, ["2 requests per second"]);
    }
  });

  it("passes a throttled KMS call on, since the lookup limit does not apply to it", async () => {
    const error = serviceError("ThrottlingException");
    const { api } = fakeHistoryApi({ resolveError: error });
    const key = awsKey(FIXTURE.alias);
    await assert.rejects(
      readAwsSignHistory(key, { key, since: SINCE, until: UNTIL, limit: 100 }, api),
      (thrown: unknown) => thrown === error,
    );
  });

  it("explains a missing Region", async () => {
    await readFails({ regionError: new Error("Region is missing") }, ["no AWS region"]);
  });

  it("passes other errors on unchanged, for the core to reduce to their name", async () => {
    const error = serviceError("InvalidTimeRangeException");
    const { api } = fakeHistoryApi({ lookupError: error });
    const key = awsKey(FIXTURE.keyArn);
    await assert.rejects(
      readAwsSignHistory(key, { key, since: SINCE, until: UNTIL, limit: 100 }, api),
      (thrown: unknown) => thrown === error,
    );
    const odd = fakeHistoryApi({ lookupError: "a string" });
    await assert.rejects(
      readAwsSignHistory(key, { key, since: SINCE, until: UNTIL, limit: 100 }, odd.api),
      /a string/,
    );
  });

  it("stops on a record it cannot read, instead of leaving it out", async () => {
    for (const raw of [
      undefined,
      "not json",
      "[]",
      recorded(PLUGIN, { eventTime: "yesterday" }),
      recorded(PLUGIN, { eventTime: null }),
    ]) {
      await readFails({ pages: [page([raw])] }, ["not a readable event record"]);
    }
  });

  it("keeps the caller of a cross-account call, which has no principal ARN", async () => {
    const { result } = await read({ pages: [page([recorded(PLUGIN, identity("AWSAccount"))])] });

    const event = result.events[0];
    assert.equal(event?.principal, null);
    assert.equal(event.extra?.userIdentityType, "AWSAccount");
    assert.equal(event.extra?.crossAccount, true);
    assert.equal(event.extra?.sharedEventId, "11111111-2222-4333-8444-555555555555");
    assert.equal(event.extraIds?.callerAccountId, "444455556666");
    assert.equal(event.extraIds?.principalId, "AIDAEXAMPLEPRINCIPAL2");
  });

  it("keeps the user of an IAM Identity Center call, which has no principal ARN", async () => {
    const { result } = await read({
      pages: [page([recorded(PLUGIN, identity("IdentityCenterUser"))])],
    });

    const event = result.events[0];
    assert.equal(event?.principal, null);
    assert.equal(event.extra?.crossAccount, false);
    assert.equal(event.extraIds?.onBehalfOfUserId, "a1b2c3d4-0000-4000-8000-example00001");
    // The key's own account is not an id to hide: it would mask every principal ARN.
    assert.equal(event.extraIds?.callerAccountId, undefined);
  });

  it("keeps an assumed role's issuer and source identity, and an invoking delegate", async () => {
    const { result } = await read({
      pages: [
        page([
          recorded(PLUGIN, identity("AssumedRole")),
          recorded(PLUGIN, {
            userIdentity: {
              type: "AWSService",
              invokedBy: "kms.amazonaws.com",
              invokedByDelegate: { accountId: "444455556666" },
            },
          }),
        ]),
      ],
    });

    const [role, delegated] = result.events;
    assert.equal(
      role?.principal,
      "arn:aws:sts::111122223333:assumed-role/deployer/deployer-session",
    );
    assert.equal(role.extraIds?.sessionIssuerArn, "arn:aws:iam::111122223333:role/deployer");
    assert.equal(role.extraIds?.sourceIdentity, "ci-pipeline-identity");
    assert.equal(role.extra?.crossAccount, false);
    assert.equal(delegated?.extraIds?.invokedByDelegateAccountId, "444455556666");
    assert.equal(delegated.extra?.crossAccount, undefined);
  });

  it("is not complete for a multi-Region key, and says to read each replica", async () => {
    const mrkArn = "arn:aws:kms:us-east-1:111122223333:key/mrk-1234abcd12ab34cd56ef1234567890ab";
    const { result } = await read(
      {
        pages: [
          page([
            recorded(PLUGIN, {
              resources: [{ ARN: mrkArn }],
              requestParameters: { keyId: mrkArn },
            }),
          ]),
        ],
      },
      mrkArn,
    );

    assert.equal(result.events.length, 1);
    assert.equal(result.completeForKey, false);
    const note = result.notes?.find((each) => each.code === "multi-region-key");
    assert.match(note?.message ?? "", /each replica's key ARN/);
  });

  it("stops with scan-limit once the time budget is spent", async () => {
    let clock = 0;
    const { result, calls } = await read(
      { pages: () => page([], "more") },
      FIXTURE.keyArn,
      {},
      () => {
        clock += 20_000;
        return clock;
      },
    );

    // Started at 20 s; each page check adds 20 s, so the 90 s budget is spent after 5 pages.
    assert.equal(SCAN_BUDGET_MS, 90_000);
    assert.equal(calls.filter((call) => call.method === "lookupSignEvents").length, 5);
    assert.equal(result.truncatedReason, "scan-limit");
  });

  it("compares key ARNs without case", async () => {
    const { result } = await read({
      pages: [page([recorded(PLUGIN, { resources: [{ ARN: FIXTURE.keyArn.toUpperCase() }] })])],
    });

    assert.equal(result.events.length, 1);
  });

  it("attributes an event without resources by the key id the caller passed", async () => {
    const { result } = await read(
      {
        pages: [
          page([
            noResources(FIXTURE.keyArn.toUpperCase()),
            noResources(FIXTURE.keyId),
            noResources(FIXTURE.alias),
            noResources(OTHER_KEY_ARN),
            noResources("0000abcd-12ab-34cd-56ef-1234567890ab"),
          ]),
        ],
      },
      FIXTURE.alias,
    );

    assert.equal(result.events.length, 3);
    assert.equal(result.completeForKey, true);
  });

  it("counts events it cannot attribute, and never calls the history complete then", async () => {
    const { result } = await read({
      pages: [
        page([
          recorded(PLUGIN),
          recorded(PLUGIN, { resources: [], requestParameters: { keyId: "alias/unknown" } }),
          recorded(PLUGIN, { resources: undefined, requestParameters: null }),
          recorded(PLUGIN, {
            resources: undefined,
            requestParameters: { keyId: "alias/old" },
            eventTime: "2026-10-02T08:00:00Z",
          }),
        ]),
      ],
    });

    assert.equal(result.events.length, 1);
    assert.equal(result.completeForKey, false);
    const note = result.notes?.find((each) => each.code === "unattributed-events");
    assert.match(note?.message ?? "", /^2 Sign events in the range/);
    const one = await read({
      pages: [page([recorded(PLUGIN, { resources: [], requestParameters: {} })])],
    });
    assert.match(one.result.notes?.[0]?.message ?? "", /^1 Sign event in the range .* it is not/);
  });

  it("passes the signal to each call, and stops when it aborts", async () => {
    const controller = new AbortController();
    const { api, calls } = fakeHistoryApi({
      pages: () => page([recorded(PLUGIN)], "more"),
      onLookup: (index) => {
        if (index === 1) {
          controller.abort(new Error("deadline"));
        }
      },
    });
    const key = awsKey(FIXTURE.alias);
    await assert.rejects(
      readAwsSignHistory(
        key,
        { key, since: SINCE, until: UNTIL, limit: 100, signal: controller.signal },
        api,
        { sleep: async () => {} },
      ),
      /deadline/,
    );
    const lookups = calls.filter((call) => call.method === "lookupSignEvents");
    assert.equal(lookups.length, 2);
    for (const call of calls.filter((each) => each.signal !== undefined)) {
      assert.equal(call.signal, controller.signal);
    }
    assert.equal(calls.find((call) => call.method === "resolveKeyArn")?.signal, controller.signal);
  });

  it("waits between pages with a sleep that the signal ends", async () => {
    const controller = new AbortController();
    const { api } = fakeHistoryApi({ pages: () => page([], "more") });
    const key = awsKey(FIXTURE.keyArn);
    const reading = readAwsSignHistory(
      key,
      { key, since: SINCE, until: UNTIL, limit: 100, signal: controller.signal },
      api,
    );
    const started = Date.now();
    setImmediate(() => {
      controller.abort(new Error("stop"));
    });
    await assert.rejects(reading);
    assert.ok(Date.now() - started < PAGE_INTERVAL_MS, "the sleep did not end on abort");
  });
});
