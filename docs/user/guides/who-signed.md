---
title: Find who signed with a key
description: "hardhat kms history: who signed, from CloudTrail, Cloud Audit Logs or Azure Monitor"
---

# Find who signed with a key

This guide answers "who signed what with this key, and when" from the cloud's audit log, after an incident or for an audit: it turns the log on, reads the sign events, matches them to transactions and keeps the log long enough.

You need a key set up as in one of the setup guides and the cloud's CLI signed in: `aws`, `gcloud` or `az`.

> [!NOTE]
> Audience: operators with a KMS key in use who must answer "who signed what with this key, and when", after an incident or for an audit.
>
> Checked against hardhat-kms 0.8.0 on 2026-10-07: `kms history` read the logs of one live key per cloud, and both scripts below ran against Sepolia transactions of those keys, of types 0, 1, 2 and 4, and against a local node. The commands that change logging or retention in steps 1 and 5 come from each cloud's documentation and were not run for this page.

[`kms history`](../reference/tasks.md#kms-history) lists a key's sign requests from the cloud's own audit log: AWS CloudTrail, Google Cloud Audit Logs, or Azure Key Vault's audit events in a Log Analytics workspace. The list includes requests from any client, not only the plugin. The plugin keeps no record of its own signatures, so the log is the only history there is.

The log shows sign requests, not which request signed which transaction. Each event this guide finds is a candidate signing event, and the evidence comes in three strengths:

- **A nearby event.** On AWS and Azure the log holds no digest. An event shortly before a transaction's block may have signed it, but the log cannot say which of several such events did, or whether any of them did.
- **An event whose logged digest matches.** On Google Cloud the log holds the digest. An event whose digest equals the transaction's signing hash signed that transaction ([step 3](#confirm-the-digest-on-google-cloud)). This match rests on the plugin's code and has not yet been checked against a logged event.
- **Evidence of a specific attempt.** No provider logs an id the plugin sends, so the log cannot tie an event to one script run. That needs a record from outside the log, such as the hash your script got back from the send or Ignition's deployment journal ([step 4](#4-know-what-the-log-does-not-show)).

## 1. Turn on the audit log

Each cloud records a sign request only if its log is on when the request is made. Turning a log on later does not recover earlier requests.

| Provider         | What to turn on                                                                                 | Delay before an event shows                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS KMS          | Nothing. CloudTrail event history is on in every account.                                       | About 5 minutes on average, not guaranteed ([How CloudTrail works](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/how-cloudtrail-works.html))                                               |
| Google Cloud KMS | Data Access audit logs (`DATA_READ`) for Cloud KMS, off by default.                             | Not documented. Measured on 2026-10-02: about one second.                                                                                                                                               |
| Azure Key Vault  | A diagnostic setting that sends the vault's `AuditEvent` category to a Log Analytics workspace. | At most 10 minutes ([Azure Key Vault logging](https://learn.microsoft.com/en-us/azure/key-vault/general/logging)), plus Log Analytics ingestion. Measured on 2026-10-02: up to about 9 minutes in total |

**AWS KMS.** Read with credentials of the key's account, in the key's Region: event history is kept per account and per Region ([Working with CloudTrail event history](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events.html)). The identity that reads needs `cloudtrail:LookupEvents` ([the read permission](aws-kms-setup.md#the-read-permission)).

**Google Cloud KMS.** In the console, open **IAM & Admin > Audit Logs**, select **Cloud Key Management Service (KMS) API**, and check **Data Read** ([Configure Data Access audit logs](https://cloud.google.com/logging/docs/audit/configure-data-access)). The `gcloud` route rewrites the project's IAM policy; [Turn on Data Access logs for Cloud KMS](gcp-kms-setup.md#turn-on-data-access-logs-for-cloud-kms) shows how without overwriting the rest of the policy. Either route needs `resourcemanager.projects.setIamPolicy` on the project. Turning these logs on can add charges: they are billed as log ingestion, for every Cloud KMS read in the project ([step 5](#5-keep-the-log-long-enough)). The identity that reads needs `roles/logging.privateLogViewer` ([Allow reading the logs](gcp-kms-setup.md#allow-reading-the-logs)).

**Azure Key Vault.** Send the audit events to a workspace with the resource-specific destination, which writes the `AZKVAuditLogs` table that the task reads ([Create diagnostic settings](https://learn.microsoft.com/en-us/azure/azure-monitor/essentials/create-diagnostic-settings)). This needs `Microsoft.Insights/diagnosticSettings/write` on the vault, which Monitoring Contributor grants. The setting also sends the vault's other audit events, and the workspace bills their ingestion ([step 5](#5-keep-the-log-long-enough)):

```sh
az monitor diagnostic-settings create \
  --name hardhat-kms-audit \
  --resource "$(az keyvault show --name my-vault --query id -o tsv)" \
  --workspace "$(az monitor log-analytics workspace show --resource-group my-rg --workspace-name kms-audit --query id -o tsv)" \
  --export-to-resource-specific true \
  --logs '[{"category":"AuditEvent","enabled":true}]'
```

Then set the workspace's `customerId`, a GUID and not the resource id the command above reads, in `kms.audit.azure.workspaceId`, and give the identity that reads the Log Analytics Data Reader role on the workspace. [Send the audit log to a workspace](azure-key-vault-setup.md#send-the-audit-log-to-a-workspace) has the config and the role command.

## 2. Read the sign events

Name the key as in your config, here `deployer`, and give the time window around the incident:

```sh
npx hardhat kms history deployer --since 2026-10-05T09:00:00Z --until 2026-10-05T09:15:00Z
```

`--since` and `--until` take an ISO 8601 time with a time zone, a date, or a duration before now such as `30m`, `6h` or `7d`. Without `--since`, the task reads the 24 hours before `--until`, which defaults to now. It prints at most 100 events, newest first; `--limit` takes up to 1000. The task needs no `--network`, and it signs nothing.

The output on AWS, with the identifiers and part of the user agent replaced:

```text
Sign events of deployer (aws:alias/deployer), from cloudtrail-event-history
2026-10-05T09:00:00.000Z to 2026-10-05T09:15:00.000Z, newest first
Scope: account <hidden>, us-east-1
Not logged by this provider: key version, digest

TIME                      OPERATION  OUTCOME  PRINCIPAL                                SOURCE IP
2026-10-05T09:07:42.000Z  Sign       success  arn:aws:iam::111122223333:user/deployer  203.0.113.7
  user agent (client-reported): aws-sdk-js/3.1146.0 ua/2.1 … api/kms#3.1146.0 m/E,T,AD,AC hardhat-kms/0.8.0
  request id: 11111111-2222-3333-4444-555555555555
  eventId: 66666666-7777-8888-9999-000000000000
  userIdentityType: IAMUser
  userName: deployer
  crossAccount: false
  messageType: DIGEST
  signingAlgorithm: ECDSA_SHA_256
  tlsVersion: TLSv1.3
  readOnly: true
```

On Google Cloud, a row has a key version and the digest, and no request id. A key named by configuration variables shows as the variable's name:

```text
Sign events of deployer (gcp:<GCP_KEY_VERSION_NAME>), from cloud-logging
2026-09-28T10:00:00.000Z to 2026-10-05T10:00:00.000Z, newest first
Scope: project <hidden>, Data Access audit log, every version of the key
Not logged by this provider: request id

TIME                      OPERATION       OUTCOME  PRINCIPAL         SOURCE IP    KEY VERSION
2026-10-04T14:12:09.182Z  AsymmetricSign  success  you@example.com   203.0.113.7  1
  user agent (client-reported): hardhat-kms/0.8.0 google-api-nodejs-client/11.1.0,gzip(gfe)
  digest: 0x<64 hex characters>
  insertId: <insert id>
  receiveTimestamp: 2026-10-04T14:12:10.804797154Z
  statusCode: -
```

On Azure, a row has a key version and a request id, and no digest:

```text
Sign events of deployer (azure:<DEPLOYER_KEY_ID>), from log-analytics
2026-09-28T10:00:00.000Z to 2026-10-05T10:00:00.000Z, newest first
Scope: workspace <hidden>, AZKVAuditLogs in one Log Analytics workspace, every version of the key
Not logged by this provider: digest

TIME                      OPERATION  OUTCOME  PRINCIPAL        SOURCE IP    KEY VERSION
2026-10-05T08:41:42.573Z  KeySign    success  you@example.com  203.0.113.7  0123456789abcdef0123456789abcdef
  user agent (client-reported): hardhat-kms/0.8.0 azsdk-js-keyvault-keys/4.10.2 … core-rest-pipeline/1.25.0 Node/24.21.0
  request id: 11111111-2222-3333-4444-555555555555
  resultType: Success
  resultSignature: OK
  httpStatusCode: 200
  algorithm: ES256K
  durationMs: 212
  operationVersion: 2025-07-01
  identityType: user
  isRbacAuthorized: true
  tlsVersion: TLS1_3
```

What each part means:

| Part            | Meaning                                                                                                                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TIME`          | When the provider received the sign request, in UTC. AWS logs whole seconds.                                                                                                                                                                                                                                                     |
| `OPERATION`     | The provider's name for the sign call: `Sign`, `AsymmetricSign` or `KeySign`.                                                                                                                                                                                                                                                    |
| `OUTCOME`       | `success`, or `failed` with the provider's error code, such as `failed (AccessDeniedException)`.                                                                                                                                                                                                                                 |
| `PRINCIPAL`     | The identity that called: an IAM ARN, an email, or an Entra ID user or application. This answers "who".                                                                                                                                                                                                                          |
| `SOURCE IP`     | The caller's address as the provider saw it. Google Cloud shows `private` or `gce-internal-ip` for calls from inside Google Cloud.                                                                                                                                                                                               |
| `KEY VERSION`   | The key version that signed, on Google Cloud and Azure. AWS asymmetric keys have no versions.                                                                                                                                                                                                                                    |
| `user agent`    | The string the client sent. The plugin's requests contain `hardhat-kms/<version>`: at the end on AWS, at the start on Google Cloud and Azure.                                                                                                                                                                                    |
| `request id`    | The provider's id for the request: `requestID` on AWS, `CorrelationId` on Azure. Google Cloud logs none and shows `insertId` instead.                                                                                                                                                                                            |
| `digest`        | Google Cloud only: the 32-byte hash that was signed.                                                                                                                                                                                                                                                                             |
| The other lines | The provider's other fields, such as the identity type on AWS and the HTTP status on Azure. Each setup guide lists them: [AWS](aws-kms-setup.md#what-cloudtrail-logs-and-what-it-does-not), [Google Cloud](gcp-kms-setup.md#what-the-history-shows), [Azure](azure-key-vault-setup.md#what-key-vault-logs-and-what-it-does-not). |

The user agent is a claim, not proof: any client can send `hardhat-kms/0.8.0`. It still tells apart the clients you run yourself: a request from the AWS SDK for Rust shows as `aws-sdk-rust/…`, and a tool that sets its own user agent shows under that name, next to the plugin's rows.

The task also writes notes to standard error, such as `recent-events-may-be-missing` when the window ends in the last 15 minutes, and `logging-not-confirmed` when it finds no events and cannot confirm that it sees every sign request on the key. Zero rows never prove that the key signed nothing. [`kms history`](../reference/tasks.md#kms-history) lists every note.

Save the report as JSON for step 3. The task prints only the JSON on standard output, and its notes on standard error:

```sh
npx hardhat kms history deployer --since 7d --limit 1000 --json > history.json
```

The output names principals, IP addresses and user agents. Treat it as sensitive, and do not paste it into a public issue. Key ids, project ids and workspace ids show as `<hidden>` unless you pass `--show-ids`.

## 3. Match an event to a transaction

A sign event and a transaction share three things you can check: the sender, the chain, and the time. On Google Cloud they also share the digest.

- **Sender.** The transaction's `from` is the key's address, which `npx hardhat kms address deployer` prints. A transaction from another address was not signed by this key.
- **Chain.** The log does not record a chain. Look the transaction up on the network you expect; the script below prints the chain id it read.
- **Time.** The sign event comes before the block that mined the transaction, usually by seconds. Several events can fit one window, since one key also signs messages and other transactions, and a retried request is logged once per try.
- **Digest, Google Cloud only.** The event's digest is the hash of the unsigned transaction, so a match identifies the transaction exactly.

### Join the history with transaction hashes

Take the hashes from a block explorer's page for the key's address, or from Hardhat Ignition's journal for a deployment: each `TRANSACTION_SEND` line of `ignition/deployments/<deployment id>/journal.jsonl` holds `transaction.hash`. Save this as `scripts/who-signed.ts`. It needs nothing beyond Hardhat and the plugin:

```ts
import { readFileSync } from "node:fs";
import { network } from "hardhat";
import type { KmsHistoryReport } from "hardhat-kms/types";

const historyFile = process.env.HISTORY;
const hashes = (process.env.TX_HASHES ?? "").split(",").filter((hash) => hash !== "");
const sender = process.env.KMS_ADDRESS?.toLowerCase();
const windowSeconds = Number(process.env.WINDOW_SECONDS ?? "120");
// A sign request can be logged a few seconds after the block's timestamp.
const graceMs = 5_000;
if (historyFile === undefined || hashes.length === 0 || sender === undefined) {
  throw new Error("set HISTORY, TX_HASHES (comma-separated) and KMS_ADDRESS");
}
const report: KmsHistoryReport = JSON.parse(readFileSync(historyFile, "utf8"));

/** A string field of a JSON-RPC result, or undefined. */
function field(value: unknown, name: string): string | undefined {
  const found: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
  return typeof found === "string" ? found : undefined;
}

const { provider } = await network.getOrCreate();
const chainId = Number(await provider.request({ method: "eth_chainId" }));
console.log(
  `chain ${chainId}, history from ${report.source}, ${report.range.since} to ${report.range.until}`,
);

for (const hash of hashes) {
  const tx = await provider.request({ method: "eth_getTransactionByHash", params: [hash] });
  const from = field(tx, "from");
  const blockNumber = field(tx, "blockNumber");
  if (from === undefined || blockNumber === undefined) {
    console.log(`${hash}: not found or not mined on chain ${chainId}`);
    continue;
  }
  if (from.toLowerCase() !== sender) {
    console.log(`${hash}: sent by ${from}, not by KMS_ADDRESS`);
    continue;
  }
  const block = await provider.request({
    method: "eth_getBlockByNumber",
    params: [blockNumber, false],
  });
  const minedAt = Number(field(block, "timestamp")) * 1000;
  const opens = minedAt - windowSeconds * 1000;
  const events = report.events.filter((event) => {
    const at = Date.parse(event.time);
    return event.outcome === "success" && at >= opens && at <= minedAt + graceMs;
  });
  const nonce = Number(field(tx, "nonce"));
  console.log(
    `${hash}: nonce ${nonce}, mined ${new Date(minedAt).toISOString()}, ${events.length} sign event(s) in the ${windowSeconds} s before`,
  );
  for (const event of events) {
    const details = Object.entries({
      principal: event.principal,
      version: event.keyVersion,
      digest: event.digest,
      agent: event.userAgent,
    });
    const shown = details
      .filter(([, value]) => value !== null)
      .map(([name, value]) => `${name} ${value}`);
    console.log(`  ${event.time}  ${shown.join("  ")}`);
  }
  if (opens < Date.parse(report.range.since)) {
    console.log(
      "  the history starts after this window opens: read it again with an earlier --since",
    );
  }
}
```

Run it on the network the transactions went to:

```sh
HISTORY=history.json TX_HASHES=0x…,0x… KMS_ADDRESS=0x… npx hardhat run --network sepolia scripts/who-signed.ts
```

It prints, for each transaction, the candidate signing events: the successful sign events from two minutes before its block to five seconds after, newest first. On AWS and Azure these are nearby events only, and the closest one is not necessarily the one that signed. The key can also have signed a message or another transaction in the window, a retried request is logged once per try, and an event can show under two transactions, as `09:06:36` does here. Output for two transactions from an AWS key, with identifiers and times replaced:

```text
chain 11155111, history from cloudtrail-event-history, 2026-10-05T09:00:00.000Z to 2026-10-05T09:15:00.000Z
0xaaaa…: nonce 18, mined 2026-10-05T09:07:48.000Z, 4 sign event(s) in the 120 s before
  2026-10-05T09:07:42.000Z  principal arn:aws:iam::111122223333:user/deployer  agent aws-sdk-js/3.1146.0 … hardhat-kms/0.8.0
  2026-10-05T09:06:36.000Z  principal arn:aws:iam::111122223333:user/deployer  agent aws-sdk-js/3.1146.0 … hardhat-kms/0.8.0
  2026-10-05T09:06:07.000Z  principal arn:aws:iam::111122223333:user/deployer  agent aws-sdk-js/3.1146.0 … hardhat-kms/0.8.0
  2026-10-05T09:06:05.000Z  principal arn:aws:iam::111122223333:user/deployer  agent aws-sdk-js/3.1146.0 … hardhat-kms/0.8.0
0xbbbb…: nonce 17, mined 2026-10-05T09:06:48.000Z, 4 sign event(s) in the 120 s before
  2026-10-05T09:06:36.000Z  principal arn:aws:iam::111122223333:user/deployer  agent aws-sdk-js/3.1146.0 … hardhat-kms/0.8.0
  2026-10-05T09:06:07.000Z  principal arn:aws:iam::111122223333:user/deployer  agent aws-sdk-js/3.1146.0 … hardhat-kms/0.8.0
  2026-10-05T09:06:05.000Z  principal arn:aws:iam::111122223333:user/deployer  agent aws-sdk-js/3.1146.0 … hardhat-kms/0.8.0
  2026-10-05T09:05:21.000Z  principal arn:aws:iam::111122223333:user/deployer  agent aws-sdk-js/3.1146.0 … hardhat-kms/0.8.0
```

A transaction that waited in the pool was signed earlier than its block suggests: raise `WINDOW_SECONDS`. On AWS and Azure the script narrows the events down to a short list. When every candidate has the same principal, IP address and user agent, the log names one identity for the window, though not the event that signed. When they differ, the log cannot choose between them, because it holds no digest.

### Confirm the digest on Google Cloud

The digest in a Google Cloud event is the keccak-256 hash of the unsigned transaction. This script computes it for a mined transaction, and recovers the signer from the transaction's signature as a check. It needs the `@nomicfoundation/hardhat-viem` plugin installed and listed in your config's `plugins`. Save it as `scripts/signing-hash.ts`:

```ts
import "@nomicfoundation/hardhat-viem";
import { network } from "hardhat";
import { isHash, keccak256, recoverAddress, serializeTransaction } from "viem";

const hash = process.env.TX_HASH;
if (hash === undefined || !isHash(hash)) {
  throw new Error("set TX_HASH to the transaction hash");
}
const { viem } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
const { r, s, v, yParity, ...transaction } = await publicClient.getTransaction({ hash });
// Some nodes omit chainId on an EIP-155 legacy transaction: v is chain id * 2 + 35 or 36.
const unsigned =
  transaction.type === "legacy" && transaction.chainId === undefined && v >= 35n
    ? { ...transaction, chainId: Number((v - 35n) / 2n) }
    : transaction;
const digest = keccak256(serializeTransaction({ ...unsigned, data: unsigned.input }));
// A legacy transaction carries only v: 27 or 28, or chain id * 2 + 35 or 36 (EIP-155).
const parity = yParity ?? Number((v + 1n) % 2n);
const signer = await recoverAddress({ hash: digest, signature: { r, s, yParity: parity } });
console.log(`digest ${digest}, signed by ${signer}`);
```

```sh
TX_HASH=0x… npx hardhat run --network sepolia scripts/signing-hash.ts
```

When `signed by` is the key's address, look for the printed digest in the history: `grep` it in `history.json`, or in the output of `scripts/who-signed.ts`. The event with that digest signed this transaction. A type 4 transaction also makes one sign request per authorization the key signs, and their digests are not the transaction's. The match itself has not been checked against a logged event yet: it rests on the plugin sending the transaction's signing hash as the digest, which the recovered signer confirms.

## 4. Know what the log does not show

- **What was signed.** No provider logs the message, the typed data, the transaction or the signature. The transaction itself is on chain; step 3 links it to an event.
- **The digest, on AWS and Azure.** CloudTrail and Key Vault do not log it, so an event cannot be tied to one transaction for certain. Google Cloud logs it.
- **The plugin's own request.** The plugin sends no id that the providers log: AWS and Azure log their own request id, and Google Cloud none. An event cannot be traced to one script run.
- **Requests the log never received.** On Google Cloud, a principal exempted from Data Access logs is never logged, and an entry no sink stores in a log bucket is not read. An entry a sink stores in another log bucket is read only when the identity can read that bucket. On Azure, `kms history` reads one workspace; a second diagnostic setting can send events elsewhere. On AWS, a request recorded in another account or Region does not show. [What it cannot show](gcp-kms-setup.md#what-it-cannot-show) and [Calls from other accounts and Regions](aws-kms-setup.md#calls-from-other-accounts-and-regions) have the details.

The plugin writes no local journal to fill these gaps. What does exist outside the log: the transactions on chain, the hash each send returned to your script, and Ignition's deployment journal, which holds the hash of every transaction a deployment sent. [Audit logs](../explanation/security-model.md#audit-logs) in the security model compares the providers field by field.

## 5. Keep the log long enough

Decide how far back an investigation must reach, and set each log to keep at least that much. `kms history` reads only the log in the table below; a copy kept elsewhere, such as an S3 bucket, a BigQuery dataset or a second Azure workspace, needs the cloud's own tools.

| Provider         | Kept by default                                               | What `kms history` reads                                                                |
| ---------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| AWS KMS          | 90 days of event history, which cannot be changed             | Event history only                                                                      |
| Google Cloud KMS | 30 days in the `_Default` bucket                              | `_Default`, and other log buckets with the project's entries that the identity can read |
| Azure Key Vault  | 30 days in the workspace, unless the workspace says otherwise | The workspace's analytics retention, through its query API                              |

**AWS KMS.** Event history keeps 90 days, and reading it is free ([Working with CloudTrail event history](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events.html)). For a longer record, create a trail that delivers events to an S3 bucket ([Creating a trail with the AWS CLI](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-create-and-update-a-trail-by-using-the-aws-cli-create-trail.html)); a bucket not created by CloudTrail needs the [bucket policy for CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/create-s3-bucket-policy-for-cloudtrail.html). The commands need `cloudtrail:CreateTrail` and `cloudtrail:StartLogging`:

```sh
aws cloudtrail create-trail --name kms-audit --s3-bucket-name my-cloudtrail-bucket --is-multi-region-trail
aws cloudtrail start-logging --name kms-audit
```

The first copy of management events in a trail costs nothing from CloudTrail; S3 bills the storage ([AWS CloudTrail pricing](https://aws.amazon.com/cloudtrail/pricing/)). `kms history` does not read the trail: query the bucket with Athena, or copy the trail's events into a CloudTrail Lake event data store, for anything older than 90 days.

**Google Cloud KMS.** The `_Default` bucket keeps 30 days. Raise it, from 1 to 3650 days, with the command below, which needs `logging.buckets.update` (Logs Configuration Writer, `roles/logging.configWriter`) ([Configure log buckets](https://docs.cloud.google.com/logging/docs/buckets)). The new retention applies to every log in the bucket, not only Cloud KMS entries, so the retention charge grows with all of the project's logs:

```sh
gcloud logging buckets update _Default --location=global --retention-days=365
```

`kms history` keeps reading the bucket over the longer range. Data Access logs are billed as log ingestion beyond the free monthly allotment ([Cloud Logging pricing](https://cloud.google.com/products/observability/pricing)), and retention past the default 30 days is billed too ([Configure log buckets](https://docs.cloud.google.com/logging/docs/buckets)). Each sign request adds an entry of about 2 KB, and the setting from step 1 logs every Cloud KMS read in the project.

**Azure Key Vault.** A workspace keeps rows for 30 days by default. Raise the analytics retention of the `AZKVAuditLogs` table, up to 730 days, with the command below. It needs `Microsoft.OperationalInsights/workspaces/tables/write`, which Log Analytics Contributor grants ([Manage data retention in a Log Analytics workspace](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure)):

```sh
az monitor log-analytics workspace table update \
  --resource-group my-rg \
  --workspace-name kms-audit \
  --name AZKVAuditLogs \
  --retention-time 365
```

`kms history` queries the workspace, which reads rows in analytics retention only. Rows kept by `--total-retention-time` beyond that are in long-term retention, and only a search job in Azure Monitor reads them. Ingestion is billed beyond the free allowance of the pricing tier ([Azure Monitor pricing](https://azure.microsoft.com/pricing/details/monitor/)). Its price includes 31 days of analytics retention, and longer retention is billed by volume and days kept ([Manage data retention](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure#pricing-model)). A `KeySign` row is about 1.9 KB, and the diagnostic setting also sends the vault's other events.

## Related

- [`kms history`](../reference/tasks.md#kms-history): every option, note and JSON field.
- [Audit logs](../explanation/security-model.md#audit-logs): what each provider records, and why an empty history proves little.
- The audit sections of the setup guides for [AWS KMS](aws-kms-setup.md#audit-logs), [Google Cloud KMS](gcp-kms-setup.md#audit-logs) and [Azure Key Vault](azure-key-vault-setup.md#audit-logs).
