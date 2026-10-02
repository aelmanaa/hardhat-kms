import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildHistoryReport,
  historyNotes,
  type HistoryReportInput,
  renderHistoryTable,
} from "../../../src/internal/history/report.ts";
import { historyEvent, historyResult, PLACEHOLDERS } from "../../helpers/fake-history-reader.ts";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const OLD_RANGE = {
  since: new Date("2026-10-01T00:00:00Z"),
  until: new Date("2026-10-02T00:00:00Z"),
};

const codes = (notes: Array<{ code: string }>) => notes.map((note) => note.code);

describe("historyNotes", () => {
  it("adds no note to a result with events in a settled range inside the retention", () => {
    assert.deepEqual(historyNotes(historyResult(), OLD_RANGE, NOW), []);
  });

  it("says that an empty result does not confirm logging, with the reader's hint, unless logging is always on", () => {
    const notes = historyNotes(
      historyResult({ events: [], completeForKey: false, setupHint: "Turn on Data Access logs." }),
      OLD_RANGE,
      NOW,
    );

    assert.deepEqual(notes, [
      {
        code: "logging-not-confirmed",
        message:
          "The log returned no sign events in this range. That does not show that the key signed nothing: logging may be off or sent elsewhere, or this read may not see every sign request on the key, such as those from another account or Region. Turn on Data Access logs.",
      },
    ]);
    assert.doesNotMatch(notes[0]?.message ?? "", /no signatures/i);
    assert.deepEqual(
      codes(historyNotes(historyResult({ events: [], completeForKey: true }), OLD_RANGE, NOW)),
      [],
    );
    assert.deepEqual(
      codes(historyNotes(historyResult({ completeForKey: false }), OLD_RANGE, NOW)),
      [],
    );
    assert.equal(
      historyNotes(historyResult({ events: [], completeForKey: false }), OLD_RANGE, NOW)[0]
        ?.message,
      "The log returned no sign events in this range. That does not show that the key signed nothing: logging may be off or sent elsewhere, or this read may not see every sign request on the key, such as those from another account or Region.",
    );
  });

  it("says the reader found no sign events before it stopped, for a truncated empty result", () => {
    assert.match(
      historyNotes(
        historyResult({
          events: [],
          completeForKey: false,
          truncated: true,
          truncatedReason: "scan-limit",
        }),
        OLD_RANGE,
        NOW,
      )[0]?.message ?? "",
      /^The reader found no sign events before it stopped\. That does not show that the key signed nothing/,
    );
  });

  it("warns when the range ends within 15 minutes of now, with the provider's documented delay", () => {
    const until = (minutesAgo: number) => ({
      since: OLD_RANGE.since,
      until: new Date(NOW.getTime() - minutesAgo * MINUTE),
    });

    assert.deepEqual(historyNotes(historyResult(), until(14), NOW), [
      {
        code: "recent-events-may-be-missing",
        message:
          "Events from the last 15 minutes may not be in the log yet: the provider documents a delivery delay of about 5 minutes for fake-audit-log.",
      },
    ]);
    assert.deepEqual(codes(historyNotes(historyResult(), until(15), NOW)), []);
    assert.equal(
      historyNotes(historyResult({ deliveryDelayMinutes: undefined }), until(0), NOW)[0]?.message,
      "Events from the last 15 minutes may not be in the log yet: the provider does not document how long fake-audit-log takes to deliver events.",
    );
  });

  it("widens the recent window to a documented delay longer than 15 minutes", () => {
    const result = historyResult({ deliveryDelayMinutes: 30 });
    const until = (minutesAgo: number) => ({
      since: OLD_RANGE.since,
      until: new Date(NOW.getTime() - minutesAgo * MINUTE),
    });

    assert.deepEqual(codes(historyNotes(result, until(29), NOW)), ["recent-events-may-be-missing"]);
    assert.match(historyNotes(result, until(29), NOW)[0]?.message ?? "", /last 30 minutes/);
    assert.deepEqual(codes(historyNotes(result, until(30), NOW)), []);
  });

  it("warns when the range starts before the log's retention, and not when it does not say", () => {
    const since = (daysAgo: number) => ({
      since: new Date(NOW.getTime() - daysAgo * DAY),
      until: OLD_RANGE.until,
    });

    assert.deepEqual(historyNotes(historyResult(), since(91), NOW), [
      {
        code: "before-retention",
        message:
          "The log keeps 90 days of events, so it holds none from before 2026-07-04T12:00:00.000Z.",
      },
    ]);
    assert.deepEqual(codes(historyNotes(historyResult(), since(90), NOW)), []);
    assert.deepEqual(
      codes(historyNotes(historyResult({ retentionDays: undefined }), since(400), NOW)),
      [],
    );
  });

  it("puts the plugin's notes first, then the reader's", () => {
    const notes = historyNotes(
      historyResult({
        events: [],
        completeForKey: false,
        notes: [{ code: "other-account", message: "Another account." }],
      }),
      { since: new Date(NOW.getTime() - 100 * DAY), until: NOW },
      NOW,
    );

    assert.deepEqual(codes(notes), [
      "logging-not-confirmed",
      "recent-events-may-be-missing",
      "before-retention",
      "other-account",
    ]);
  });
});

function input(overrides: Partial<HistoryReportInput> = {}): HistoryReportInput {
  return {
    name: "deployer",
    key: { provider: "aws", displayId: "aws:<AWS_KMS_KEY_ID>" },
    range: OLD_RANGE,
    result: historyResult(),
    notes: [],
    showIds: false,
    hidden: { keys: [], others: [] },
    ...overrides,
  };
}

describe("buildHistoryReport", () => {
  it("builds the version 1 report, with the key resource shown as the display id and no ids", () => {
    const report = buildHistoryReport(input());

    assert.deepEqual(report, {
      version: 1,
      key: { name: "deployer", provider: "aws", displayId: "aws:<AWS_KMS_KEY_ID>" },
      source: "fake-audit-log",
      range: { since: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z" },
      scope: null,
      notLogged: ["keyVersion", "digest"],
      events: [
        {
          time: "2026-10-02T09:14:03.512Z",
          operation: "Sign",
          outcome: "success",
          error: null,
          principal: "arn:aws:iam::111122223333:role/deployer",
          sourceIp: "203.0.113.7",
          userAgent: "aws-sdk-js/3.0.0 hardhat-kms/0.0.0",
          requestId: "11111111-2222-3333-4444-555555555555",
          keyVersion: null,
          digest: null,
          keyResource: "aws:<AWS_KMS_KEY_ID>",
          extra: { readOnly: true },
        },
      ],
      truncated: false,
      truncatedReason: null,
      notes: [],
    });
  });

  it("keeps only the error code of a failed event without --show-ids", () => {
    const failed = historyEvent({
      outcome: "failed",
      errorCode: "AccessDeniedException",
      errorMessage: PLACEHOLDERS.errorMessage,
    });
    const report = buildHistoryReport(input({ result: historyResult({ events: [failed] }) }));

    assert.deepEqual(report.events[0]?.error, { code: "AccessDeniedException", message: null });
    assert.doesNotMatch(JSON.stringify(report), /PLACEHOLDER/);
  });

  it("shows key resources, error messages and extraIds with --show-ids", () => {
    const failed = historyEvent({
      outcome: "failed",
      errorCode: "AccessDeniedException",
      errorMessage: PLACEHOLDERS.errorMessage,
    });
    const report = buildHistoryReport(
      input({ result: historyResult({ events: [failed] }), showIds: true }),
    );

    assert.deepEqual(report.events[0]?.error, {
      code: "AccessDeniedException",
      message: PLACEHOLDERS.errorMessage,
    });
    assert.equal(report.events[0]?.keyResource, PLACEHOLDERS.keyArn);
    assert.deepEqual(report.events[0]?.extra, {
      readOnly: true,
      accessKeyId: PLACEHOLDERS.accessKeyId,
    });
  });

  it("replaces key values found in any other field with the display id and other values with <hidden>, longest first", () => {
    const configured = "arn:aws:kms:eu-west-1:111122223333:alias/CONFIGURED-PLACEHOLDER";
    const event = historyEvent({
      principal: `assumed ${PLACEHOLDERS.keyArn}`,
      userAgent: `ua ${PLACEHOLDERS.accessKeyId}`,
      requestId: configured,
      operation: `Sign ${configured}`,
      outcome: "failed",
      errorCode: PLACEHOLDERS.accessKeyId,
      errorMessage: null,
      sourceIp: PLACEHOLDERS.keyArn,
      extra: { requestKeyId: PLACEHOLDERS.keyArn, count: 2, flag: false, none: null },
    });
    const report = buildHistoryReport(
      input({
        result: historyResult({ events: [event] }),
        notes: [
          { code: "reader-note", message: `key ${PLACEHOLDERS.keyArn} is in another account` },
        ],
        // Short values are never hidden, so they cannot garble ordinary text.
        hidden: { keys: [configured, "Sign", "aws"], others: [] },
      }),
    );
    const text = JSON.stringify(report);

    assert.doesNotMatch(text, /PLACEHOLDER/);
    const [entry] = report.events;
    assert.equal(entry?.principal, "assumed aws:<AWS_KMS_KEY_ID>");
    // An extraIds value is not the key: it never prints as the key's display id.
    assert.equal(entry?.userAgent, "ua <hidden>");
    assert.equal(entry?.requestId, "aws:<AWS_KMS_KEY_ID>");
    assert.equal(entry?.operation, "Sign aws:<AWS_KMS_KEY_ID>");
    assert.equal(entry?.sourceIp, "aws:<AWS_KMS_KEY_ID>");
    assert.deepEqual(entry?.error, { code: "<hidden>", message: null });
    assert.deepEqual(entry?.extra, {
      requestKeyId: "aws:<AWS_KMS_KEY_ID>",
      count: 2,
      flag: false,
      none: null,
    });
    assert.equal(report.notes[0]?.message, "key aws:<AWS_KMS_KEY_ID> is in another account");
  });

  it("hides the reader's hidden values and the parts of a key resource, in any case", () => {
    const keyId = "1234abcd-12ab-34cd-56ef-1234567890ab";
    const event = historyEvent({
      keyResource: `arn:aws:kms:eu-west-1:111122223333:key/${keyId}`,
      principal: "assumed alias/READER-HIDDEN-ALIAS",
      userAgent: `cli --key-id ${keyId.toUpperCase()}`,
    });
    const report = buildHistoryReport(
      input({
        result: historyResult({ events: [event], hiddenValues: ["alias/reader-hidden-alias"] }),
      }),
    );

    assert.equal(report.events[0]?.principal, "assumed <hidden>");
    assert.equal(report.events[0]?.userAgent, "cli --key-id aws:<AWS_KMS_KEY_ID>");
  });

  it("masks a key resource in its URL-encoded and \\/-escaped forms, and an Azure vault by its host, name and resource id", () => {
    const keyUrl =
      "https://secret-vault.vault.azure.net/keys/deployer/0123456789abcdef0123456789abcdef";
    const event = historyEvent({
      keyResource: keyUrl,
      extra: {
        encoded: `GET ${encodeURIComponent(keyUrl)}`,
        escaped: keyUrl.replaceAll("/", "\\/"),
        resource:
          "/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/secret-vault",
        host: "SECRET-VAULT.vault.azure.net",
        name: "vault secret-vault",
      },
    });
    const report = buildHistoryReport(input({ result: historyResult({ events: [event] }) }));

    assert.deepEqual(report.events[0]?.extra, {
      encoded: "GET aws:<AWS_KMS_KEY_ID>",
      escaped: "aws:<AWS_KMS_KEY_ID>",
      resource: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/<hidden>",
      host: "<hidden>",
      name: "vault <hidden>",
    });
  });

  it("masks other values as <hidden>, never as the key: a workspace id, variable parts, extraIds and scope ids", () => {
    const workspace = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const event = historyEvent({
      principal: "signer@secret-project.iam.gserviceaccount.com in 999988887777",
      userAgent: `ua ${workspace} ${PLACEHOLDERS.accessKeyId}`,
      extra: { project: "secret-project", account: "999988887777" },
    });
    const report = buildHistoryReport(
      input({
        result: historyResult({
          events: [event],
          scope: { description: "account 999988887777", ids: { account: "999988887777" } },
        }),
        notes: [{ code: "reader-note", message: `workspace ${workspace.toUpperCase()}` }],
        hidden: { keys: [], others: [workspace, "secret-project"] },
      }),
    );
    const [entry] = report.events;

    assert.equal(entry?.userAgent, "ua <hidden> <hidden>");
    assert.deepEqual(entry?.extra, { project: "<hidden>", account: "<hidden>" });
    assert.equal(report.scope, "account <hidden>, account <hidden>");
    assert.equal(report.notes[0]?.message, "workspace <hidden>");
    // Principals are shown as logged: a scope id stays, a hidden project is masked in an email.
    assert.equal(entry?.principal, "signer@<hidden>.iam.gserviceaccount.com in 999988887777");
    // The display id stands only for the key.
    assert.doesNotMatch(
      JSON.stringify({ ...entry, keyResource: null, notes: report.notes, scope: report.scope }),
      /AWS_KMS_KEY_ID/,
    );
  });

  it("prints the scope with its ids hidden, and in full with --show-ids", () => {
    const result = historyResult({
      scope: { description: `us-east-1 ${PLACEHOLDERS.keyArn}`, ids: { account: "999988887777" } },
    });

    assert.equal(
      buildHistoryReport(input({ result })).scope,
      "account <hidden>, us-east-1 aws:<AWS_KMS_KEY_ID>",
    );
    assert.equal(
      buildHistoryReport(input({ result, showIds: true })).scope,
      `account 999988887777, us-east-1 ${PLACEHOLDERS.keyArn}`,
    );
    assert.equal(
      buildHistoryReport(input({ result: historyResult({ scope: { description: "eu-west-1" } }) }))
        .scope,
      "eu-west-1",
    );
  });

  it("gives the truncation reason only for a truncated result", () => {
    assert.equal(
      buildHistoryReport(input({ result: historyResult({ truncated: true }) })).truncatedReason,
      "limit",
    );
    assert.equal(
      buildHistoryReport(
        input({ result: historyResult({ truncated: true, truncatedReason: "scan-limit" }) }),
      ).truncatedReason,
      "scan-limit",
    );
  });

  it("hides nothing with --show-ids", () => {
    const event = historyEvent({ principal: `assumed ${PLACEHOLDERS.keyArn}` });
    const report = buildHistoryReport(
      input({
        result: historyResult({ events: [event] }),
        showIds: true,
        hidden: { keys: ["x".repeat(9)], others: ["y".repeat(9)] },
      }),
    );

    assert.equal(report.events[0]?.principal, `assumed ${PLACEHOLDERS.keyArn}`);
  });

  it("keeps null fields null and a missing key resource null", () => {
    const event = historyEvent({
      principal: null,
      sourceIp: null,
      userAgent: null,
      requestId: null,
      keyResource: null,
      extra: undefined,
      extraIds: undefined,
      outcome: "failed",
      errorCode: null,
    });
    const [entry] = buildHistoryReport(
      input({ result: historyResult({ events: [event] }) }),
    ).events;

    assert.equal(entry?.principal, null);
    assert.equal(entry?.sourceIp, null);
    assert.equal(entry?.userAgent, null);
    assert.equal(entry?.requestId, null);
    assert.equal(entry?.keyResource, null);
    assert.deepEqual(entry?.extra, {});
    assert.deepEqual(entry?.error, { code: null, message: null });
  });
});

describe("renderHistoryTable", () => {
  it("prints a header, then one row per event with its details, and no column for a field that is not logged", () => {
    const report = buildHistoryReport(
      input({
        result: historyResult({
          events: [
            historyEvent({ time: "2026-10-02T09:14:03.512Z" }),
            historyEvent({
              time: "2026-10-01T08:00:00.000Z",
              outcome: "failed",
              errorCode: "AccessDeniedException",
              errorMessage: "denied",
              principal: null,
              extra: {},
            }),
          ],
        }),
      }),
    );

    assert.deepEqual(renderHistoryTable(report), [
      "Sign events of deployer (aws:<AWS_KMS_KEY_ID>), from fake-audit-log",
      "2026-10-01T00:00:00.000Z to 2026-10-02T00:00:00.000Z, newest first",
      "Not logged by this provider: key version, digest",
      "",
      "TIME                      OPERATION  OUTCOME                         PRINCIPAL                                SOURCE IP",
      "2026-10-02T09:14:03.512Z  Sign       success                         arn:aws:iam::111122223333:role/deployer  203.0.113.7",
      "  user agent (client-reported): aws-sdk-js/3.0.0 hardhat-kms/0.0.0",
      "  request id: 11111111-2222-3333-4444-555555555555",
      "  readOnly: true",
      "2026-10-01T08:00:00.000Z  Sign       failed (AccessDeniedException)  -                                        203.0.113.7",
      "  user agent (client-reported): aws-sdk-js/3.0.0 hardhat-kms/0.0.0",
      "  request id: 11111111-2222-3333-4444-555555555555",
    ]);
  });

  it("shows every column and line when the provider logs every field, and the details --show-ids reveals", () => {
    const digest = `0x${"ab".repeat(32)}`;
    const report = buildHistoryReport(
      input({
        showIds: true,
        result: historyResult({
          notLogged: [],
          events: [
            historyEvent({
              keyVersion: "1",
              digest,
              outcome: "failed",
              errorCode: null,
              errorMessage: "denied",
              userAgent: null,
              extra: { none: null },
            }),
          ],
        }),
      }),
    );
    const lines = renderHistoryTable(report);

    assert.equal(lines[2], "");
    assert.match(lines[3] ?? "", /^TIME +OPERATION +OUTCOME +PRINCIPAL +SOURCE IP +KEY VERSION$/);
    assert.match(lines[4] ?? "", /failed \(no code\) .* 1$/);
    assert.deepEqual(lines.slice(5), [
      "  user agent (client-reported): -",
      "  request id: 11111111-2222-3333-4444-555555555555",
      `  digest: ${digest}`,
      `  key: ${PLACEHOLDERS.keyArn}`,
      "  error: denied",
      "  none: -",
      `  accessKeyId: ${PLACEHOLDERS.accessKeyId}`,
    ]);
  });

  it("prints the scope in the header", () => {
    const report = buildHistoryReport(
      input({
        result: historyResult({
          events: [],
          scope: { description: "us-east-1", ids: { account: "999988887777" } },
        }),
      }),
    );

    assert.deepEqual(renderHistoryTable(report).slice(0, 4), [
      "Sign events of deployer (aws:<AWS_KMS_KEY_ID>), from fake-audit-log",
      "2026-10-01T00:00:00.000Z to 2026-10-02T00:00:00.000Z, newest first",
      "Scope: account <hidden>, us-east-1",
      "Not logged by this provider: key version, digest",
    ]);
  });

  it("says the log has no sign events in the range, never that the key made no signatures", () => {
    const lines = renderHistoryTable(
      buildHistoryReport(input({ result: historyResult({ events: [], notLogged: [] }) })),
    );

    assert.deepEqual(lines, [
      "Sign events of deployer (aws:<AWS_KMS_KEY_ID>), from fake-audit-log",
      "2026-10-01T00:00:00.000Z to 2026-10-02T00:00:00.000Z, newest first",
      "",
      "No sign events in fake-audit-log for this range.",
    ]);
  });

  it("says no sign events were found before the reader stopped, for a truncated empty result", () => {
    const lines = renderHistoryTable(
      buildHistoryReport(
        input({
          result: historyResult({ events: [], truncated: true, truncatedReason: "scan-limit" }),
        }),
      ),
    );

    assert.equal(
      lines.at(-1),
      "No sign events found before the reader stopped (it stopped before reading the whole range).",
    );
    assert.doesNotMatch(lines.join("\n"), /No sign events in /);
  });
});
