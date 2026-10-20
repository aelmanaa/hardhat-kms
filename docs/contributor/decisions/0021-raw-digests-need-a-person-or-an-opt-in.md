# 0021: Raw digests need a person at a terminal or a per-key opt-in

Status: Accepted. Amends [0003](0003-no-bare-digest-over-rpc.md) and [0014](0014-library-account-raw-sign.md).

Issue: [#561](https://github.com/aelmanaa/hardhat-kms/issues/561)

## Context

[Decision 0003](0003-no-bare-digest-over-rpc.md) kept bare digests off the RPC path and left `kms sign --no-hash` to sign one with a warning and no question, as `cast wallet sign --no-hash` does, so that it works in CI. [Decision 0014](0014-library-account-raw-sign.md) added a second route, `getAccount(address, { rawSign: true })`, also with a warning. Both treated a raw digest as "a transaction or a permit".

A raw digest can also be an EIP-7702 authorization: `keccak256(0x05 || rlp([chainId, address, nonce]))`. Its signature delegates the account to any contract, with none of the checks of `kms sign-auth`: no chain-0 refusal, no delegate shown, and later no allowlist (#562). A hash cannot be reversed, so the plugin cannot tell an authorization from any other digest. Any script, plugin, dependency or agent in the Hardhat process can run the task with `noHash: true` or pass `rawSign: true`. A public post-mortem describes an agent that signed an EIP-7702 authorization to drainer code without its key leaving the agent ([mangrove-agent incident](https://github.com/MangroveTechnologies/mangrove-agent/blob/d4aa97b20ba3f5a0a0df750347a9d779b33c653b/docs/incidents/2026-04-24-eip7702-drain.md)).

The clouds do not help. AWS KMS, Google Cloud KMS and Azure Key Vault see only the digest. Turnkey receives raw digests and the plugin's authorizations the same way, as `HASH_FUNCTION_NO_OP` with `PAYLOAD_ENCODING_HEXADECIMAL`, so a Turnkey policy on authorizations binds only when that combination is denied.

## Decision

A raw digest is signed only after a person agrees at a terminal, or for a key whose config opts in.

- A new optional per-key field, `allowRawDigests: true`, in the fields every key shares (`commonKeyFields`), so it is validated at config load for every provider, third-party ones included, in `kms.keys` and in `kmsAccounts`. It defaults to off. A key from `--kms` has no config, so it cannot opt in.
- `kms sign --no-hash`: when standard input and standard error are both terminals, the task asks on standard error before any sign request, with the key, the account, the digest and the sentence "raw digest: the plugin cannot tell what it authorizes. It could be a transaction, a permit, or an EIP-7702 delegation of this account." The default is no; only `y` or `yes` signs. Any other answer, or input that closes, fails with `core.task.raw-digest-declined` and exits non-zero. A new `--yes` skips the question, but only for a key with the opt-in. Without a terminal, the task refuses unless the key opts in and `--yes` is given, and the error names what is missing.
- `getAccount(address, { rawSign: true })` fails with `core.account.raw-sign-not-allowed` unless the key opts in. When the config alone shows that no key that could be at the address opts in, it fails before the key lookup and so before any KMS call. The warning stays.

The question is the plugin's own helper (`src/internal/tasks/confirm.ts`), not `hre.interruptions.requestInput`. Hardhat's default writes the question to standard output, which holds the task's result; any plugin can answer it through the `userInterruptions` hook, which is the kind of code this question guards against; and its readline question never settles when standard input closes. The helper writes to standard error, reads one line, treats closed or failed input as a decline, and takes its streams as parameters so tests can drive it. The task runs it inside `hre.interruptions.uninterrupted`, so it does not interleave with another plugin's prompt. `kms sign-auth` (#563) reuses it.

## Consequences

- Raw signing becomes a property of the key, visible to a reviewer in the config, not a flag any caller can pass.
- A non-interactive `kms sign --no-hash` or `rawSign` that worked before fails until the key opts in, and the task needs `--yes` too. This shipped in a minor as a security change; the changeset says what to add.
- For a key with the opt-in, the opt-in is the only barrier between code that runs the task with `--yes` and a signed authorization. A test signs the digest of a known authorization this way and recovers the tuple, to record that.
- Code in the same process can still change the config before Hardhat loads it, or call the cloud SDK with the same credentials. The opt-in narrows what the plugin signs without a person; it does not make that code safe.
- For a key without an `address` pin, the task reads the address from the KMS before it asks, so the question can show it. That call reads the public key and signs nothing.
- A test drives the question through in-memory streams and through a child process whose standard input is closed. No pseudo-terminal test runs in CI.
