# 0013: Signing history comes only from the cloud audit logs

Status: Accepted (2026-10-02)

Issue: [#126](https://github.com/aelmanaa/hardhat-kms/issues/126)

## Context

After an incident, a team wants to know who signed with a production key, when, and from where, including signatures made without the plugin. Two designs were on the table:

- A local journal ([#125](https://github.com/aelmanaa/hardhat-kms/issues/125)): the plugin writes a line for each signature it makes, and `kms history` reads the file, optionally matched against the provider's log by request id.
- The cloud audit logs alone: `kms history` reads each provider's log for one key and prints the entries in one format.

What the providers record, read in their documentation on 2026-10-02:

- AWS CloudTrail event history logs every `Sign` call, is on by default and keeps 90 days. It has no field for a client-supplied id.
- Google Cloud logs `AsymmetricSign` as a Data Access log, off by default, kept 30 days in the `_Default` bucket. It is the only log that holds the digest.
- Azure Key Vault sends `KeySign` to a Log Analytics workspace through a diagnostic setting. A Key Vault engineer said the client request id (`x-ms-client-request-id`) is not in the audit log (Azure/azure-sdk-for-js#13061).
- No provider logs the message, the typed data, the transaction or the signature.

So matching a log entry to a plugin request needs a server id kept from the moment of signing, which is local storage. A journal would also differ from machine to machine, could be lost or edited, and would make its directory sensitive if it held decoded payloads.

## Decision

Signing history comes only from the cloud providers' audit logs. The plugin stores nothing about the signatures it makes, and `kms history` shows nothing the log does not hold.

- One row per log entry, copied as logged. A field the provider never records is listed in `notLogged` and never filled in. A field the provider left empty in an entry shows as empty.
- The history covers the whole key: every version, even when the config pins one, with the version that signed in a `keyVersion` column where the provider logs it.
- Each provider package reads its own log through an optional `readSignHistory` method of the `kms` hook. Third-party providers can add a reader the same way. The log SDKs are regular dependencies of the provider packages, loaded only when `kms history` runs (decisions [0005](0005-lazy-sdk-loading.md) and [0009](0009-one-package-per-provider.md) rule out optional peer dependencies).
- The task never reports "no signatures". An empty result gets the `logging-not-confirmed` note unless the reader confirms that it sees every sign request on the key (on AWS, only when the caller's account is the key's account and the read is in the key's Region), and a reader that cannot read the log fails, naming the permission when the read was refused.
- The default output shows principals, IP addresses and user agents, masks key ARNs, resource names and key URLs as the key's display id, and keeps only the provider's error code. `--show-ids` shows the rest.
- No adapter contract change: `SignContext` gains no request-id field. #125 is closed as not planned.

## Consequences

- Anyone with read access to the log gets the same answer from any machine, and the history includes signatures made outside the plugin, which a journal could never show.
- Nothing to back up, rotate or protect on disk.
- The history cannot show what was signed, and on AWS and Azure it cannot tell which digest was signed. A follow-up could compute a transaction's digest from the chain and find its Google Cloud entry, still without storing anything.
- An event cannot be matched to a specific plugin request. The `hardhat-kms/<version>` user agent marks events that claim to come from the plugin, and the output labels it as client-reported.
- Google Cloud and Azure users must turn on logging, which their provider may bill for. The task cannot tell logging that is off from a key that signed nothing, so it says so.
- Reading needs extra permissions: `cloudtrail:LookupEvents`, `roles/logging.privateLogViewer`, or read access to the Log Analytics workspace.
- Each provider package grows by its log SDK, measured on 2026-10-02 at about 2.2 MB for AWS, 1.3 MB for Azure, and up to 3.9 MB for Google Cloud.

Revisit if a provider starts logging a client-supplied id, which would allow matching entries to plugin requests without storing anything.
