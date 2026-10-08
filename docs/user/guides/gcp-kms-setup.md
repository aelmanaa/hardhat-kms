---
title: Set up a Google Cloud KMS key
description: Create a Google Cloud KMS secp256k1 HSM key for Ethereum signing, grant the IAM roles, configure @hardhat-kms/gcp and turn on audit logs.
---

# Set up a Google Cloud KMS key

This guide creates a secp256k1 signing key in Google Cloud KMS, allows a deployer to sign with it and nothing else, adds it to a Hardhat project and checks that it signs.

With `@hardhat-kms/gcp`, a connection lists the key's account, signs messages and typed data with it, and signs and sends transactions.

> [!NOTE]
> Audience: users who sign with a key in Google Cloud KMS.

## 1. Create a secp256k1 signing key

Ethereum uses the secp256k1 curve, which Cloud KMS calls `EC_SIGN_SECP256K1_SHA256`. Create a key ring, then an asymmetric signing key in it, at protection level HSM.

Choose the key's scheduled-destruction duration first: it is how long a version scheduled for destruction can still be restored, from 24 hours to 120 days, 30 days by default, and "after the duration for the key has been specified, it can't be changed" ([Create a key](https://docs.cloud.google.com/kms/docs/create-key)). The command below sets the longest, `120d`. Google recommends the 30-day default unless you have specific requirements ([Variable duration](https://docs.cloud.google.com/kms/docs/key-states#variable_duration_of_the_scheduled_for_destruction_state)), but losing this key loses its address and any funds at it for good, so the longest window to notice and undo a destruction is worth more. The cost is billing: a version scheduled for destruction is still an active, billed key version until it is destroyed ([Cloud KMS pricing](https://cloud.google.com/kms/pricing)). For a throwaway key, the 30-day default is fine. [Prevent and recover from losing a key](key-loss.md#guard-a-google-cloud-kms-key) covers guarding against destruction.

```sh
gcloud kms keyrings create deployer-ring --location europe-west1

gcloud kms keys create deployer \
  --keyring deployer-ring \
  --location europe-west1 \
  --purpose asymmetric-signing \
  --default-algorithm ec-sign-secp256k1-sha256 \
  --protection-level hsm \
  --destroy-scheduled-duration 120d
```

The key gets version `1`. The plugin always signs with the version you configure; it never picks a version for you. An asymmetric key has no primary version: Cloud KMS gives `primary` only to `ENCRYPT_DECRYPT` keys ([`CryptoKey.primary`](https://docs.cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys#CryptoKey.FIELDS.primary)).

Use `--protection-level hsm`. Creating this key at protection level `software` failed on 2026-10-01 with `ALGORITHM_NOT_SUPPORTED_FOR_PROTECTION_LEVEL`. An HSM key version costs more per month than a software one, and HSM operations are billed separately; see [Cloud KMS pricing](https://cloud.google.com/kms/pricing).

The plugin refuses key versions with any other algorithm.

Destroying the key version loses its address for good, along with any funds it holds, once the key's scheduled-destruction duration ends (120 days with the command above); [Prevent and recover from losing a key](key-loss.md) covers restoring a version, guarding against destruction and retiring a key.

## 2. Allow signing, and nothing else

The identity that runs Hardhat needs two permissions on this key:

- `cloudkms.cryptoKeyVersions.viewPublicKey`, to read the public key and the version's algorithm.
- `cloudkms.cryptoKeyVersions.useToSign`, to sign.

Creating the key does not give them, and Cloud KMS Admin (`roles/cloudkms.admin`) holds neither: it leaves out cryptographic operations. Grant the roles below even to the identity that created the key, unless it is a project Owner. Granting them needs `cloudkms.cryptoKeys.setIamPolicy` on the key, which Cloud KMS Admin and Owner hold.

The plugin signs as the identity of Application Default Credentials (ADC). The first of these that exists wins: the file named by `GOOGLE_APPLICATION_CREDENTIALS`, then the file that `gcloud auth application-default login` writes, then the service account of the machine ([How Application Default Credentials works](https://docs.cloud.google.com/docs/authentication/application-default-credentials)). So a `GOOGLE_APPLICATION_CREDENTIALS` left set in a shell beats your own login, and if it names a missing or unreadable file, the run fails rather than falling back to your login. Every Google Cloud key of a run signs as that one identity; [Credentials](../reference/credentials.md#google-cloud) lists the variables that change it, and [Cloud credentials for KMS signing](../explanation/cloud-access.md) shows which source a laptop, a CI job and a server use. The ADC identity is not always the account `gcloud auth login` signed the gcloud CLI in with, so grant the roles to the ADC identity. To see it, first check whether `gcloud config get auth/impersonate_service_account` prints an account. If it does, note the account and unset it with `gcloud config unset auth/impersonate_service_account`: that setting changes the token gcloud returns, but the plugin does not read gcloud settings. Then ask Google's token information endpoint whose ADC access token it is:

```sh
curl -s -d "access_token=$(gcloud auth application-default print-access-token \
  --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email)" \
  https://www.googleapis.com/oauth2/v1/tokeninfo
```

The `email` field of the response is the identity; the command asks for the `userinfo.email` scope because the response has `email` only when the token has that scope ([Token types](https://docs.cloud.google.com/docs/authentication/token-types)). Use the email with `user:`, or with `serviceAccount:` when it ends in `.gserviceaccount.com`. If the response still has no `email`, ADC holds a service account: the machine's or CI job's, the one named with `gcloud auth application-default login --impersonate-service-account`, or the one whose key file `GOOGLE_APPLICATION_CREDENTIALS` names. The `azp` field is then its unique ID, and `gcloud iam service-accounts describe <azp> --format='value(email)'` prints its email. If you unset `auth/impersonate_service_account` and your gcloud commands rely on it, set it again with `gcloud config set auth/impersonate_service_account <account>`.

Avoid service account key files. Google says "Service account keys create a security risk and are not recommended" ([How Application Default Credentials works](https://docs.cloud.google.com/docs/authentication/application-default-credentials)), and organizations created on or after 2024-05-03 block key creation by default ([Best practices for managing service account keys](https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys)). On a laptop, run `gcloud auth application-default login`, with `--impersonate-service-account <email>` to sign as a service account; your account needs the Service Account Token Creator role (`roles/iam.serviceAccountTokenCreator`) on that service account ([Set up ADC for a local development environment](https://docs.cloud.google.com/docs/authentication/set-up-adc-local-dev-environment)). In CI, use workload identity federation: `GOOGLE_APPLICATION_CREDENTIALS` can name its `external_account` configuration file, which holds no key. To sign, the federated identity (without service account impersonation) needs only the two roles on the key below; `kms history` also needs the role in [Allow reading the logs](#allow-reading-the-logs). Neither needs `resourcemanager.projects.get`. The plugin passes the project named in `keyVersionName` to Google's client libraries, so they never look it up through Cloud Resource Manager, and `GOOGLE_CLOUD_PROJECT` can stay unset. On Google Cloud, use the service account attached to the machine.

The predefined roles `roles/cloudkms.publicKeyViewer` and `roles/cloudkms.signer` each hold one of the two permissions. Grant both on the key, not on the project, so the identity can use no other key:

```sh
for role in roles/cloudkms.publicKeyViewer roles/cloudkms.signer; do
  gcloud kms keys add-iam-policy-binding deployer \
    --keyring deployer-ring \
    --location europe-west1 \
    --member user:you@example.com \
    --role "$role"
done
```

Use `serviceAccount:<email>` as the member for a service account. `roles/cloudkms.signerVerifier` also holds both permissions in one role, plus `useToVerify`, which the plugin does not use. The permissions in each role are listed in [Cloud KMS permissions and roles](https://cloud.google.com/kms/docs/reference/permissions-and-roles).

These two roles alone have not yet been checked against real Cloud KMS: the plugin's live tests ran with an identity that has wider permissions.

## 3. Install the plugin and configure the key

::: code-group

```sh [npm]
npm install --save-dev hardhat-kms @hardhat-kms/gcp
```

```sh [pnpm]
pnpm add --save-dev hardhat-kms @hardhat-kms/gcp
```

```sh [Yarn]
yarn add --dev hardhat-kms @hardhat-kms/gcp
```

:::

pnpm 11 and later need an `allowBuilds` entry, and Yarn 4 needs `nodeLinker: node-modules`: [Install hardhat-kms](install-before-release.md) gives the settings for each package manager.

`@hardhat-kms/gcp` brings the Google Cloud SDK (`@google-cloud/kms`, and `google-gax` 6.5.0 or later, except 6.11.0, to run it on) with it, so there is nothing else to install. npm prints `npm warn deprecated node-domexception@1.0.0` during the install. The warning comes from Google's libraries: `gaxios` and `google-gax` depend on `node-fetch` 3, which pulls in `node-domexception` through `fetch-blob`, and the latest `gaxios`, 8.1.0, still does. It is harmless and needs no action.

`@hardhat-kms/gcp` never runs its requests on `google-gax` 6.11.0, which npm marks as deprecated; if your install still shows a 6.11.0 copy, see [Keep google-gax off 6.11.0](#keep-google-gax-off-6110).

Add the plugin to `plugins`; it loads `hardhat-kms` itself:

```ts
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsGcp from "@hardhat-kms/gcp";

export default defineConfig({
  plugins: [hardhatKmsGcp],
  kms: {
    keys: {
      deployer: {
        provider: "gcp",
        keyVersionName:
          "projects/my-project/locations/europe-west1/keyRings/deployer-ring/cryptoKeys/deployer/cryptoKeyVersions/1",
        // Optional, recommended: run `npx hardhat kms accounts` and replace the next line with
        // the `address` line it prints for this key. The plugin then refuses to sign if the key
        // derives to another address.
        // address: "0x…",
      },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["deployer"],
    },
  },
});
```

Instead of `keyVersionName`, a key can list its parts: `projectId`, `location`, `keyRing`, `keyName` and `keyVersion`. The version is always required. The [configuration reference](../reference/configuration.md#key-forms-per-provider) lists every option.

To pin the key's address, run `npx hardhat kms accounts`. For a key without a pin it prints an `address` line; paste it into the key in place of the commented-out line ([`kms accounts`](../reference/tasks.md#kms-accounts)).

To use a key without a config entry, set `GCP_PROJECT_ID`, `GCP_LOCATION`, `GCP_KEY_RING`, `GCP_KEY_NAME` and `GCP_KEY_VERSION` and pass `--kms gcp`; see [Migrate from Foundry](migrate-from-foundry.md). Such a key is added to the network selected with `--network`, or to `default` without one.

`configVariable("SEPOLIA_RPC_URL")` reads the RPC URL when a network needs it: from an environment variable of that name (`export SEPOLIA_RPC_URL=https://…`), or from the Hardhat keystore (`npx hardhat keystore set SEPOLIA_RPC_URL`) when the config loads the keystore plugin. The config above does not: add `import hardhatKeystore from "@nomicfoundation/hardhat-keystore";` and put `hardhatKeystore` in `plugins`, or load a Hardhat toolbox, which includes it. The script in step 4 uses it.

## 4. Check that the key signs

Save this script as `scripts/check-kms.ts`. It lists the accounts on `sepolia`, then signs the message `hello` with the last one, which is the KMS account:

```ts
import { network } from "hardhat";

const { provider } = await network.create("sepolia");
const accounts = await provider.request({ method: "eth_accounts" });
const address: unknown = Array.isArray(accounts) ? accounts.at(-1) : undefined;
if (typeof address !== "string") {
  throw new Error("no accounts");
}
const signature = await provider.request({
  method: "personal_sign",
  params: ["0x68656c6c6f", address],
});
console.log(address, signature);
```

Run it with `npx hardhat run scripts/check-kms.ts`. The KMS address comes last in `eth_accounts`, after any accounts of the node. Each run calls `GetPublicKey` once, before the first signature, then `AsymmetricSign` once for the signature, or more if a request is retried ([How many sign requests one call can send](../explanation/security-model.md#how-many-sign-requests-one-call-can-send)). An `address` pin does not save that call: the plugin checks the public key against the pin before it releases a signature. A pin saves the call only where the plugin needs just the address, such as listing accounts with `eth_accounts`; the first signature and the `kms` tasks still read the public key ([`address`](../reference/configuration.md#configuration)).

## Keep google-gax off 6.11.0

npm marks `google-gax` 6.11.0 as deprecated "due to a known bug". `@hardhat-kms/gcp` depends on `google-gax` `^6.5.0 <6.11.0 || ^6.11.1`, and the plugin sends its Cloud KMS requests through that copy, so they never run on 6.11.0.

`@google-cloud/kms` asks for its own `google-gax` `^6.0.0`. npm, Yarn 4 and pnpm 11 and later skip a deprecated version when another one fits, so they give it the plugin's copy. Three cases can still add a 6.11.0 copy under `@google-cloud/kms`:

- Yarn 1 takes the `latest` tag when it fits a range, and `latest` was 6.11.0 on 2026-10-07.
- pnpm 10 does not skip deprecated versions: on its own, `@google-cloud/kms` resolves to 6.11.0 there, even with an empty cache.
- pnpm 11 and later can pick 6.11.0 when their cached registry data predates the deprecation.

The client library uses that second copy only for its debug logger and to decode error details. To remove a 6.11.0 copy that `npm ls google-gax --all`, `pnpm why google-gax` or `yarn why google-gax` shows, override the version in your project:

- pnpm 10 and later, in `pnpm-workspace.yaml` (pnpm 12 ignores the `pnpm` field of `package.json`), then `pnpm install`:

  ```yaml
  overrides:
    google-gax: "^6.5.0 <6.11.0 || ^6.11.1"
  ```

- npm, in `package.json`, then `npm dedupe` (`npm install` keeps the copy it already installed):

  ```json
  { "overrides": { "google-gax": "^6.5.0 <6.11.0 || ^6.11.1" } }
  ```

- Yarn, in `package.json`, then `yarn install`:

  ```json
  { "resolutions": { "google-gax": "^6.5.0 <6.11.0 || ^6.11.1" } }
  ```

## How the plugin uses the key

- It calls `GetPublicKey` once, checks that the response names the configured version and that its algorithm is `EC_SIGN_SECP256K1_SHA256`, and reads the PEM public key.
- It signs with `AsymmetricSign` on that version, sending the 32-byte digest as `digest.sha256`, and checks that the response names the same version.
- It checks every request and response with CRC32C. It sends `digestCrc32c` with the digest, requires `verifiedDigestCrc32c` to be true in the response, and checks `signatureCrc32c` against the signature and `pemCrc32c` against the public key. A missing checksum counts as a mismatch, and so does a digest that Cloud KMS refuses because its checksum does not match (INVALID_ARGUMENT).
- After a checksum mismatch, or when Cloud KMS is unavailable or cannot be reached, it repeats the call, at most three more times, then fails. Before repeating an unavailable call it waits 100 ms, then 200 ms, then 400 ms. The SDK's own retries are off, so this is the only retry loop, and it starts no new attempt once the call has timed out.
- When the credentials cannot be loaded, the call fails with a `gcp.connect.*` error and nothing is sent. The plugin does not keep that failure: the next call creates a new client, which looks the credentials up again, so a passing failure, such as a metadata server that did not answer in time, ends once the credentials can be found.
- It uses the SDK's REST transport, so no gRPC connection keeps `hardhat run` from exiting. Each request's deadline is the key's `timeoutMs`; google-gax enforces it over REST from 6.5.0, the version `@hardhat-kms/gcp` requires and hands to the client. The plugin does not pass its abort signal to the Cloud KMS client, so after a timeout or an abort the request already sent runs until that deadline, and nothing more is sent. Cloud KMS may still sign it, and log it when Data Access logs are on; the plugin drops that late answer and never returns it. The AWS and Azure plugins pass the signal to their SDKs, which cancel the request.
- It parses every DER signature, normalizes it to low-S and verifies it against the public key before using it; see the [security model](../explanation/security-model.md#every-signature-is-verified).
- It puts `hardhat-kms/<version>` at the start of the user agent of every request, so `protoPayload.requestMetadata.callerSuppliedUserAgent` in the Cloud KMS audit log starts with `hardhat-kms/1.0.0` (with your installed version) when Data Access logs are on for Cloud KMS. The client reports this tag and anyone can send the same string, so it marks the plugin's calls but proves nothing.

## Audit logs

[`kms history`](../reference/tasks.md#kms-history) lists a key's sign requests from Cloud Audit Logs: every `AsymmetricSign` call on any version of the key, from the plugin or from any other client. Cloud KMS logs these calls as Data Access logs, which are off by default. The plugin stores nothing itself, so with the logs off there is no history to read.

::: code-group

```sh [npm]
npx hardhat kms history deployer --since 7d
```

```sh [pnpm]
pnpm hardhat kms history deployer --since 7d
```

```sh [Yarn]
yarn hardhat kms history deployer --since 7d
```

:::

Without `--since`, the task reads the last 24 hours, and it lists at most 100 events, the newest; `--limit` takes up to 1000 ([`kms history`](../reference/tasks.md#kms-history)).

### Turn on Data Access logs for Cloud KMS

`AsymmetricSign` is a `DATA_READ` operation. In the console, open **IAM & Admin > Audit Logs**, select **Cloud Key Management Service (KMS) API**, and check **Data Read**. With `gcloud`, add an `auditConfigs` entry to the project's IAM policy. `set-iam-policy` replaces the project's whole IAM policy with the file, so change nothing else in it and keep the `etag` that `get-iam-policy` wrote: if someone changes the policy in between, the write then fails instead of undoing their change. The console route above changes only the audit setting.

```sh
gcloud projects get-iam-policy my-project --format=json > policy.json
```

Add this entry to the `auditConfigs` list in `policy.json` (create the list if it is missing), then write the policy back:

```json
{ "service": "cloudkms.googleapis.com", "auditLogConfigs": [{ "logType": "DATA_READ" }] }
```

```sh
gcloud projects set-iam-policy my-project policy.json
```

This needs `resourcemanager.projects.setIamPolicy` on the project, which Project IAM Admin (`roles/resourcemanager.projectIamAdmin`) and Owner hold. With the `auditConfigs` entry as the only change, it changes only what is logged. A setting on the folder or the organization, or one for `allServices`, also turns the logs on. See [Configure Data Access audit logs](https://cloud.google.com/logging/docs/audit/configure-data-access).

### Allow reading the logs

The identity that runs `kms history` needs `logging.privateLogEntries.list` on the key's project, which `roles/logging.privateLogViewer` holds:

```sh
gcloud projects add-iam-policy-binding my-project \
  --member user:you@example.com \
  --role roles/logging.privateLogViewer
```

The reader uses Application Default Credentials, as signing does, with the `logging.read` scope. It calls Cloud Logging's `entries.list` over REST through `google-auth-library`, which comes with the Cloud KMS SDK, so it installs nothing more. The Cloud Logging API must be enabled in the quota project of the credentials. Reading signs nothing and makes no Cloud KMS call.

This role reads the `_Required` and `_Default` buckets only. If a sink stores the sign entries in another log bucket, see [Entries in other log buckets](#entries-in-other-log-buckets).

### What the history shows

Each row comes from one log entry:

| Column or field            | Log entry field                                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `time`                     | `timestamp`                                                                                                                                                                |
| `principal`                | `protoPayload.authenticationInfo.principalEmail`, or `protoPayload.authenticationInfo.principalSubject` when there is no email                                             |
| `sourceIp`                 | `protoPayload.requestMetadata.callerIp`, which reads `private` or `gce-internal-ip` for calls from inside Google Cloud                                                     |
| `userAgent`                | `protoPayload.requestMetadata.callerSuppliedUserAgent`, reported by the client                                                                                             |
| `keyVersion`               | the last segment of `protoPayload.resourceName`                                                                                                                            |
| `digest`                   | `protoPayload.request.digest.sha256`, logged as 64 hex characters; the reader adds `0x`                                                                                    |
| `error`                    | for a refused request, the status name of `protoPayload.status.code`, and `protoPayload.status.message` with `--show-ids`. A served request is logged with an empty status |
| `keyResource`              | `protoPayload.resourceName`, the key version's full name, shown with `--show-ids`                                                                                          |
| `extra`                    | `insertId`, `principalSubject` when it is more than the type and the email, `receiveTimestamp` and the status code                                                         |
| `extra`, with `--show-ids` | the OAuth client id, `protoPayload.authenticationInfo.oauthInfo.oauthClientId`                                                                                             |

Cloud Audit Logs records no request id, so the history lists it as not logged. An entry's own id, `insertId`, is shown instead. No entry holds the message, the transaction or the signature, so the history cannot show what was signed; the digest identifies it if you have the transaction.

The history is the same whether `keyVersionName` names the project by its id or by its number. Signing needs the id: in a live test on 2026-10-02, Cloud KMS refused a sign request whose key name held the project number.

The project shows as `<hidden>` unless you pass `--show-ids`. Principals are shown as logged, so a service account's email keeps its project.

### What it cannot show

An empty history does not mean the key signed nothing, so the task says so instead of reporting no signatures:

- the Data Access logs may be off for Cloud KMS, or may have been turned on after the signature;
- a principal listed in `exemptedMembers` is never logged;
- the project's sinks may store an entry in no log bucket: an exclusion filter can keep it out of `_Default` while no other sink stores it, and a sink to BigQuery, Cloud Storage or Pub/Sub is not a log bucket, so the reader does not search it;
- the `_Default` bucket keeps the entries for 30 days, unless its retention was changed. For a range that starts earlier, the task adds a note. A copy in another log bucket follows that bucket's retention.

Google documents no delivery delay for audit logs. In the live test on 2026-10-02 each entry reached the log about one second after its call, and `kms history` found the test's signature on its second read, 10 seconds after signing. When the range ends less than 15 minutes ago, the task still notes that recent events may be missing.

Each run reads at most 10 pages of up to 1000 entries each, with up to 30 `entries.list` calls with retries. Cloud Logging allows 60 such calls a minute per project. A throttled call, a server error or a network error is retried twice, after 1 and 2 seconds, before the task fails. These pauses rarely outlast a per-minute quota. A call gets 30 seconds, and one that gets no answer in time is retried once. The reader also stops after 90 seconds. When it stops after 10 pages or 90 seconds, the task shows what it read and says that the range was not read in full.

### Entries in other log buckets

The reader calls `entries.list` with the resource name `projects/<project>`, the key's project as `keyVersionName` names it, by id or by number. For such a name, Google documents that "all logs ingested into that container will be returned regardless of which LogBuckets they are actually stored in" ([`entries.list`](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list)). A project read also returns the entries that a sink in another project routes into the project ([Logs Explorer overview](https://docs.cloud.google.com/logging/docs/view/logs-explorer-interface)). Google's FAQ on excluded logs gives the same reason for entries excluded from `_Default` that still show at project level ([Configure log buckets](https://docs.cloud.google.com/logging/docs/buckets#viewing-excluded-logs)).

So a sink that routes the sign entries to another log bucket, in the key's project or in another project, does not by itself keep them out of `kms history`. The identity still needs to read that bucket: `roles/logging.privateLogViewer` covers only the `_Required` and `_Default` buckets, and a user-defined bucket needs Logs View Accessor (`roles/logging.viewAccessor`) on its project or on one of its log views ([Access control with IAM](https://docs.cloud.google.com/logging/docs/access-control), [Configure log views](https://docs.cloud.google.com/logging/docs/logs-views)). Google does not say whether a read without it fails or leaves those entries out. Such a read can also reach buckets in other regions; when one is unavailable, Google suggests naming log views that leave it out, which the reader does not do.

`kms history` leaves out the entries that a sink in another project routes into the key's project, including those of a key in that project with the same location, key ring and name, because the filter names the key's project. Unit tests cover this; it has not been tested live with a sink from another project. For a project id it matches `resource.labels.project_id`, which Google documents as the project's id on the `cloudkms_cryptokeyversion` resource ([monitored resource list](https://docs.cloud.google.com/logging/docs/api/v2/resource-list)), and the reader checks the label of each entry too. No resource label holds the project number, so for a number the filter uses `source("projects/<number>")`, which matches the entries that come from that project ([query language](https://docs.cloud.google.com/logging/docs/view/logging-query-language#functions)). Google documents `source()` with a project id. In a live read on 2026-10-08 it also took the project number: the key's number returned the same entries as its id, another project's number returned none, and a number of no project was refused with `NOT_FOUND`.

None of this has been tested with a sink to a second bucket.

### Cost

Data Access logs are billed as log ingestion beyond Cloud Logging's free monthly allotment ([pricing](https://cloud.google.com/stackdriver/pricing)). Each `AsymmetricSign` and `GetPublicKey` call adds one entry of about 2 KB of JSON, and the setting above logs every Cloud KMS read in the project, not only this key's. Turn it off again by removing the `auditConfigs` entry.

## Errors

Each message starts with the provider, the operation and the key, for example `gcp, sign, key gcp:projects/…/cryptoKeyVersions/1: permission denied (PERMISSION_DENIED)`. The table lists the part after the colon.

| Error                                                                                                             | Cause and fix                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Google Cloud KMS keys need the @hardhat-kms/gcp plugin`                                                          | Run `npm install --save-dev @hardhat-kms/gcp` in the Hardhat project, and add `hardhatKmsGcp` to `plugins` in the config.                                                                      |
| `@hardhat-kms/gcp … needs hardhat-kms …, but hardhat-kms … is installed`                                          | The two packages are released together and must be the same version. Run the install command the error prints.                                                                                 |
| `the key version's algorithm is …, not EC_SIGN_SECP256K1_SHA256 (secp256k1)`                                      | The key is not a secp256k1 key. A key's algorithm cannot be changed, so create a new key as in step 1.                                                                                         |
| `the key derives to 0x…, but the configured address is 0x…`                                                       | The configuration names another key or version, or the pin is wrong. Nothing was signed. Find out why before you change the pin; see [When the pin fails](key-rotation.md#when-the-pin-fails). |
| `could not reach Google Cloud KMS (ECONNREFUSED), after 4 attempts`                                               | The request never reached Cloud KMS. The code says why: `ENOTFOUND` or `EAI_AGAIN` for DNS, `ECONNREFUSED` or `ECONNRESET` for the connection. Check the network, DNS and any `HTTPS_PROXY`.   |
| `Google Cloud KMS is unavailable (UNAVAILABLE), after 4 attempts`                                                 | Cloud KMS answered that it is unavailable. Try again later.                                                                                                                                    |
| `no Google Cloud credentials found`                                                                               | Run `gcloud auth application-default login`, or set `GOOGLE_APPLICATION_CREDENTIALS` to a credentials file.                                                                                    |
| `the credentials file GOOGLE_APPLICATION_CREDENTIALS names could not be read`                                     | The file is missing, is not a file, or holds no credentials. Fix the path, or unset the variable and run `gcloud auth application-default login`.                                              |
| `the token exchange refused the external credentials (invalid_grant)`                                             | Federation could not swap the external token for a Google Cloud token. Check the provider's audience and attribute condition, and that the token is current.                                   |
| `getting a Google Cloud access token failed: … answered HTTP 403`                                                 | Another endpoint on the way to a token refused the call, such as service account impersonation. See `gcp.connect.auth-endpoint` in the errors reference.                                       |
| `the Google Cloud credentials were refused (UNAUTHENTICATED)`                                                     | The credentials expired or were revoked. Run `gcloud auth application-default login` again.                                                                                                    |
| `permission denied (PERMISSION_DENIED)`                                                                           | The identity lacks `viewPublicKey` or `useToSign` on this key; grant the roles in step 2.                                                                                                      |
| `the key version was not found (NOT_FOUND)`                                                                       | The project, location, key ring, key or version does not exist. Check `keyVersionName` or its parts.                                                                                           |
| `the key version cannot be used (FAILED_PRECONDITION)`                                                            | The version is disabled, scheduled for destruction or destroyed. Enable it with `gcloud kms keys versions enable`, or restore it first with `gcloud kms keys versions restore`.                |
| `Google Cloud KMS is throttling requests (RESOURCE_EXHAUSTED)`                                                    | The project hit its Cloud KMS quota. Try again later, or ask for a higher quota.                                                                                                               |
| `no answer within … ms`                                                                                           | Cloud KMS did not answer in time. Check the network, or raise `timeoutMs`. `did not answer in time (DEADLINE_EXCEEDED)` means the same, reported by the SDK.                                   |
| `cannot read the audit log: the credentials lack logging.privateLogEntries.list (roles/logging.privateLogViewer)` | From `kms history`. Grant the role on the key's project, as in [Allow reading the logs](#allow-reading-the-logs).                                                                              |
| `the Cloud Logging API is disabled in the project the request is billed to (SERVICE_DISABLED)`                    | From `kms history`. Run `gcloud services enable logging.googleapis.com` in the credentials' quota project, or set another one with `gcloud auth application-default set-quota-project`.        |

Other Cloud KMS errors show as `the Google Cloud KMS call failed (<STATUS>)`, with the gRPC status name. The plugin never shows the server's message, since it names the project and the key. Run with `DEBUG=hardhat:kms:*` to see each call; see [Debug output](debug-output.md). The table lists the most common errors; the [errors reference](../reference/errors.md#hardhat-kmsgcp) lists every one, with its id, cause and fix, and the [core plugin's errors](../reference/errors.md#hardhat-kms) too.
