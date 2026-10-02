import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configVariable } from "hardhat/config";
import { HardhatPluginError } from "hardhat/plugins";

import { isWorkspaceId, resolveAuditConfig } from "../../../src/internal/config/audit.ts";
import { resolveKmsConfig } from "../../../src/internal/config/resolve.ts";
import { assertError, validate } from "../../helpers/config-validation.ts";
import { fakeResolver } from "../../helpers/config-variables.ts";

const WORKSPACE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SECRET_NOT_A_GUID = "secret-workspace-name";

/** The audit section with its workspace id read from the variable WORKSPACE, set to `value`. */
function resolveWith(value: string) {
  return resolveAuditConfig(
    { azure: { workspaceId: configVariable("WORKSPACE") } },
    fakeResolver({ WORKSPACE: value }),
  );
}

describe("kms.audit", () => {
  it("accepts a workspace id as a GUID, in any case, or as a configuration variable", () => {
    assert.deepEqual(validate({ kms: { audit: {} } }), []);
    assert.deepEqual(validate({ kms: { audit: { azure: {} } } }), []);
    assert.deepEqual(validate({ kms: { audit: { azure: { workspaceId: WORKSPACE } } } }), []);
    assert.deepEqual(
      validate({ kms: { audit: { azure: { workspaceId: WORKSPACE.toUpperCase() } } } }),
      [],
    );
    assert.deepEqual(
      validate({ kms: { audit: { azure: { workspaceId: configVariable("WORKSPACE") } } } }),
      [],
    );
  });

  it("rejects a workspace id that is not a GUID, at its path", () => {
    for (const workspaceId of [
      "my-workspace",
      `${WORKSPACE}x`,
      `x${WORKSPACE}`,
      WORKSPACE.replaceAll("-", ""),
      "0f8fad5b-d9cb-469f-a165-70867728950g",
      `${WORKSPACE}\nAZKVAuditLogs | take 1`,
    ]) {
      assertError(
        { kms: { audit: { azure: { workspaceId } } } },
        "kms.audit.azure.workspaceId",
        "Expected a Log Analytics workspace id, a GUID",
        1,
      );
    }
  });

  it("rejects unknown fields and providers in kms.audit", () => {
    assertError(
      { kms: { audit: { azure: { workspace: WORKSPACE } } } },
      "kms.audit.azure",
      "Unrecognized key(s) in object: 'workspace'",
      1,
    );
    assertError(
      { kms: { audit: { aws: {} } } },
      "kms.audit",
      "Unrecognized key(s) in object: 'aws'",
      1,
    );
  });

  it("checks a GUID exactly", () => {
    assert.equal(isWorkspaceId(WORKSPACE), true);
    assert.equal(isWorkspaceId(` ${WORKSPACE}`), false);
    assert.equal(isWorkspaceId(""), false);
  });

  it("resolves to an empty section when nothing is set", () => {
    const resolver = fakeResolver({});
    assert.deepEqual(resolveAuditConfig(undefined, resolver), {});
    assert.deepEqual(resolveAuditConfig({ azure: {} }, resolver), {});
    assert.deepEqual(resolveKmsConfig({ kms: { audit: {} } }, resolver).audit, {});
  });

  it("resolves a literal workspace id, shown as written", async () => {
    const audit = resolveKmsConfig(
      { kms: { audit: { azure: { workspaceId: WORKSPACE } } } },
      fakeResolver({}),
    ).audit;

    assert.equal(await audit.azure?.workspaceId.get(), WORKSPACE);
    assert.equal(audit.azure?.workspaceId.display, WORKSPACE);
  });

  it("reads a variable's workspace id when used, shows it by name and checks it then", async () => {
    const good = resolveWith(` ${WORKSPACE} `);
    assert.equal(good.azure?.workspaceId.display, "<WORKSPACE>");
    assert.equal(await good.azure?.workspaceId.get(), WORKSPACE);

    const bad = resolveWith(SECRET_NOT_A_GUID).azure;
    assert.ok(bad !== undefined);
    await assert.rejects(bad.workspaceId.get(), (error: unknown) => {
      assert.ok(error instanceof HardhatPluginError);
      assert.equal(
        error.message,
        "invalid value for kms.audit.azure.workspaceId (<WORKSPACE>): expected a Log Analytics workspace id, a GUID",
      );
      assert.ok(!error.message.includes(SECRET_NOT_A_GUID));
      return true;
    });
  });
});
