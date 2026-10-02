# Security model

Audience: users who hold funds or contract roles at a KMS key's address and want to know what the plugin guarantees, what it leaves to them, and what can still go wrong. Assumes you have read [How hardhat-kms works](how-it-works.md) or know the path of a request.

Status: Implemented. Every guarantee below is on `main`. The contributor version, with the code that enforces each control, is the [threat model summary](../../contributor/signing-pipeline.md#threat-model-summary).

The plugin never holds a private key: the KMS signs and the plugin checks. Its job is to make sure that what the KMS signs is what you asked for, for the chain you meant, with the key you configured, and that nothing leaks on the way. Who may use the key at all is for your cloud provider's access control to decide, not the plugin.

## What the plugin protects against

Each row is one row of the [threat model summary](../../contributor/signing-pipeline.md#threat-model-summary), in the order it lists them.

| Risk                                                                                      | What the plugin does                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A script or dependency gets your key to sign a hash it built, such as another transaction | No RPC method signs a 32-byte digest the caller supplies. The plugin signs only transactions it filled itself, EIP-191 messages and EIP-712 typed data. See [No bare digests over RPC](#no-bare-digests-over-rpc).                                                                                                                                                                                                                                                         |
| A signature made for one chain is used on another                                         | Each connection checks the node's chain id. Every transaction carries an explicit `chainId` that must match it, and typed data that names a chain must match it too. See [Typed data checks its chain](#typed-data-checks-its-chain).                                                                                                                                                                                                                                      |
| The key changes underneath you: a rotation, or an alias that now points at another key    | Core, every provider: your `address` pin is checked before the first signature, in every run. Built-in providers only: AWS keys sign with the key ARN, not the alias, and Google Cloud and Azure keys sign with a pinned key version. That pinning lasts only while a signer is open: signers close 5 s after the last connection closes, and the next use, or the next run, resolves the alias or the current version again. Only the `address` pin protects across runs. |
| The KMS or an adapter returns a malformed signature, or one from another key              | Core, every provider: every signature is verified against the key before use. See [Every signature is verified](#every-signature-is-verified).                                                                                                                                                                                                                                                                                                                             |
| The digest or signature is corrupted between the plugin and Google Cloud KMS              | Built-in Google Cloud adapter only: CRC32C checksums in both directions. A mismatch is retried at most three times, then fails.                                                                                                                                                                                                                                                                                                                                            |
| Credentials or key ids leak through errors and logs                                       | See [No secrets in errors, logs or task output](#no-secrets-in-errors-logs-or-task-output).                                                                                                                                                                                                                                                                                                                                                                                |
| A client retries a send and the transaction goes out twice                                | A send whose broadcast gets no answer fails with code `-32000` and the transaction hash. If the same request comes back on the same connection within 120 s, the plugin usually sends the same signed bytes again; if that nonce has since been used and the node does not know the transaction, it signs a new one. See [Transactions from one account go out in order](#transactions-from-one-account-go-out-in-order).                                                  |

## Guarantees

The plugin's core enforces the first four guarantees below, outside the adapter, so they hold for third-party providers as well as the built-in ones. Signature verification runs after the adapter answers; the digest rule, the typed-data chain check and the send lock run before any adapter call.

### Every signature is verified

No signature leaves the plugin unless it recovers to the account's address. The signer parses each signature strictly, checks the range of `r` and `s`, folds `s` to its low form, finds the recovery bit by trying each candidate against the public key it already knows, and verifies the result. Messages and typed data are checked once more with an EIP-191 or EIP-712 verifier, and a transaction must recover to its `from` before it is sent. A signature that fails one of the signer's own checks (parse, range, recovery and verification against the key) gets one fresh attempt, then an error. A failure of the final EIP-191 or EIP-712 verification, or of the sender check, fails at once. See [decision 0004](../../contributor/decisions/0004-verify-every-signature.md).

### No bare digests over RPC

No JSON-RPC method signs an arbitrary 32-byte digest. `eth_sign` and `personal_sign` both add the EIP-191 prefix, as Hardhat does. Signing a raw digest is possible only with the [`kms sign --no-hash`](../reference/tasks.md#raw-digests) task, which prints a warning each time it runs. A tool that expects raw-digest signing over RPC does not work with a KMS account, by design. See [decision 0003](../../contributor/decisions/0003-no-bare-digest-over-rpc.md).

### Typed data checks its chain

When typed data names a chain in `domain.chainId`, it must equal the connection's chain, read with `eth_chainId`, or the request fails before any sign request. (For a key without an `address` pin, the first request may still read the key's public key.) `chainId: 0` is checked like any other value. `kms.allowCrossChainTypedData: true` turns the check off. Typed data without `domain.chainId` is signed, as Hardhat, Foundry and MetaMask sign it, and its signature is valid on every chain. The `kms sign --data` task runs the same check against `--chain`, else the `--network` config's `chainId`, else that network's `eth_chainId`; without `--chain` or `--network`, typed data that names a chain is refused. `--allow-cross-chain` turns the check off for one run. See [decision 0011](../../contributor/decisions/0011-typed-data-chain-check.md).

### Transactions from one account go out in order

The send lock runs sends from one KMS address on one chain one after the other, so parallel sends from one account on one connection get consecutive nonces. Each request reaches the node's `eth_sendRawTransaction` at most once, and a request never signs again after its broadcast. When a broadcast gets no answer, the plugin keeps the signed bytes for 120 s. A retry of the identical request usually resends them, with the same hash and nonce; if that nonce has since been used and the node does not know the transaction, the plugin signs a new one. A retry is also signed afresh when it comes on another connection (the cache is per connection), when its params cannot be used as a cache key (a `Date` or a `Map`, for example), or after a later send asked the node about the first transaction and the node did not have it. See [Nonces and the send lock](../../contributor/transactions.md#nonces-and-the-send-lock) and [Retries after broadcast](../../contributor/transactions.md#retries-after-broadcast).

### No secrets in errors, logs or task output

The built-in providers never read credentials from the Hardhat config: each provider's SDK finds them in its default chain. The plugin's errors are built from a short list of fields (provider, operation, key display id, the SDK error's class name or code, HTTP status, request id) and never wrap the SDK's own error, which can carry request headers. The [debug output](../guides/debug-output.md) never contains configuration variable values, credentials or a provider's error messages. A test plants secrets in configuration variables, in a third-party key's token and in a provider's error message, and fails if any of them reaches the output.

A key id read from a configuration variable shows as the variable's name, such as `aws:<AWS_KMS_KEY_ID>`, in errors, debug output and task output. A literal id written in the config prints as written; only ids from variables are masked. `kms accounts --show-ids` shows the variables' values too, after a warning on standard error. See the [tasks reference](../reference/tasks.md#kms-accounts).

## What the plugin does not protect against

- Access to the key. Anyone or anything with permission to sign with the key in your cloud account can sign anything with it, without the plugin. Your provider's IAM or RBAC decides that. The setup guides give the minimal permissions for [AWS](../guides/aws-kms-setup.md#2-allow-signing-and-nothing-else), [Google Cloud](../guides/gcp-kms-setup.md#2-allow-signing-and-nothing-else) and [Azure](../guides/azure-key-vault-setup.md#2-allow-get-and-sign-and-nothing-else).
- Code in the same process. Any script, test, plugin or dependency that runs in your Hardhat process can send requests to the connection and get your KMS accounts to sign transactions, messages and typed data, as it could with Hardhat's local accounts. It can also run the plugin's tasks from code: `kms sign --no-hash` signs any digest, `kms sign-tx` signs transactions without sending them, and `kms sign-auth` signs an EIP-7702 authorization that delegates the account to any contract, which hands that contract control of the account until another authorization replaces it; with `force` it signs one for chain 0, valid on every chain. A third-party provider package is code in the same process too: it reads its key's config, including any credentials there, and the error messages it raises reach you unchanged. Run only code you trust in a process that has access to a key that holds funds.
- Cross-chain replay of messages and chainless typed data. `personal_sign` and `eth_sign` signatures carry no chain, and neither does typed data without `domain.chainId`. Such a signature is valid on every chain; the contract that checks it must bind it to a chain itself.
- Nonce collisions between processes. The send lock covers one Hardhat process. Two processes sending from the same key at the same time can choose the same nonce, and one transaction then replaces or blocks the other. See [Parallel sends and failed broadcasts](../reference/rpc-methods.md#parallel-sends-and-failed-broadcasts).
- Key deletion and lockout. If the key is deleted, or nobody can reach it any more, the funds and roles at its address are lost for good: nobody holds a copy of the private key. [Prevent and recover from losing a key](../guides/key-loss.md) covers each provider's waiting period, the undo paths, lockout and backups.
- The KMS service and the machine running Hardhat. The plugin trusts the provider's service to keep the key, and the machine's credentials to be yours. [SECURITY.md](../../../SECURITY.md) lists these as out of scope.

## What you configure

The plugin's checks work best with these settings:

| Setting                        | Why                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Least-privilege access         | Grant the identity that runs Hardhat only what signing needs, as the setup guides for [AWS](../guides/aws-kms-setup.md), [Google Cloud](../guides/gcp-kms-setup.md) and [Azure](../guides/azure-key-vault-setup.md) show. On AWS, the policy's `kms:SigningAlgorithm` and `kms:MessageType` conditions limit `kms:Sign` to what the plugin sends. |
| An `address` pin on each key   | The plugin refuses to sign if the key no longer derives to that address, for example after an alias was moved. Get the address with `npx hardhat kms accounts`. See the [configuration reference](../reference/configuration.md#configuration) and [Rotate a key and pin its address](../guides/key-rotation.md).                                 |
| `chainId` on each http network | The plugin then also checks the node's `eth_chainId` against your config, so a wrong RPC URL fails before a transaction or chain-bound typed data is signed. Messages do not read the chain.                                                                                                                                                      |
| `timeoutMs`                    | The time each KMS call may take, 30 s by default, set in `kms.defaults` or per key. Read the next section before you lower it.                                                                                                                                                                                                                    |
| `kms.allowCrossChainTypedData` | Leave it `false`, the default, unless you sign typed data for another chain on purpose.                                                                                                                                                                                                                                                           |

## When a KMS call times out

A timeout ends the plugin's wait, not the KMS's work. A sign request that reached the KMS can still be signed after the plugin has given up on it. The plugin never uses such a late signature.

### What the plugin does

Each KMS call runs under its own time limit, `timeoutMs`. When the limit passes, the plugin stops waiting and the request fails with `no answer within <timeoutMs> ms`. For AWS and Azure, the plugin hands the limit to the SDK as an abort signal. For Google Cloud it sets `timeoutMs` as each attempt's deadline and starts no new attempt once the plugin's time is up, so an attempt already in flight can outlive the plugin's give-up by up to `timeoutMs`. A request already on the network can still arrive and be signed.

Whatever answer comes back late, the plugin drops it. It never returns a late signature to your script and never sends it to the node. A late answer to a key lookup cannot choose the key either: the AWS adapter keeps a key ARN, and the Azure adapter pins a key version, only from a lookup that finished in time.

The plugin does not retry a timed-out call. For a transaction, the failure comes before the broadcast, so nothing is sent and the nonce is not used: running the script again fills the same nonce. Raise `timeoutMs` if your KMS is slow to answer.

### How many sign requests one call can send

One request to the plugin makes at most two signer calls (`packages/hardhat-kms/src/internal/signer/kms-signer.ts:299-318`). The second happens only when the first returned a signature that failed the signer's checks; a timeout or any other error is never retried by the signer. Each signer call can in turn send several requests to the KMS, because the provider's SDK, or the adapter, retries transient failures:

| Provider         | Requests per signer call                                                                                      | Worst case per request | Source                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS KMS          | Up to 3 attempts, the AWS SDK's default. A higher `AWS_MAX_ATTEMPTS` or profile `max_attempts` raises it.     | 2 x 3 = 6              | `DEFAULT_MAX_ATTEMPTS = 3`, `AWS_MAX_ATTEMPTS` and `max_attempts` in `@smithy/core` 3.35.0 (`submodules/retry`). The plugin sets no `maxAttempts`: `packages/hardhat-kms-aws/src/internal/adapter.ts:173-177`. |
| Azure Key Vault  | Up to 4: the first request and up to 3 retries, the Azure SDK pipeline's default.                             | 2 x 4 = 8              | `DEFAULT_RETRY_POLICY_COUNT = 3` in `@azure/core-rest-pipeline` 1.25.0 (`constants.js`). The plugin passes only `httpClient`: `packages/hardhat-kms-azure/src/internal/adapter.ts:76`.                         |
| Google Cloud KMS | Up to 4: the first request and up to 3 retries by the adapter, only after a CRC32C mismatch or `UNAVAILABLE`. | 2 x 4 = 8              | `MAX_RETRIES = 3` in `packages/hardhat-kms-gcp/src/internal/adapter.ts:19`; the SDK's own retries are off (`retry: null`, `:248`).                                                                             |

Any of these requests can reach the KMS and produce a signature the plugin never sees, before or after the plugin stops waiting.

### What this means for you

- Your provider's request counts and audit logs can show more sign requests than the signatures your script used. Each extra one is for the same digest your script asked for, never for another one.
- If you use a third-party provider plugin that asks a person to approve each signature, an approval request can stay open after the plugin has given up on it. Approving it then signs a digest that the plugin drops, and your script has already seen an error.
- A timeout on a send leaves no transaction behind. Check the error, then run the script again; the plugin fills the transaction afresh.

## Audit logs

Each cloud provider records sign requests in its own audit log, whoever makes them. [`kms history`](../reference/tasks.md#kms-history) reads that log for one key. It shows only what the log holds: the plugin keeps no record of its own signatures, and it fills in nothing. So the history can show who signed with a key, when, from where and with which tool, including signatures made outside the plugin. It cannot show what was signed: no provider logs the message, the typed data, the transaction or the signature. Google Cloud logs the digest; AWS and Azure do not.

What each provider records for a sign request, from the providers' documentation on 2026-10-02. The Google Cloud and AWS columns were also checked against real log entries on 2026-10-02; on AWS, `requestID` is the `$metadata.requestId` the SDK returns. The readers are in progress ([#126](https://github.com/aelmanaa/hardhat-kms/issues/126)), and a live test will check the entries marked with an asterisk.

| Field           | AWS KMS (CloudTrail `Sign`)        | Google Cloud KMS (`AsymmetricSign`)                             | Azure Key Vault (`KeySign` in `AZKVAuditLogs`)    |
| --------------- | ---------------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| Time            | `eventTime`                        | `timestamp`                                                     | `TimeGenerated`                                   |
| Principal       | `userIdentity`                     | `authenticationInfo.principalEmail`                             | `Identity`                                        |
| Key and version | key ARN in `resources`; no version | `resourceName`, the full key version name                       | `Id` and `RequestUri`, which holds the version    |
| Source IP       | `sourceIPAddress`                  | `requestMetadata.callerIp`, which may be `private`              | `CallerIpAddress`                                 |
| User agent      | `userAgent`                        | `requestMetadata.callerSuppliedUserAgent`                       | `ClientInfo`                                      |
| Request id      | `requestID`, set by the service    | not logged; see below                                           | `CorrelationId`\*                                 |
| Digest          | not logged                         | `request.digest.sha256`, 64 lowercase hex; the reader adds `0x` | not logged                                        |
| Outcome         | `errorCode`, `errorMessage`        | `status`                                                        | `ResultType`, `HttpStatusCode`                    |
| Setup           | none, on by default                | Data Access logs for Cloud KMS, off by default                  | a diagnostic setting to a Log Analytics workspace |
| Delay           | about 5 minutes, not guaranteed    | not documented                                                  | up to 10 minutes                                  |
| Retention       | 90 days                            | 30 days in the `_Default` bucket                                | set on the workspace; 31 days included            |
| Read permission | `cloudtrail:LookupEvents`          | `roles/logging.privateLogViewer`                                | workspace query and table read                    |

Google Cloud logs no request id: the only id of an entry is its `insertId`. Its reader lists `requestId` in `notLogged` and puts the `insertId` in `extra.insertId`.

What this means for you:

- **An empty history proves little.** On Google Cloud and Azure, logging can be off, a caller can be exempted, logs can be routed elsewhere, and a protected table returns no rows. On AWS, CloudTrail event history is kept per account and Region, and the read uses your credentials: a key used from another account, or read from another account or Region, can show nothing. `kms history` says so instead of reporting "no signatures", unless the reader confirms that it sees every sign request on the key.
- **The user agent is a claim.** The plugin's requests can carry a `hardhat-kms/<version>` user agent, but any client can send the same string.
- **Retries show up.** One signature can appear as several log entries for the same digest; see [How many sign requests one call can send](#how-many-sign-requests-one-call-can-send).
- **The output is sensitive.** It holds principals, IP addresses and user agents. Key ids, provider id fields and error messages are masked unless you pass `--show-ids`. Principals are not masked, so an AWS principal ARN shows its account id. The one exception: a value the plugin hides everywhere, such as a Google Cloud project id from a configuration variable, is hidden inside a principal's email too. That is accepted, since the variable exists to keep the project out of the output.
- **Reading signs nothing.** The task holds no key material and makes no signing call. On AWS, finding the key ARN of an alias or a bare key id needs one `GetPublicKey` call, which CloudTrail logs.

## Read next

- [Threat model summary](../../contributor/signing-pipeline.md#threat-model-summary), and the signature pipeline and key pinning, for contributors and security reviewers.
- [Prevent and recover from losing a key](../guides/key-loss.md).
- [Comparison with Foundry](foundry-comparison.md): the checks hardhat-kms adds over Foundry's KMS signers.
- [SECURITY.md](../../../SECURITY.md): how to report a vulnerability.
