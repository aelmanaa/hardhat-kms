import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GcpKmsKeyConfig, KmsHistoryRequest } from "hardhat-kms/types";

import {
  CALL_TIMEOUT_MS,
  CallTimedOut,
  digestHex,
  keyParts,
  type ListEntries,
  type ListEntriesRequest,
  MAX_PAGE_SIZE,
  PAGE_BUDGET,
  quote,
  readGcpSignHistory,
  RETRY_DELAYS_MS,
  SCAN_BUDGET_MS,
  signEntriesFilter,
} from "../../src/internal/history.ts";
import {
  CRYPTO_KEY_NAME,
  DIGEST_HEX,
  FAILED_SIGN,
  IPV6_SIGN,
  KEY_PATH,
  KEY_VERSION_NAME,
  kmsEntry,
  OAUTH_CLIENT,
  PLUGIN_SIGN,
  PLUGIN_USER_AGENT,
  PROJECT,
  PROJECT_NUMBER,
  SERVICE_ACCOUNT,
  SERVICE_ACCOUNT_SIGN,
  USER,
} from "../fixtures/logging-entries.ts";

const SINCE = new Date("2026-10-01T10:00:00Z");
const UNTIL = new Date("2026-10-02T10:00:00Z");
const NOW = new Date("2026-10-02T12:00:00Z").getTime();

function gcpKey(name: string = KEY_VERSION_NAME): GcpKmsKeyConfig {
  return {
    provider: "gcp",
    name: "deployer",
    timeoutMs: 1000,
    displayId: "gcp:<GCP_KEY_VERSION_NAME>",
    keyVersionName: {
      display: "<GCP_KEY_VERSION_NAME>",
      get: async () => await Promise.resolve(name),
    },
  };
}

function historyRequest(overrides: Partial<KmsHistoryRequest> = {}): KmsHistoryRequest {
  return {
    key: gcpKey(),
    since: SINCE,
    until: UNTIL,
    limit: 100,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/**
 * An `entries.list` that answers from a list of pages or errors, and records each request and the
 * time it was given.
 */
function fakeList(answers: Array<unknown>): {
  list: ListEntries;
  requests: ListEntriesRequest[];
  timeouts: number[];
} {
  const requests: ListEntriesRequest[] = [];
  const timeouts: number[] = [];
  const list: ListEntries = async (request, _signal, timeoutMs) => {
    requests.push(request);
    timeouts.push(timeoutMs);
    // Past the last answer, the log has no more entries.
    const answer: unknown = answers.length === 0 ? {} : answers.shift();
    if (answer instanceof Error) {
      throw answer;
    }
    return await Promise.resolve(answer);
  };
  return { list, requests, timeouts };
}

/** An error shaped as gaxios rejects for an HTTP error answer. */
function httpError(
  status: number,
  apiStatus: string,
  details: unknown[] = [],
): Error & { status: number; response: unknown } {
  return Object.assign(new Error(`request failed for ${PROJECT}`), {
    status,
    response: {
      status,
      data: { error: { code: status, message: `about ${PROJECT}`, status: apiStatus, details } },
    },
  });
}

/** An error shaped as gaxios rejects when the request got no answer. */
function networkError(code: string): Error {
  return Object.assign(new Error(`connect ${code} logging.googleapis.com`), {
    code,
    cause: Object.assign(new Error("inner"), { code }),
  });
}

const FIRST_DELAY_MS = RETRY_DELAYS_MS[0] ?? 0;
const noPause = async (): Promise<void> => {};
const options = { pause: noPause, now: () => NOW };

async function read(answers: unknown[], request: Partial<KmsHistoryRequest> = {}) {
  const fake = fakeList(answers);
  const result = await readGcpSignHistory(gcpKey(), historyRequest(request), fake.list, options);
  return { result, requests: fake.requests };
}

async function failure(
  answers: unknown[],
  request: Partial<KmsHistoryRequest> = {},
  pause: (ms: number, signal: AbortSignal) => Promise<void> = noPause,
): Promise<{ message: string; requests: ListEntriesRequest[] }> {
  const fake = fakeList(answers);
  const error: unknown = await readGcpSignHistory(gcpKey(), historyRequest(request), fake.list, {
    ...options,
    pause,
  }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof Error, "the read did not fail");
  assert.doesNotMatch(error.message, new RegExp(PROJECT), "the error names the project");
  return { message: error.message, requests: fake.requests };
}

/** A clock that only the fake calls and pauses move. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let time = NOW;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

/** A page with one entry, a token for the next page, and the time it took. */
function slowPages(clock: { advance: (ms: number) => void }, ms: number[]): ListEntries {
  let index = 0;
  return async () => {
    const took = ms[index] ?? 0;
    index++;
    clock.advance(took);
    const entry = kmsEntry({
      timestamp: `2026-10-02T0${index}:00:00Z`,
      insertId: `i-${index}`,
    });
    return await Promise.resolve({ entries: [entry], nextPageToken: `page-${index + 1}` });
  };
}

describe("the Google Cloud history reader", () => {
  describe("mapping recorded entries", () => {
    it("copies a plugin signature's fields as logged", async () => {
      const { result } = await read([{ entries: [PLUGIN_SIGN] }]);
      assert.deepEqual(result.events, [
        {
          time: "2026-10-02T09:06:06.982112024Z",
          operation: "AsymmetricSign",
          outcome: "success",
          errorCode: null,
          errorMessage: null,
          principal: USER,
          sourceIp: "203.0.113.7",
          userAgent: PLUGIN_USER_AGENT,
          requestId: null,
          keyVersion: "1",
          digest: `0x${DIGEST_HEX}`,
          keyResource: KEY_VERSION_NAME,
          // principalSubject is `user:` and the email, so it is left out.
          extra: {
            insertId: "insert-1",
            receiveTimestamp: "2026-10-02T09:06:06.982112024Z",
            statusCode: null,
          },
          extraIds: { oauthClientId: OAUTH_CLIENT },
        },
      ]);
    });

    it("keeps another client's signature, a redacted IP and another version of the key", async () => {
      const { result } = await read([{ entries: [SERVICE_ACCOUNT_SIGN] }]);
      const [event] = result.events;
      assert.equal(event?.principal, SERVICE_ACCOUNT);
      assert.equal(event?.sourceIp, "private");
      assert.match(event?.userAgent ?? "", /^google-cloud-sdk gcloud/);
      assert.equal(event?.keyVersion, "2");
      // The digest is lowercased, whatever case the log used.
      assert.equal(event?.digest, `0x${DIGEST_HEX}`);
      assert.equal(event?.extraIds, undefined);
      assert.equal(event?.extra?.principalSubject, undefined);
    });

    it("keeps a principal subject that says more than the email", async () => {
      const subjects: Array<[string, Record<string, string>]> = [
        ["other-email", { principalEmail: USER, principalSubject: "user:someone@example.com" }],
        ["not-a-type", { principalEmail: USER, principalSubject: `principal://x:${USER}` }],
        ["no-email", { principalSubject: `user:${USER}` }],
      ];
      const entries = subjects.map(([insertId, authenticationInfo], index) =>
        kmsEntry({ timestamp: `2026-10-02T0${index}:00:00Z`, insertId, authenticationInfo }),
      );
      const { result } = await read([{ entries }]);
      assert.deepEqual(
        result.events.map((event) => event.extra?.principalSubject),
        ["user:someone@example.com", `principal://x:${USER}`, `user:${USER}`],
      );
    });

    it("shows an IPv6 caller address as logged", async () => {
      const { result } = await read([{ entries: [IPV6_SIGN] }]);
      const [event] = result.events;
      assert.equal(event?.sourceIp, "2001:db8:85a3::8a2e:370:7334");
      // Not an id: it is not moved to extraIds, which --show-ids alone would show.
      assert.deepEqual(event?.extraIds, { oauthClientId: OAUTH_CLIENT });
      assert.ok(!Object.values(event?.extra ?? {}).includes(event?.sourceIp ?? ""));
    });

    it("marks a refused request as failed with its status, and falls back to the principal subject", async () => {
      const { result } = await read([{ entries: [FAILED_SIGN] }]);
      const [event] = result.events;
      assert.equal(event?.outcome, "failed");
      assert.equal(event?.errorCode, "NOT_FOUND");
      assert.match(event?.errorMessage ?? "", /not found\.$/);
      assert.equal(event?.principal, "principal://iam.googleapis.com/placeholder");
      assert.equal(event?.keyVersion, "999999");
      assert.equal(event?.extra?.statusCode, 5);
      assert.equal(event?.extra?.principalSubject, "principal://iam.googleapis.com/placeholder");
    });

    it("gives a status code with no name as its number, and a status message alone as a failure", async () => {
      const unknownCode = kmsEntry({
        timestamp: "2026-10-02T07:00:00Z",
        insertId: "insert-4",
        status: { code: 99 },
      });
      const messageOnly = kmsEntry({
        timestamp: "2026-10-02T06:00:00Z",
        insertId: "insert-5",
        status: { message: "refused" },
      });
      const { result } = await read([{ entries: [unknownCode, messageOnly] }]);
      assert.deepEqual(
        result.events.map((event) => [event.outcome, event.errorCode, event.errorMessage]),
        [
          ["failed", "99", null],
          ["failed", null, "refused"],
        ],
      );
    });

    it("leaves a field the entry does not hold empty, and invents none", async () => {
      const bare = {
        timestamp: "2026-10-02T05:00:00Z",
        protoPayload: { methodName: "AsymmetricSign", resourceName: KEY_VERSION_NAME },
      };
      const { result } = await read([{ entries: [bare] }]);
      assert.deepEqual(result.events[0], {
        time: "2026-10-02T05:00:00Z",
        operation: "AsymmetricSign",
        outcome: "success",
        errorCode: null,
        errorMessage: null,
        principal: null,
        sourceIp: null,
        userAgent: null,
        requestId: null,
        keyVersion: "1",
        digest: null,
        keyResource: KEY_VERSION_NAME,
        extra: { insertId: null, principalSubject: null, receiveTimestamp: null, statusCode: null },
      });
    });

    it("leaves out entries of a key whose name differs in case, other methods and times outside the range", async () => {
      const entries = [
        kmsEntry({
          timestamp: "2026-10-02T09:00:00Z",
          insertId: "other-case",
          cryptoKeyName: CRYPTO_KEY_NAME.toUpperCase(),
        }),
        kmsEntry({
          timestamp: "2026-10-02T09:00:00Z",
          insertId: "longer-name",
          cryptoKeyName: `${CRYPTO_KEY_NAME}-2`,
        }),
        kmsEntry({
          timestamp: "2026-10-02T09:00:00Z",
          insertId: "public-key",
          methodName: "GetPublicKey",
        }),
        kmsEntry({ timestamp: "2026-10-02T10:00:00.001Z", insertId: "after" }),
        kmsEntry({ timestamp: "2026-10-02T10:00:00Z", insertId: "at-until" }),
        kmsEntry({ timestamp: "2026-10-01T10:00:00Z", insertId: "at-since" }),
        kmsEntry({ timestamp: "2026-10-01T09:59:59.999999Z", insertId: "before" }),
      ];
      const { result } = await read([{ entries }]);
      assert.deepEqual(
        result.events.map((event) => event.extra?.insertId),
        ["at-until", "at-since"],
      );
    });

    it("finds the key's entries whether the config or the entry names the project by number", async () => {
      const byId = kmsEntry({ timestamp: "2026-10-02T09:00:00Z", insertId: "by-id" });
      const byNumber = kmsEntry({
        timestamp: "2026-10-02T08:00:00Z",
        insertId: "by-number",
        cryptoKeyName: CRYPTO_KEY_NAME.replace(PROJECT, PROJECT_NUMBER),
      });
      const numbered = KEY_VERSION_NAME.replace(PROJECT, PROJECT_NUMBER);
      for (const name of [KEY_VERSION_NAME, numbered]) {
        const fake = fakeList([{ entries: [byId, byNumber] }]);
        const result = await readGcpSignHistory(gcpKey(name), historyRequest(), fake.list, options);
        assert.deepEqual(
          result.events.map((event) => [event.extra?.insertId, event.keyVersion]),
          [
            ["by-id", "1"],
            ["by-number", "1"],
          ],
        );
        const [request] = fake.requests;
        assert.deepEqual(request?.resourceNames, [`projects/${name.split("/")[1] ?? ""}`]);
        // No clause names the project, so either form of it matches the same entries.
        assert.doesNotMatch(request?.filter ?? "", new RegExp(`${PROJECT}|${PROJECT_NUMBER}`));
      }
    });

    it("describes what the log cannot show, with no id outside scope.ids", async () => {
      const { result } = await read([{ entries: [] }]);
      assert.equal(result.source, "cloud-logging");
      assert.deepEqual(result.notLogged, ["requestId"]);
      assert.equal(result.completeForKey, false);
      assert.equal(result.truncated, false);
      assert.deepEqual(result.scope?.ids, { project: PROJECT });
      assert.match(result.setupHint ?? "", /Data Access audit logs \(DATA_READ\).*cloudkms/);
      assert.equal(result.deliveryDelayMinutes, undefined);
      assert.equal(result.retentionDays, undefined);
      assert.deepEqual(result.notes, []);
      const printed = JSON.stringify([result.source, result.scope?.description, result.setupHint]);
      assert.doesNotMatch(printed, /example-|deployer/);
    });

    it("notes the _Default bucket's retention for a range that starts more than 30 days ago", async () => {
      const { result } = await read([{ entries: [] }], {
        since: new Date(NOW - 31 * 24 * 60 * 60 * 1000),
      });
      assert.deepEqual(
        result.notes?.map((note) => note.code),
        ["default-retention"],
      );
      assert.match(result.notes?.[0]?.message ?? "", /30 days in the _Default bucket/);
    });
  });

  describe("digests", () => {
    it("reads hex in any case and protobuf's base64, and nothing else", () => {
      assert.equal(digestHex(DIGEST_HEX), `0x${DIGEST_HEX}`);
      assert.equal(digestHex(DIGEST_HEX.toUpperCase()), `0x${DIGEST_HEX}`);
      assert.equal(digestHex(Buffer.from(DIGEST_HEX, "hex").toString("base64")), `0x${DIGEST_HEX}`);
      assert.equal(digestHex(undefined), null);
      assert.equal(digestHex(42), null);
      assert.equal(digestHex(DIGEST_HEX.slice(2)), null);
      assert.equal(digestHex(`${DIGEST_HEX}00`), null);
    });
  });

  describe("the query", () => {
    it("filters the key's project log on AsymmetricSign for every version, in the range", async () => {
      const { requests } = await read([{ entries: [] }], { limit: 5 });
      assert.deepEqual(requests, [
        {
          resourceNames: [`projects/${PROJECT}`],
          filter: [
            'log_id("cloudaudit.googleapis.com/data_access")',
            'resource.type="cloudkms_cryptokeyversion"',
            'resource.labels.location="us-east1"',
            'resource.labels.key_ring_id="example-ring"',
            'resource.labels.crypto_key_id="deployer"',
            'protoPayload.methodName="AsymmetricSign"',
            `protoPayload.resourceName:"/${KEY_PATH}/cryptoKeyVersions/"`,
            'timestamp>="2026-10-01T10:00:00.000Z"',
            'timestamp<"2026-10-02T10:00:01.000Z"',
          ].join(" AND "),
          orderBy: "timestamp desc",
          pageSize: 6,
        },
      ]);
    });

    it("asks for at most 1000 entries a page", async () => {
      const { requests } = await read([{ entries: [] }], { limit: 1000 });
      assert.equal(requests[0]?.pageSize, MAX_PAGE_SIZE);
    });

    it("escapes quotes and backslashes in a quoted value", () => {
      assert.equal(quote('a"b\\c'), '"a\\"b\\\\c"');
      assert.equal(quote("plain"), '"plain"');
    });

    it("builds the filter only from parts of the config check's characters", () => {
      assert.equal(keyParts(KEY_VERSION_NAME)?.keyPath, KEY_PATH);
      for (const name of [
        KEY_VERSION_NAME.replace("deployer", 'deployer" OR "x'),
        KEY_VERSION_NAME.replace("deployer", "deployer\\"),
        KEY_VERSION_NAME.replace("deployer", "deployer key"),
        KEY_VERSION_NAME.replace("example-ring", ".."),
        KEY_VERSION_NAME.replace(/1$/, "0"),
        `${KEY_VERSION_NAME}/extra`,
      ]) {
        assert.equal(keyParts(name), undefined, name);
      }
      const parts = keyParts(KEY_VERSION_NAME);
      assert.ok(parts);
      assert.doesNotMatch(signEntriesFilter(parts, SINCE, UNTIL), /cryptoKeyVersions\/1"/);
    });

    it("refuses a key whose name would change the query, before any call", async () => {
      const fake = fakeList([{ entries: [] }]);
      await assert.rejects(
        readGcpSignHistory(
          gcpKey(KEY_VERSION_NAME.replace("deployer", 'x") OR ("')),
          historyRequest(),
          fake.list,
          options,
        ),
        /gcp, history, key gcp:<GCP_KEY_VERSION_NAME>: the key version name does not split/,
      );
      assert.equal(fake.requests.length, 0);
    });
  });

  describe("paging", () => {
    it("follows page tokens, including empty pages, to the end of the range", async () => {
      const { result, requests } = await read([
        { entries: [PLUGIN_SIGN], nextPageToken: "page-2" },
        { nextPageToken: "page-3" },
        { entries: [SERVICE_ACCOUNT_SIGN], nextPageToken: "" },
      ]);
      assert.deepEqual(
        requests.map((request) => request.pageToken),
        [undefined, "page-2", "page-3"],
      );
      assert.equal(result.events.length, 2);
      assert.equal(result.truncated, false);
    });

    it("stops at limit + 1 events and says the limit cut the history", async () => {
      const entries = Array.from({ length: 4 }, (_, index) =>
        kmsEntry({ timestamp: `2026-10-02T0${index}:00:00Z`, insertId: `insert-${index}` }),
      );
      const { result, requests } = await read(
        [
          { entries: entries.slice(0, 2), nextPageToken: "page-2" },
          { entries: entries.slice(2), nextPageToken: "page-3" },
        ],
        { limit: 2 },
      );
      assert.equal(requests.length, 2);
      assert.equal(result.events.length, 3);
      assert.equal(result.truncated, true);
      assert.equal(result.truncatedReason, "limit");
    });

    it("stops after its page budget and says the range was not read in full", async () => {
      const pages = Array.from({ length: PAGE_BUDGET + 1 }, (_, index) => ({
        nextPageToken: `page-${index + 2}`,
      }));
      const { result, requests } = await read(pages);
      assert.equal(requests.length, PAGE_BUDGET);
      assert.deepEqual(result.events, []);
      assert.equal(result.truncated, true);
      assert.equal(result.truncatedReason, "scan-limit");
    });
  });

  describe("the scan budget", () => {
    it("stops with scan-limit when the budget is spent between pages, and keeps what it read", async () => {
      const clock = fakeClock();
      const timeouts: number[] = [];
      const pages = slowPages(clock, [50_000, 45_000, 1]);
      const list: ListEntries = async (request, signal, timeoutMs) => {
        timeouts.push(timeoutMs);
        return await pages(request, signal, timeoutMs);
      };
      const result = await readGcpSignHistory(gcpKey(), historyRequest(), list, {
        pause: noPause,
        now: clock.now,
      });
      assert.deepEqual(timeouts, [CALL_TIMEOUT_MS, CALL_TIMEOUT_MS]);
      assert.deepEqual(
        result.events.map((event) => event.extra?.insertId),
        ["i-1", "i-2"],
      );
      assert.equal(result.truncated, true);
      assert.equal(result.truncatedReason, "scan-limit");
    });

    it("gives a call only what is left of the budget, and stops when that runs out", async () => {
      const clock = fakeClock();
      const timeouts: number[] = [];
      const list: ListEntries = async (_request, _signal, timeoutMs) => {
        timeouts.push(timeoutMs);
        if (timeouts.length === 1) {
          clock.advance(SCAN_BUDGET_MS - 20_000);
          return await Promise.resolve({ entries: [PLUGIN_SIGN], nextPageToken: "page-2" });
        }
        // The call runs to the deadline it was given.
        clock.advance(timeoutMs);
        throw new CallTimedOut(timeoutMs);
      };
      const result = await readGcpSignHistory(gcpKey(), historyRequest(), list, {
        pause: noPause,
        now: clock.now,
      });
      // No retry: the timeout was the budget's end, not the call's own 30 seconds.
      assert.deepEqual(timeouts, [CALL_TIMEOUT_MS, 20_000]);
      assert.equal(result.events.length, 1);
      assert.equal(result.truncatedReason, "scan-limit");
    });

    it("returns what it read when the budget cuts short the retry of a timed-out call", async () => {
      const clock = fakeClock();
      const timeouts: number[] = [];
      const list: ListEntries = async (_request, _signal, timeoutMs) => {
        timeouts.push(timeoutMs);
        if (timeouts.length === 1) {
          clock.advance(50_000);
          return await Promise.resolve({ entries: [PLUGIN_SIGN], nextPageToken: "page-2" });
        }
        clock.advance(timeoutMs);
        throw new CallTimedOut(timeoutMs);
      };
      const result = await readGcpSignHistory(gcpKey(), historyRequest(), list, {
        pause: noPause,
        now: clock.now,
      });
      // The second timeout would fail the read, but it was the budget's end, not the call's.
      assert.deepEqual(timeouts, [CALL_TIMEOUT_MS, CALL_TIMEOUT_MS, SCAN_BUDGET_MS - 80_000]);
      assert.equal(result.events.length, 1);
      assert.equal(result.truncatedReason, "scan-limit");
    });

    it("does not pause for a retry that the budget cannot wait for", async () => {
      const clock = fakeClock();
      const pauses: number[] = [];
      const fake = fakeList([
        { entries: [PLUGIN_SIGN], nextPageToken: "page-2" },
        httpError(503, "UNAVAILABLE"),
      ]);
      const list: ListEntries = async (request, signal, timeoutMs) => {
        clock.advance(SCAN_BUDGET_MS / 2 - 100);
        return await fake.list(request, signal, timeoutMs);
      };
      const result = await readGcpSignHistory(gcpKey(), historyRequest(), list, {
        pause: async (ms) => {
          pauses.push(ms);
          await Promise.resolve();
        },
        now: clock.now,
      });
      assert.equal(fake.requests.length, 2);
      assert.deepEqual(pauses, []);
      assert.equal(result.events.length, 1);
      assert.equal(result.truncatedReason, "scan-limit");
    });

    it("stops before a retry when the pause spent the budget", async () => {
      const clock = fakeClock();
      const fake = fakeList([httpError(429, "RESOURCE_EXHAUSTED"), { entries: [PLUGIN_SIGN] }]);
      const list: ListEntries = async (request, signal, timeoutMs) => {
        clock.advance(SCAN_BUDGET_MS - FIRST_DELAY_MS - 1);
        return await fake.list(request, signal, timeoutMs);
      };
      const result = await readGcpSignHistory(gcpKey(), historyRequest(), list, {
        pause: async (ms) => {
          clock.advance(ms + 1);
          await Promise.resolve();
        },
        now: clock.now,
      });
      assert.equal(fake.requests.length, 1);
      assert.deepEqual(result.events, []);
      assert.equal(result.truncated, true);
      assert.equal(result.truncatedReason, "scan-limit");
    });
  });

  describe("errors", () => {
    it("retries a throttled read, then names the quota", async () => {
      const pauses: number[] = [];
      const { message, requests } = await failure(
        [
          httpError(429, "RESOURCE_EXHAUSTED"),
          httpError(429, "RESOURCE_EXHAUSTED"),
          httpError(429, "RESOURCE_EXHAUSTED"),
        ],
        {},
        async (ms) => {
          pauses.push(ms);
          await Promise.resolve();
        },
      );
      assert.equal(requests.length, 3);
      assert.deepEqual(pauses, RETRY_DELAYS_MS);
      assert.match(message, /too frequent \(60 per minute\)/);
    });

    it("reads on after a throttled call that a retry gets through", async () => {
      const { result, requests } = await read([
        httpError(429, "RESOURCE_EXHAUSTED"),
        { entries: [PLUGIN_SIGN] },
      ]);
      assert.equal(requests.length, 2);
      assert.equal(result.events.length, 1);
    });

    it("names the permission and the role when the read is refused", async () => {
      const { message, requests } = await failure([httpError(403, "PERMISSION_DENIED")]);
      assert.equal(requests.length, 1);
      assert.match(
        message,
        /lack logging\.privateLogEntries\.list \(roles\/logging\.privateLogViewer\)/,
      );
    });

    it("says so when the Cloud Logging API is disabled for the quota project", async () => {
      const { message } = await failure([
        httpError(403, "PERMISSION_DENIED", [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" },
        ]),
      ]);
      assert.match(message, /Cloud Logging API is disabled .*\(SERVICE_DISABLED\)/);
    });

    it("explains refused and missing credentials", async () => {
      assert.match(
        (await failure([httpError(401, "UNAUTHENTICATED")])).message,
        /credentials were refused \(UNAUTHENTICATED\)/,
      );
      assert.match(
        (await failure([new Error("Could not load the default credentials. Browse to …")])).message,
        /no Google Cloud credentials found/,
      );
    });

    it("gives the HTTP status and its name for other answers, without the server's message", async () => {
      assert.match(
        (await failure([httpError(400, "INVALID_ARGUMENT")])).message,
        /entries failed \(400 INVALID_ARGUMENT\)$/,
      );
      const notFound = httpError(404, "not a status name");
      assert.match((await failure([notFound])).message, /entries failed \(404\)$/);
    });

    it("retries a server error twice", async () => {
      const { message, requests } = await failure([
        httpError(503, "UNAVAILABLE"),
        httpError(500, "INTERNAL"),
        httpError(503, "UNAVAILABLE"),
      ]);
      assert.equal(requests.length, 3);
      assert.match(message, /\(503 UNAVAILABLE\)$/);
    });

    it("retries a request that got no answer, then gives the network code", async () => {
      const { message, requests } = await failure([
        networkError("ECONNREFUSED"),
        networkError("ECONNREFUSED"),
        networkError("ECONNREFUSED"),
      ]);
      assert.equal(requests.length, 3);
      assert.match(message, /could not reach Cloud Logging \(ECONNREFUSED\), after 3 attempts/);
      const causeOnly = Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("inner"), { code: "ENOTFOUND" }),
      });
      assert.match((await failure([causeOnly, causeOnly, causeOnly])).message, /\(ENOTFOUND\)/);
    });

    it("retries a call that got no answer in time once, then says so", async () => {
      const { message, requests } = await failure([
        new CallTimedOut(30_000),
        new CallTimedOut(30_000),
        { entries: [] },
      ]);
      assert.equal(requests.length, 2);
      assert.match(message, /did not answer within 30 seconds, after 2 attempts/);
    });

    it("gives a timeout after other failures its one retry too", async () => {
      const { message, requests } = await failure([
        httpError(503, "UNAVAILABLE"),
        new CallTimedOut(30_000),
        new CallTimedOut(30_000),
      ]);
      assert.equal(requests.length, 3);
      assert.match(message, /after 3 attempts/);
    });

    it("does not take Node's own ERR_ codes for a network code", async () => {
      const odd = Object.assign(new Error("invalid"), { code: "ERR_INVALID_ARG_TYPE" });
      const fake = fakeList([odd]);
      await assert.rejects(
        readGcpSignHistory(gcpKey(), historyRequest(), fake.list, options),
        (error) => error === odd,
      );
      assert.equal(fake.requests.length, 1);
    });

    it("passes any other error on as it is, for the core to reduce to its class name", async () => {
      const odd = new TypeError("odd");
      const fake = fakeList([odd]);
      await assert.rejects(
        readGcpSignHistory(gcpKey(), historyRequest(), fake.list, options),
        (error) => error === odd,
      );
    });

    it("fails on an answer it cannot read, rather than show part of the history", async () => {
      const cases: Array<[unknown, RegExp]> = [
        [[], /the answer is not an object/],
        [null, /the answer is not an object/],
        [{ entries: {} }, /entries is not a list/],
        [{ entries: [], nextPageToken: 7 }, /nextPageToken is not a string/],
        [{ entries: [{ protoPayload: {} }] }, /an entry has no protoPayload/],
        [{ entries: [{ timestamp: "2026-10-02T09:00:00Z" }] }, /an entry has no protoPayload/],
        [
          {
            entries: [
              {
                timestamp: "yesterday",
                protoPayload: { methodName: "AsymmetricSign", resourceName: KEY_VERSION_NAME },
              },
            ],
          },
          /timestamp that is not a date/,
        ],
      ];
      for (const [answer, expected] of cases) {
        const { message } = await failure([answer]);
        assert.match(message, /Cloud Logging answered in a form this plugin does not read/);
        assert.match(message, expected);
      }
    });
  });

  describe("the signal", () => {
    it("makes no call once the signal has aborted", async () => {
      const controller = new AbortController();
      controller.abort(new Error("stop"));
      const fake = fakeList([{ entries: [PLUGIN_SIGN] }]);
      await assert.rejects(
        readGcpSignHistory(
          gcpKey(),
          historyRequest({ signal: controller.signal }),
          fake.list,
          options,
        ),
        /stop/,
      );
      assert.equal(fake.requests.length, 0);
    });

    it("passes the signal to each call and stops paging when it aborts", async () => {
      const controller = new AbortController();
      const seen: AbortSignal[] = [];
      const list: ListEntries = async (_request, signal) => {
        seen.push(signal);
        controller.abort(new Error("deadline"));
        return await Promise.resolve({ entries: [PLUGIN_SIGN], nextPageToken: "page-2" });
      };
      await assert.rejects(
        readGcpSignHistory(gcpKey(), historyRequest({ signal: controller.signal }), list, options),
        /deadline/,
      );
      assert.deepEqual(seen, [controller.signal]);
    });

    it("does not retry a call that failed because the signal aborted", async () => {
      const controller = new AbortController();
      let calls = 0;
      const list: ListEntries = async () => {
        calls++;
        controller.abort(new Error("deadline"));
        return await Promise.reject(networkError("ECONNRESET"));
      };
      await assert.rejects(
        readGcpSignHistory(gcpKey(), historyRequest({ signal: controller.signal }), list, options),
        /deadline/,
      );
      assert.equal(calls, 1);
    });

    it("ends a pause before a retry when the signal aborts", async () => {
      const controller = new AbortController();
      const fake = fakeList([httpError(503, "UNAVAILABLE"), { entries: [] }]);
      const started = Date.now();
      const reading = readGcpSignHistory(
        gcpKey(),
        historyRequest({ signal: controller.signal }),
        fake.list,
        { now: () => NOW },
      );
      setTimeout(() => {
        controller.abort(new Error("deadline"));
      }, 20);
      await assert.rejects(reading, /deadline/);
      assert.ok(Date.now() - started < FIRST_DELAY_MS, "the pause ran to its end");
      assert.equal(fake.requests.length, 1);
    });

    it("reads without a signal when the caller gives none", async () => {
      const fake = fakeList([{ entries: [PLUGIN_SIGN] }]);
      const { key, since, until, limit } = historyRequest();
      const result = await readGcpSignHistory(
        gcpKey(),
        { key, since, until, limit },
        fake.list,
        options,
      );
      assert.equal(result.events.length, 1);
    });

    it("waits the real pause before a retry by default", async () => {
      const fake = fakeList([httpError(503, "UNAVAILABLE"), { entries: [] }]);
      const started = Date.now();
      await readGcpSignHistory(gcpKey(), historyRequest(), fake.list, {});
      assert.ok(Date.now() - started >= FIRST_DELAY_MS - 5);
    });
  });
});
