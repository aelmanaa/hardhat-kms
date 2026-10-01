# Security model

Audience: users who hold funds or contract roles at a KMS key's address and want to know what the plugin guarantees, what it leaves to them, and what can still go wrong. Assumes you have read [How hardhat-kms works](how-it-works.md) or know the path of a request.

Status: Implemented. Every guarantee below is on `main`. The contributor version, with the code that enforces each control, is the [threat model summary](../../contributor/signing-pipeline.md#threat-model-summary).

The plugin never holds a private key: the KMS signs and the plugin checks. Its job is to make sure that what the KMS signs is what you asked for, for the chain you meant, with the key you configured, and that nothing leaks on the way. Who may use the key at all is for your cloud provider's access control to decide, not the plugin.

## What the plugin protects against

Each row is one row of the [threat model summary](../../contributor/signing-pipeline.md#threat-model-summary), in the order it lists them.

| Risk                                                                                      | What the plugin does                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A script or dependency gets your key to sign a hash it built, such as another transaction | No RPC method signs a 32-byte digest the caller supplies. The plugin signs only transactions it filled itself, EIP-191 messages and EIP-712 typed data. See [No bare digests over RPC](#no-bare-digests-over-rpc).                                                                                                            |
| A signature made for one chain is used on another                                         | Each connection checks the node's chain id. Every transaction carries an explicit `chainId` that must match it, and typed data that names a chain must match it too. See [Typed data checks its chain](#typed-data-checks-its-chain).                                                                                         |
| The key changes underneath you: a rotation, or an alias that now points at another key    | Your `address` pin is checked before the first signature. AWS keys sign with the key ARN, not the alias, and Google Cloud and Azure keys sign with a pinned key version.                                                                                                                                                      |
| The KMS or an adapter returns a malformed signature, or one from another key              | Every signature is verified against the key before use. See [Every signature is verified](#every-signature-is-verified).                                                                                                                                                                                                      |
| The digest or signature is corrupted between the plugin and Google Cloud KMS              | CRC32C checksums in both directions. A mismatch is retried at most three times, then fails.                                                                                                                                                                                                                                   |
| Credentials or key ids leak through errors and logs                                       | See [No secrets in errors, logs or task output](#no-secrets-in-errors-logs-or-task-output).                                                                                                                                                                                                                                   |
| A client retries a send and the transaction goes out twice                                | A send whose broadcast gets no answer fails with code `-32000` and the transaction hash. If the same request comes back within 120 s, the plugin sends the same signed bytes again instead of signing a new transaction. See [Transactions from one account go out in order](#transactions-from-one-account-go-out-in-order). |

## Guarantees

The plugin's core enforces the first four guarantees below after the provider's adapter has answered, so they hold for third-party providers as well as the built-in ones.

### Every signature is verified

No signature leaves the plugin unless it recovers to the account's address. The signer parses each signature strictly, checks the range of `r` and `s`, folds `s` to its low form, finds the recovery bit by trying each candidate against the public key it already knows, and verifies the result. Messages and typed data are checked once more with an EIP-191 or EIP-712 verifier, and a transaction must recover to its `from` before it is sent. A signature that fails gets one fresh attempt, then an error. See [decision 0004](../../contributor/decisions/0004-verify-every-signature.md).

### No bare digests over RPC

No JSON-RPC method signs an arbitrary 32-byte digest. `eth_sign` and `personal_sign` both add the EIP-191 prefix, as Hardhat does. Signing a raw digest is possible only with the [`kms sign --no-hash`](../reference/tasks.md#raw-digests) task, which prints a warning each time it runs. A tool that expects raw-digest signing over RPC does not work with a KMS account, by design. See [decision 0003](../../contributor/decisions/0003-no-bare-digest-over-rpc.md).

### Typed data checks its chain

When typed data names a chain in `domain.chainId`, it must equal the connection's chain, read with `eth_chainId`, or the request fails before any KMS call. `chainId: 0` is checked like any other value. `kms.allowCrossChainTypedData: true` turns the check off. Typed data without `domain.chainId` is signed, as Hardhat, Foundry and MetaMask sign it, and its signature is valid on every chain. See [decision 0011](../../contributor/decisions/0011-typed-data-chain-check.md).

### Transactions from one account go out in order

The send lock runs sends from one KMS address on one chain one after the other, so parallel sends from one account on one connection get consecutive nonces. Each request reaches the node's `eth_sendRawTransaction` at most once, and the plugin never signs again after a broadcast. When a broadcast gets no answer, the plugin keeps the signed bytes for 120 s, and a retry of the identical request resends them, so the retry has the same hash and nonce. See [Nonces and the send lock](../../contributor/transactions.md#nonces-and-the-send-lock) and [Retries after broadcast](../../contributor/transactions.md#retries-after-broadcast).

### No secrets in errors, logs or task output

The built-in providers never read credentials from the Hardhat config: each provider's SDK finds them in its default chain. The plugin's errors are built from a short list of fields (provider, operation, key display id, the SDK error's class name or code, HTTP status, request id) and never wrap the SDK's own error, which can carry request headers. The [debug output](../guides/debug-output.md) never contains configuration variable values, credentials or a provider's error messages. A test plants secrets in configuration variables, in a third-party key's token and in a provider's error message, and fails if any of them reaches the output.

A key id read from a configuration variable shows as the variable's name, such as `aws:<AWS_KMS_KEY_ID>`, in errors, debug output and task output. `kms accounts --show-ids` shows the values instead, after a warning on standard error. See the [tasks reference](../reference/tasks.md#kms-accounts).

## What the plugin does not protect against

- Access to the key. Anyone or anything with permission to sign with the key in your cloud account can sign anything with it, without the plugin. Your provider's IAM or RBAC decides that. The setup guides give the minimal permissions for [AWS](../guides/aws-kms-setup.md#2-allow-signing-and-nothing-else), [Google Cloud](../guides/gcp-kms-setup.md#2-allow-signing-and-nothing-else) and [Azure](../guides/azure-key-vault-setup.md#2-allow-get-and-sign-and-nothing-else).
- Code in the same process. Any script, test, plugin or dependency that runs in your Hardhat process can send requests to the connection and get your KMS accounts to sign transactions, messages and typed data, as it could with Hardhat's local accounts. It can also run the `kms sign --no-hash` task from code. Run only code you trust in a process that has access to a key that holds funds.
- Nonce collisions between processes. The send lock covers one Hardhat process. Two processes sending from the same key at the same time can choose the same nonce, and one transaction then replaces or blocks the other. See [Parallel sends and failed broadcasts](../reference/rpc-methods.md#parallel-sends-and-failed-broadcasts).
- Key deletion and lockout. If the key is deleted, or nobody can reach it any more, the funds and roles at its address are lost for good: nobody holds a copy of the private key. [Prevent and recover from losing a key](../guides/key-loss.md) covers each provider's waiting period, the undo paths, lockout and backups.
- The KMS service and the machine running Hardhat. The plugin trusts the provider's service to keep the key, and the machine's credentials to be yours. [SECURITY.md](../../../SECURITY.md) lists these as out of scope.

## What you configure

The plugin's checks work best with these settings:

| Setting                        | Why                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Least-privilege access         | Grant the identity that runs Hardhat only what signing needs, as the setup guides for [AWS](../guides/aws-kms-setup.md), [Google Cloud](../guides/gcp-kms-setup.md) and [Azure](../guides/azure-key-vault-setup.md) show. On AWS, the policy's `kms:SigningAlgorithm` and `kms:MessageType` conditions limit `kms:Sign` to what the plugin sends. |
| An `address` pin on each key   | The plugin refuses to sign if the key no longer derives to that address, for example after an alias was moved. Get the address with `npx hardhat kms accounts`. See the [configuration reference](../reference/configuration.md#configuration).                                                                                                   |
| `chainId` on each http network | The plugin then also checks the node's `eth_chainId` against your config, so a wrong RPC URL fails before a transaction or chain-bound typed data is signed. Messages do not read the chain.                                                                                                                                                      |
| `timeoutMs`                    | The time each KMS call may take, 30 s by default, set in `kms.defaults` or per key. Read the next section before you lower it.                                                                                                                                                                                                                    |
| `kms.allowCrossChainTypedData` | Leave it `false`, the default, unless you sign typed data for another chain on purpose.                                                                                                                                                                                                                                                           |

## When a KMS call times out

A timeout ends the plugin's wait, not the KMS's work. A sign request that reached the KMS can still be signed after the plugin has given up on it. The plugin never uses such a late signature.

### What the plugin does

Each KMS call runs under its own time limit, `timeoutMs`. When the limit passes, the plugin stops waiting and the request fails with `no answer within <timeoutMs> ms`. For AWS and Azure, the plugin hands the limit to the SDK as an abort signal; for Google Cloud it sets the same limit as the request's deadline and starts no new attempt once the time is up. A request already on the network can still arrive and be signed.

Whatever answer comes back late, the plugin drops it. It never returns a late signature to your script and never sends it to the node. A late answer to a key lookup cannot choose the key either: the AWS adapter keeps a key ARN, and the Azure adapter pins a key version, only from a lookup that finished in time.

The plugin does not retry a timed-out call. For a transaction, the failure comes before the broadcast, so nothing is sent and the nonce is not used: running the script again fills the same nonce. Raise `timeoutMs` if your KMS is slow to answer.

### How many sign requests one call can send

One request to the plugin makes at most two signer calls. The second happens only when the first returned a signature that failed the checks; a timeout or any other error is never retried by the signer. Each signer call can in turn send several requests to the KMS, because the provider's SDK, or the adapter, retries transient failures:

| Provider         | Requests per signer call                                                                                                                               | Who retries                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| AWS KMS          | Up to 3 attempts, the AWS SDK's default. The plugin does not change it, so the `AWS_MAX_ATTEMPTS` variable or a profile's `max_attempts` setting does. | The AWS SDK                       |
| Azure Key Vault  | Up to 4: the first request and up to 3 retries, the Azure SDK pipeline's default.                                                                      | The Azure SDK                     |
| Google Cloud KMS | Up to 4: the first request and up to 3 retries, only after a CRC32C mismatch or an `UNAVAILABLE` error. The SDK's own retries are off.                 | The plugin's Google Cloud adapter |

Any of these requests can reach the KMS and produce a signature the plugin never sees, before or after the plugin stops waiting.

### What this means for you

- Your provider's request counts and audit logs can show more sign requests than the signatures your script used. Each extra one is for the same digest your script asked for, never for another one.
- If you use a third-party provider plugin that asks a person to approve each signature, an approval request can stay open after the plugin has given up on it. Approving it then signs a digest that the plugin drops, and your script has already seen an error.
- A timeout on a send leaves no transaction behind. Check the error, then run the script again; the plugin fills the transaction afresh.

## Read next

- [Threat model summary](../../contributor/signing-pipeline.md#threat-model-summary), and the signature pipeline and key pinning, for contributors and security reviewers.
- [Prevent and recover from losing a key](../guides/key-loss.md).
- [Comparison with Foundry](foundry-comparison.md): the checks hardhat-kms adds over Foundry's KMS signers.
- [SECURITY.md](../../../SECURITY.md): how to report a vulnerability.
