import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ERRORS } from "../../src/internal/error-catalog.ts";
import { sdkLoggingWarning, sdkLogs } from "../../src/internal/sdk-logging.ts";

const WARNING = `hardhat-kms: ${ERRORS.sdkLogging.template}`;

describe("sdkLogs", () => {
  it("is off when the variable is unset or empty", () => {
    for (const namespace of ["kms", "auth"] as const) {
      assert.equal(sdkLogs(undefined, namespace), false);
      assert.equal(sdkLogs("", namespace), false);
    }
  });

  it("matches the value as a list of namespaces, as google-logging-utils does", () => {
    const cases: [string, boolean, boolean][] = [
      // [value, kms, auth]
      ["*", true, true],
      ["all", true, true],
      ["ALL", false, false],
      ["all,kms", true, false],
      ["kms", true, false],
      ["KMS", true, false],
      ["auth", false, true],
      ["kms,auth", true, true],
      ["pubsub,a*", false, true],
      ["*s", true, false],
      ["km", false, false],
      [" kms", false, false],
      ["kms|auth", false, false],
      ["k.s", false, false],
      ["1", false, false],
      // google-logging-utils 2.1.0 turns every log on with `true`; earlier releases none.
      ["true", true, true],
      ["TRUE", false, false],
    ];
    for (const [value, kms, auth] of cases) {
      assert.deepEqual(
        [sdkLogs(value, "kms"), sdkLogs(value, "auth")],
        [kms, auth],
        JSON.stringify(value),
      );
    }
  });
});

describe("sdkLoggingWarning", () => {
  it("warns once, from the catalogue, while the logs are on", (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    const warnIfLogging = sdkLoggingWarning(() => "*");
    warnIfLogging(["kms", "auth"]);
    warnIfLogging(["auth"]);
    warnIfLogging(["kms", "auth"]);
    assert.deepEqual(
      warn.mock.calls.map((call) => call.arguments),
      [[WARNING]],
    );
  });

  it("does not warn when the variable is unset, or turns on none of the logs", (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    sdkLoggingWarning(() => undefined)(["kms", "auth"]);
    sdkLoggingWarning(() => "")(["kms", "auth"]);
    sdkLoggingWarning(() => "1")(["kms", "auth"]);
    sdkLoggingWarning(() => "kms")(["auth"]);
    assert.equal(warn.mock.callCount(), 0);
  });

  it("reads the variable each time until it warns", (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    let value: string | undefined;
    const warnIfLogging = sdkLoggingWarning(() => value);
    warnIfLogging(["kms"]);
    assert.equal(warn.mock.callCount(), 0);
    value = "kms";
    warnIfLogging(["auth"]);
    assert.equal(warn.mock.callCount(), 0);
    warnIfLogging(["kms"]);
    assert.equal(warn.mock.callCount(), 1);
  });
});
