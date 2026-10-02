import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hiddenSet, masker } from "../../../src/internal/history/mask.ts";
import { auditLogAccessDenied, auditLogThrottled } from "../../../src/provider-utils.ts";

const KEY_ID = "1234abcd-12ab-34cd-56ef-1234567890ab";
const KEY_ARN = `arn:aws:kms:eu-west-1:111122223333:key/${KEY_ID}`;
const ALIAS_ARN = "arn:aws:kms:eu-west-1:111122223333:alias/deployer-key";
const AZURE_URL =
  "https://secret-vault.vault.azure.net/keys/deployer/0123456789abcdef0123456789abcdef";
const GCP_NAME =
  "projects/secret-project/locations/europe-west1/keyRings/ring/cryptoKeys/deployer/cryptoKeyVersions/3";

const maskWith = (values: string[]) => masker(hiddenSet(values), "<KEY>");

describe("hiddenSet and masker", () => {
  it("adds the AWS key id and the key or alias segment of an ARN", () => {
    assert.deepEqual(hiddenSet([KEY_ARN]), [KEY_ARN, `key/${KEY_ID}`, KEY_ID]);
    assert.deepEqual(hiddenSet([ALIAS_ARN]), [ALIAS_ARN, "alias/deployer-key"]);
    const mask = maskWith([KEY_ARN]);
    assert.equal(mask(`called ${KEY_ID} directly`), "called <KEY> directly");
  });

  it("adds the Azure vault host and the versionless key URL", () => {
    const mask = maskWith([AZURE_URL]);
    assert.equal(
      mask("https://secret-vault.vault.azure.net/keys/deployer was used"),
      "<KEY> was used",
    );
    assert.equal(mask("host secret-vault.vault.azure.net"), "host <KEY>");
  });

  it("adds the Google Cloud key name without its version", () => {
    const mask = maskWith([GCP_NAME]);
    assert.equal(
      mask("projects/secret-project/locations/europe-west1/keyRings/ring/cryptoKeys/deployer"),
      "<KEY>",
    );
    assert.equal(mask(`//cloudkms.googleapis.com/${GCP_NAME}`), "//cloudkms.googleapis.com/<KEY>");
  });

  it("matches in any case, each value once", () => {
    const mask = maskWith([KEY_ARN, KEY_ARN.toUpperCase()]);
    assert.equal(mask(`x ${KEY_ARN.toUpperCase()} y`), "x <KEY> y");
    assert.equal(mask(`x ${KEY_ID.toUpperCase()} y`), "x <KEY> y");
    assert.equal(hiddenSet([KEY_ARN, KEY_ARN.toUpperCase()]).length, 3);
  });

  it("treats hidden values as text, not patterns, and skips short and empty ones", () => {
    assert.equal(maskWith(["a.b(c)*d+"])("a.b(c)*d+ and aXb(c)d"), "<KEY> and aXb(c)d");
    assert.deepEqual(hiddenSet(["short", null, undefined, ""]), []);
    assert.equal(masker([], "<KEY>")("unchanged"), "unchanged");
  });
});

describe("the reader error helpers", () => {
  it("take permissions and limits as documented", () => {
    assert.match(
      auditLogAccessDenied("Microsoft.OperationalInsights/workspaces/query/read").message,
      /lack Microsoft\.OperationalInsights\/workspaces\/query\/read\./,
    );
    assert.match(
      auditLogAccessDenied("roles/logging.privateLogViewer").message,
      /privateLogViewer/,
    );
    assert.match(auditLogThrottled("60 calls per minute").message, /\(60 calls per minute\)/);
  });

  it("refuse values that could carry an id", () => {
    for (const value of [
      KEY_ARN,
      "kms:Sign on 111122223333",
      "workspace 0f8fad5b-d9cb",
      "https://x.vault.azure.net",
      "",
      "x\ny",
      "a".repeat(129),
    ]) {
      assert.throws(
        () => auditLogAccessDenied(value),
        /take a short permission or limit with no ids/,
      );
      assert.throws(() => auditLogThrottled(value), /with no ids/);
    }
  });
});
