// Runs `kms history` on AWS keys through the real task, the real hook handler and the real AWS
// SDKs, against a local CloudTrail, STS and KMS endpoint that serve the recorded, masked events.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import hardhatKms from "hardhat-kms";
import type { KmsHistoryReport } from "hardhat-kms/types";
import { configVariable } from "hardhat/config";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatPlugin } from "hardhat/types/plugins";

import hardhatKmsAws from "../../src/index.ts";
import { kmsHandlers } from "../../src/internal/hook-handlers/kms.ts";
import { isolateAwsEnvironment } from "../helpers/aws-env.ts";
import { type AuditServer, startAuditServer } from "../helpers/cloudtrail-server.ts";
import { KEY_ARN } from "../helpers/fake-aws-kms.ts";
import { FIXTURE, RECORDED } from "../helpers/fake-history-api.ts";
import { type KmsServer, startKmsServer } from "../helpers/kms-server.ts";

const RANGE = { since: "2026-10-02T09:00:00Z", until: "2026-10-02T09:30:00Z" };
const KEY_ID = /1234abcd/i;
const OTHER_ACCOUNT = "444455556666";

/** The recorded events, moved to the local KMS key's Region, as `CloudTrailEvent` strings. */
const EVENTS = RECORDED.map((record) =>
  JSON.stringify(record).replaceAll("arn:aws:kms:us-east-1:", "arn:aws:kms:eu-west-1:"),
);
assert.ok(EVENTS.every((event) => event.includes(KEY_ARN)));

let kms: KmsServer;
let audit: AuditServer;
let restoreEnvironment: () => void;

async function runtime(plugins: HardhatPlugin[] = [hardhatKmsAws]) {
  return await createHardhatRuntimeEnvironment({
    plugins,
    kms: {
      keys: {
        byArn: { provider: "aws", keyId: KEY_ARN },
        byAlias: {
          provider: "aws",
          keyId: "alias/deployer",
          region: "eu-west-1",
          endpoint: kms.url,
        },
        google: {
          provider: "gcp",
          keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
        },
      },
    },
  });
}

interface Run {
  report: KmsHistoryReport | undefined;
  error: unknown;
  stdout: string;
  stderr: string;
}

function isReport(value: unknown): value is KmsHistoryReport {
  return typeof value === "object" && value !== null && Reflect.get(value, "version") === 1;
}

/** Runs `kms history` and returns its report or error and what it printed on each stream. */
async function history(
  key: string,
  options: { json?: boolean; showIds?: boolean; hre?: Awaited<ReturnType<typeof runtime>> } = {},
): Promise<Run> {
  const hre = options.hre ?? (await runtime());
  let stdout = "";
  let stderr = "";
  const write = mock.method(process.stdout, "write", (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  const writeError = mock.method(process.stderr, "write", (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  let result: unknown;
  let error: unknown;
  try {
    result = await hre.tasks.getTask(["kms", "history"]).run({
      key,
      ...RANGE,
      limit: 100,
      json: options.json ?? true,
      showIds: options.showIds ?? false,
    });
  } catch (thrown) {
    error = thrown;
  } finally {
    write.mock.restore();
    writeError.mock.restore();
  }
  return { report: isReport(result) ? result : undefined, error, stdout, stderr };
}

function lookups() {
  return audit.requests.filter((request) => request.operation === "LookupEvents");
}

describe("kms history on AWS keys", () => {
  before(async () => {
    kms = await startKmsServer(secp256k1.utils.randomSecretKey());
    audit = await startAuditServer({ pages: [], account: FIXTURE.account });
    restoreEnvironment = isolateAwsEnvironment();
    process.env.AWS_ENDPOINT_URL_CLOUDTRAIL = audit.url;
    process.env.AWS_ENDPOINT_URL_STS = audit.url;
  });

  beforeEach(() => {
    audit.requests.length = 0;
    kms.requests.length = 0;
    audit.behaviour.pages = [{ events: EVENTS }];
    audit.behaviour.account = FIXTURE.account;
    audit.behaviour.lookupError = undefined;
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "AWS_MAX_ATTEMPTS");
  });

  after(async () => {
    restoreEnvironment();
    await audit.close();
    await kms.close();
  });

  it("lists the key's sign events from CloudTrail, with key ids masked", async () => {
    const { report, error, stdout, stderr } = await history("byArn");

    assert.equal(error, undefined);
    assert.ok(report !== undefined);
    assert.equal(report.source, "cloudtrail-event-history");
    assert.deepEqual(report.notLogged, ["keyVersion", "digest"]);
    assert.equal(report.scope, "account <hidden>, eu-west-1");
    assert.equal(report.events.length, EVENTS.length);
    const plugin = report.events.find((event) => event.userAgent?.includes("hardhat-kms/"));
    assert.equal(plugin?.principal, "arn:aws:iam::111122223333:user/deployer");
    assert.equal(plugin.sourceIp, "203.0.113.7");
    assert.equal(plugin.keyResource, report.key.displayId);
    const failed = report.events.find((event) => event.outcome === "failed");
    assert.deepEqual(failed?.error, { code: "InvalidKeyUsageException", message: null });
    // The key's own display id names it; nothing else may.
    const printed = stdout.replaceAll(`aws:${KEY_ARN}`, "");
    assert.doesNotMatch(printed, KEY_ID);
    assert.doesNotMatch(printed, /AKIAIOSFODNN7EXAMPLE|AIDAEXAMPLEPRINCIPAL1/);
    assert.doesNotMatch(stderr, /logging-not-confirmed|No sign events/);
  });

  it("asks CloudTrail for Sign events, tagged with the plugin's user agent, and STS for the account", async () => {
    await history("byArn");

    const [lookup] = lookups();
    assert.ok(lookup !== undefined);
    const body: unknown = JSON.parse(lookup.body);
    assert.deepEqual(Reflect.get(Object(body), "LookupAttributes"), [
      { AttributeKey: "EventName", AttributeValue: "Sign" },
    ]);
    assert.equal(Reflect.get(Object(body), "MaxResults"), 50);
    assert.match(String(lookup.headers["user-agent"]), /hardhat-kms\//);
    assert.ok(audit.requests.some((request) => request.operation === "GetCallerIdentity"));
    // A key ARN needs no KMS call.
    assert.equal(kms.requests.length, 0);
  });

  it("resolves an alias with one GetPublicKey call, and never prints the key ARN", async () => {
    const { report, error, stdout } = await history("byAlias");

    assert.equal(error, undefined);
    assert.equal(report?.events.length, EVENTS.length);
    assert.deepEqual(
      kms.requests.map((request) => request.body.KeyId),
      ["alias/deployer"],
    );
    assert.ok(!audit.requests.some((request) => request.operation === "GetCallerIdentity"));
    assert.doesNotMatch(stdout, KEY_ID);
    assert.ok(report.events.every((event) => event.keyResource === "aws:alias/deployer"));
  });

  it("shows the ids with --show-ids", async () => {
    const { report } = await history("byAlias", { showIds: true });

    assert.equal(report?.scope, `account ${FIXTURE.account}, eu-west-1`);
    const event = report.events[0];
    assert.equal(event?.keyResource, KEY_ARN);
    assert.equal(event.extra.accessKeyId, FIXTURE.accessKeyId);
  });

  it("builds the CloudTrail, STS and KMS clients with the profile and region from variables", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hhkms-history-"));
    const configFile = path.join(directory, "config");
    writeFileSync(
      configFile,
      [
        "[profile hhkms-history]",
        "aws_access_key_id = AKIAHHKMSHISTORYPROF",
        "aws_secret_access_key = profile-secret",
        "",
      ].join("\n"),
    );
    process.env.AWS_CONFIG_FILE = configFile;
    process.env.HHKMS_AWS_PROFILE = "hhkms-history";
    process.env.HHKMS_AWS_REGION = "eu-west-1";
    try {
      const hre = await createHardhatRuntimeEnvironment({
        plugins: [hardhatKmsAws],
        kms: {
          keys: {
            alias: {
              provider: "aws",
              keyId: "alias/deployer",
              profile: configVariable("HHKMS_AWS_PROFILE"),
              region: configVariable("HHKMS_AWS_REGION"),
              endpoint: kms.url,
            },
            arn: { provider: "aws", keyId: KEY_ARN, profile: configVariable("HHKMS_AWS_PROFILE") },
          },
        },
      });

      for (const key of ["alias", "arn"]) {
        const { error } = await history(key, { hre });
        assert.equal(error, undefined);
      }

      const signed = [
        ...kms.requests.map((request) => request.headers.authorization),
        ...audit.requests.map((request) => request.headers.authorization),
      ];
      assert.deepEqual(
        [...kms.requests.map(() => "KMS"), ...audit.requests.map((request) => request.operation)],
        ["KMS", "LookupEvents", "GetCallerIdentity", "LookupEvents"],
      );
      for (const authorization of signed) {
        assert.match(String(authorization), /Credential=AKIAHHKMSHISTORYPROF\/\d{8}\/eu-west-1\//);
      }
    } finally {
      process.env.AWS_CONFIG_FILE = "/nonexistent/hardhat-kms-aws/config";
      Reflect.deleteProperty(process.env, "HHKMS_AWS_PROFILE");
      Reflect.deleteProperty(process.env, "HHKMS_AWS_REGION");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads every page, and prints the table", async () => {
    audit.behaviour.pages = [
      { events: EVENTS.slice(0, 2), nextToken: "page-1" },
      { events: EVENTS.slice(2) },
    ];
    const { stdout } = await history("byArn", { json: false });

    assert.deepEqual(
      lookups().map((request): unknown =>
        Reflect.get(Object(JSON.parse(request.body)), "NextToken"),
      ),
      [undefined, "page-1"],
    );
    assert.match(stdout, /from cloudtrail-event-history/);
    assert.equal(stdout.match(/ Sign /g)?.length, EVENTS.length);
    assert.match(stdout, /user agent \(client-reported\): aws-sdk-js\/.* hardhat-kms\//);
  });

  it("notes another account, and does not confirm an empty history", async () => {
    audit.behaviour.account = OTHER_ACCOUNT;
    audit.behaviour.pages = [{ events: [] }];
    const { report, stderr, stdout } = await history("byArn");

    const codes = report?.notes.map((note) => note.code) ?? [];
    assert.ok(codes.includes("other-account"));
    assert.ok(codes.includes("logging-not-confirmed"));
    assert.match(stderr, /another AWS account than the key/);
    assert.doesNotMatch(`${stdout}${stderr}`, new RegExp(OTHER_ACCOUNT));
  });

  it("fails naming cloudtrail:LookupEvents when CloudTrail refuses the read", async () => {
    audit.behaviour.lookupError = "AccessDeniedException";
    // The alias key: its display id holds no key id, and the ARN it resolved to must not print.
    const { error, stdout } = await history("byAlias");

    assert.ok(error instanceof Error);
    assert.match(error.message, /the credentials lack cloudtrail:LookupEvents/);
    assert.doesNotMatch(error.message, KEY_ID);
    assert.equal(stdout, "");
  });

  it("fails as throttled when CloudTrail keeps throttling", async () => {
    process.env.AWS_MAX_ATTEMPTS = "1";
    audit.behaviour.lookupError = "ThrottlingException";
    const { error } = await history("byArn");

    assert.ok(error instanceof Error);
    assert.match(error.message, /too frequent \(2 requests per second\)/);
  });

  it("passes keys of other providers on", async () => {
    const { error } = await history("google");

    assert.ok(error instanceof Error);
    assert.match(error.message, /@hardhat-kms\/gcp/);
    assert.equal(audit.requests.length, 0);
  });

  it("refuses AWS keys when hardhat-kms is another version", async () => {
    const hre = await runtime([hardhatKms, hardhatKmsAws]);
    hre.hooks.registerHandlers("kms", kmsHandlers("9.9.9"));
    const { error } = await history("byArn", { hre });

    assert.ok(error instanceof Error);
    assert.match(error.message, /@hardhat-kms\/aws 9\.9\.9 needs hardhat-kms 9\.9\.9/);
    assert.equal(audit.requests.length, 0);
  });
});
