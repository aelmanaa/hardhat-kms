import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { errorMasker, hiddenSet, masker } from "../../../src/internal/history/mask.ts";
import { auditLogAccessDenied, auditLogThrottled } from "../../../src/provider-utils.ts";

const KEY_ID = "1234abcd-12ab-34cd-56ef-1234567890ab";
const KEY_ARN = `arn:aws:kms:eu-west-1:111122223333:key/${KEY_ID}`;
const ALIAS_ARN = "arn:aws:kms:eu-west-1:111122223333:alias/deployer-key";
const AZURE_URL =
  "https://secret-vault.vault.azure.net/keys/deployer/0123456789abcdef0123456789abcdef";
const GCP_NAME =
  "projects/secret-project/locations/europe-west1/keyRings/ring/cryptoKeys/deployer/cryptoKeyVersions/3";

const maskKeys = (keys: string[], others: string[] = []) =>
  masker(hiddenSet({ keys, others }), "<KEY>");
const plainValues = (keys: string[]) =>
  hiddenSet({ keys, others: [] })
    .map((entry) => entry.value)
    .filter((value) => !value.includes("%") && !value.includes("\\"));

describe("hiddenSet and masker", () => {
  it("adds the AWS key id and the key or alias segment of an ARN", () => {
    assert.deepEqual(plainValues([KEY_ARN]), [KEY_ARN, `key/${KEY_ID}`, KEY_ID]);
    assert.deepEqual(plainValues([ALIAS_ARN]), [ALIAS_ARN, "alias/deployer-key"]);
    const mask = maskKeys([KEY_ARN]);
    assert.equal(mask(`called ${KEY_ID} directly`), "called <KEY> directly");
  });

  it("masks the versionless Azure key URL as the key, and the vault host, name and resource id as <hidden>", () => {
    const mask = maskKeys([AZURE_URL]);
    assert.equal(
      mask("https://secret-vault.vault.azure.net/keys/deployer was used"),
      "<KEY> was used",
    );
    assert.equal(mask("host SECRET-VAULT.vault.azure.net"), "host <hidden>");
    assert.equal(mask("vault secret-vault"), "vault <hidden>");
    assert.equal(
      mask("/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/secret-vault"),
      "/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/<hidden>",
    );
  });

  it("masks a vault name too short to mask alone inside a resource id", () => {
    const mask = maskKeys(["https://kv1.vault.azure.net/keys/deployer"]);
    assert.equal(
      mask("/providers/Microsoft.KeyVault/vaults/kv1"),
      "/providers/Microsoft.KeyVault/vaults/<hidden>",
    );
    assert.equal(mask("managedHSMs/kv1"), "managedHSMs/<hidden>");
    // Too short to mask on its own without garbling text.
    assert.equal(mask("kv1"), "kv1");
  });

  it("masks the Google Cloud key name as the key, and the key ring path as <hidden>", () => {
    const mask = maskKeys([GCP_NAME]);
    assert.equal(
      mask("projects/secret-project/locations/europe-west1/keyRings/ring/cryptoKeys/deployer"),
      "<KEY>",
    );
    assert.equal(mask(`//cloudkms.googleapis.com/${GCP_NAME}`), "//cloudkms.googleapis.com/<KEY>");
    assert.equal(mask("projects/secret-project/locations/europe-west1/keyRings/ring"), "<hidden>");
  });

  it("masks the URL-encoded and \\/-escaped forms of every hidden value", () => {
    const mask = maskKeys([KEY_ARN, GCP_NAME], ["0f8fad5b-d9cb-469f-a165-70867728950e/x"]);
    assert.equal(mask(`?key=${encodeURIComponent(KEY_ARN)}`), "?key=<KEY>");
    assert.equal(mask(`?key=${encodeURIComponent(KEY_ARN).toLowerCase()}`), "?key=<KEY>");
    assert.equal(mask(JSON.stringify(KEY_ARN).replaceAll("/", "\\/")), '"<KEY>"');
    assert.equal(mask(encodeURIComponent(GCP_NAME)), "<KEY>");
    assert.equal(mask("0f8fad5b-d9cb-469f-a165-70867728950e\\/x"), "<hidden>");
    assert.equal(mask("0f8fad5b-d9cb-469f-a165-70867728950e%2Fx"), "<hidden>");
  });

  it("masks other values, and everything derived from them, as <hidden>", () => {
    const mask = maskKeys([], [KEY_ARN, "secret-project"]);
    assert.equal(mask(`${KEY_ARN} ${KEY_ID}`), "<hidden> <hidden>");
    assert.equal(
      mask("sa@secret-project.iam.gserviceaccount.com"),
      "sa@<hidden>.iam.gserviceaccount.com",
    );
  });

  it("masks a value given both as a key and as another value as the key", () => {
    assert.equal(maskKeys([KEY_ARN], [KEY_ARN.toUpperCase()])(KEY_ARN), "<KEY>");
  });

  it("matches in any case, each value once", () => {
    const mask = maskKeys([KEY_ARN, KEY_ARN.toUpperCase()]);
    assert.equal(mask(`x ${KEY_ARN.toUpperCase()} y`), "x <KEY> y");
    assert.equal(mask(`x ${KEY_ID.toUpperCase()} y`), "x <KEY> y");
    assert.equal(
      hiddenSet({ keys: [KEY_ARN, KEY_ARN.toUpperCase()], others: [] }).length,
      hiddenSet({ keys: [KEY_ARN], others: [] }).length,
    );
  });

  it("never rewrites the display id, so a literal key's display id stays as it is", () => {
    const displayId = `gcp:${GCP_NAME}`;
    const mask = masker(hiddenSet({ keys: [GCP_NAME], others: [] }), displayId);
    assert.equal(
      mask(`key ${displayId}: cannot read ${GCP_NAME}`),
      `key ${displayId}: cannot read ${displayId}`,
    );
  });

  it("treats hidden values as text, not patterns, and skips short and empty ones", () => {
    assert.equal(maskKeys(["a.b(c)*d+"])("a.b(c)*d+ and aXb(c)d"), "<KEY> and aXb(c)d");
    assert.deepEqual(hiddenSet({ keys: ["short", null, undefined, ""], others: ["x"] }), []);
    assert.equal(masker([], "<KEY>")("unchanged"), "unchanged");
  });
});

describe("short ids", () => {
  const PROJECT = "my-prj";

  it("masks an id of 6 or 7 characters as a whole word, in any case", () => {
    const mask = maskKeys([], [PROJECT, "prj-123"]);
    assert.equal(mask("project my-prj"), "project <hidden>");
    assert.equal(mask("MY-PRJ, then prj-123."), "<hidden>, then <hidden>.");
    assert.equal(mask("sa@my-prj.iam.gserviceaccount.com"), "sa@<hidden>.iam.gserviceaccount.com");
    assert.equal(mask("projects/my-prj/locations/global"), "projects/<hidden>/locations/global");
    assert.deepEqual(
      hiddenSet({ keys: [], others: [PROJECT, "abcde"] }).map((entry) => entry.value),
      [PROJECT],
    );
  });

  it("never masks a short id inside a longer run of letters, digits, _ or -", () => {
    const mask = maskKeys([], [PROJECT, "signer"]);
    assert.equal(
      mask("my-prj2 xmy-prj my-prj-sa my_prj_x amy-prj_"),
      "my-prj2 xmy-prj my-prj-sa my_prj_x amy-prj_",
    );
    assert.equal(
      mask("signers co-signer signer_1 cosigner"),
      "signers co-signer signer_1 cosigner",
    );
    // A project named like a common word is masked where the word stands alone.
    assert.equal(mask("the signer signed"), "the <hidden> signed");
  });

  it("masks the URL-encoded and \\/-escaped forms of a short id", () => {
    const mask = maskKeys([], ["a/b.cd", PROJECT]);
    assert.equal(mask("?p=a%2Fb.cd&x=1"), "?p=<hidden>&x=1");
    assert.equal(mask('"a\\/b.cd"'), '"<hidden>"');
    assert.equal(mask("a/b.cd"), "<hidden>");
    // A %XX escape before a short id is a word boundary.
    assert.equal(mask("projects%2Fmy-prj%2FkeyRings"), "projects%2F<hidden>%2FkeyRings");
    assert.equal(mask("projects%2fMY-PRJ"), "projects%2f<hidden>");
    assert.equal(mask("projects%252Fmy-prj"), "projects%252F<hidden>");
    assert.equal(mask("projects%252525252Fmy-prj"), "projects%252525252F<hidden>");
    // Encoded more than five times is not a boundary, which keeps the lookbehind a fixed size.
    assert.equal(mask("projects%25252525252Fmy-prj"), "projects%25252525252Fmy-prj");
  });

  it("masks a short id after a literal backslash escape, never after a bare letter", () => {
    const mask = maskKeys([], [PROJECT]);
    assert.equal(mask("projects\\u002Fmy-prj"), "projects\\u002F<hidden>");
    assert.equal(mask("projects\\x2Fmy-prj"), "projects\\x2F<hidden>");
    assert.equal(mask("line\\nmy-prj"), "line\\n<hidden>");
    assert.equal(mask("tab\\tmy-prj"), "tab\\t<hidden>");
    assert.equal(
      mask("cr\\rmy-prj ff\\fmy-prj bs\\bmy-prj"),
      "cr\\r<hidden> ff\\f<hidden> bs\\b<hidden>",
    );
    assert.equal(
      mask("xmy-prj Fmy-prj nmy-prj u002Fmy-prj"),
      "xmy-prj Fmy-prj nmy-prj u002Fmy-prj",
    );
  });

  it("still masks a long id inside a longer word", () => {
    assert.equal(maskKeys([], ["secret-project"])("xsecret-projecty"), "x<hidden>y");
  });
});

describe("errorMasker", () => {
  const mask = errorMasker(
    hiddenSet({ keys: ["alias/deployer-key"], others: [] }),
    "aws:alias/deployer-key",
  );

  it("masks ids the plugin was never given, such as the key ARN an alias resolved to", () => {
    assert.equal(
      mask(`aws, history, key aws:alias/deployer-key: cannot read ${KEY_ARN}`),
      "aws, history, key aws:alias/deployer-key: cannot read <hidden>",
    );
  });

  it("masks Azure vault URLs and hosts, Google Cloud resource names, GUIDs and AWS account ids", () => {
    assert.equal(
      mask(
        `${AZURE_URL}, other.managedhsm.azure.net, ${GCP_NAME}, 0F8FAD5B-D9CB-469F-A165-70867728950E, account 111122223333`,
      ),
      "<hidden>, <hidden>, <hidden>, <hidden>, account <hidden>",
    );
  });

  it("keeps text without ids, and the display id", () => {
    const text =
      "aws, history, key aws:alias/deployer-key: cannot read the audit log: the credentials lack cloudtrail:LookupEvents";
    assert.equal(mask(text), text);
  });
});

describe("the reader error helpers", () => {
  it("take the real permissions, roles and limits of each provider", () => {
    // AWS
    assert.match(
      auditLogAccessDenied("cloudtrail:LookupEvents").message,
      /lack cloudtrail:LookupEvents\./,
    );
    assert.match(auditLogThrottled("2 requests per second").message, /\(2 requests per second\)/);
    // Google Cloud
    assert.match(
      auditLogAccessDenied(["logging.privateLogEntries.list", "roles/logging.privateLogViewer"])
        .message,
      /lack logging\.privateLogEntries\.list and roles\/logging\.privateLogViewer\./,
    );
    assert.match(auditLogThrottled("60 per minute").message, /\(60 per minute\)/);
    // Azure
    assert.match(
      auditLogAccessDenied([
        "Microsoft.OperationalInsights/workspaces/query/read",
        "Microsoft.OperationalInsights/workspaces/query/AZKVAuditLogs/read",
      ]).message,
      /lack Microsoft\.OperationalInsights\/workspaces\/query\/read and Microsoft\.OperationalInsights\/workspaces\/query\/AZKVAuditLogs\/read\./,
    );
    assert.match(
      auditLogAccessDenied("Log Analytics Data Reader").message,
      /lack Log Analytics Data Reader\./,
    );
    assert.match(
      auditLogAccessDenied(
        "Microsoft.OperationalInsights/workspaces/query/AZKVAuditLogs/read (in Log Analytics Data Reader); or a custom role",
      ).message,
      /\(in Log Analytics Data Reader\); or a custom role\./,
    );
    assert.match(auditLogThrottled("200 per 30 seconds").message, /\(200 per 30 seconds\)/);
    assert.match(auditLogAccessDenied("z".repeat(200)).message, /lack z{200}\./);
  });

  it("keep the provider and the kind of the refusal when a value could carry an id, without printing it", () => {
    const details = { provider: "aws", operation: "history", key: "aws:alias/x" };
    for (const value of [
      KEY_ARN,
      "kms:Sign on 111122223333",
      "workspace 0f8fad5b-d9cb",
      "https://x.vault.azure.net",
      "x.vault.azure.net read",
      "arn:aws:iam::role",
      "alias/deployer",
      "projects/p/roles/r",
      "",
      "x\ny",
      "z".repeat(201),
    ]) {
      const denied = auditLogAccessDenied(value, details);
      assert.equal(
        denied.message,
        "aws, history, key aws:alias/x: cannot read the audit log: the credentials lack a permission. The history reader named it in a form that could carry an id, so it is not shown; this is a bug in the reader",
      );
      assert.match(
        auditLogAccessDenied(["cloudtrail:LookupEvents", value]).message,
        /lack a permission\./,
      );
      const throttled = auditLogThrottled(value, details);
      assert.match(
        throttled.message,
        /^aws, history, key aws:alias\/x: the audit log kept refusing requests as too frequent\. The history reader named the limit/,
      );
      if (value !== "") {
        assert.ok(!denied.message.includes(value) && !throttled.message.includes(value));
      }
    }
    assert.match(auditLogAccessDenied([]).message, /lack a permission\./);
  });
});
