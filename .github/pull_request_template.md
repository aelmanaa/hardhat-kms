<!-- Every pull request closes or references an issue. Open one first if none exists. -->

Closes #

## What changes

## How it was tested

## Docs

<!-- Which user or contributor pages changed? New pages are linked from AGENTS.md and docs/README.md. Write "None" if nothing user- or contributor-visible changed. -->

## Security checklist

<!-- Fill this in if the pull request changes a path listed in docs/contributor/security-review.md; a CI check requires it. Otherwise delete this section. Tick an item when your change keeps it true or does not touch it, and add a short note when that is not obvious. docs/contributor/security-review.md explains each item. -->

- [ ] **Key.** The configured key signs, and no other: the identity checks and the `address` pin still run before a signature or address is returned.
- [ ] **Signed bytes.** The plugin signs the digest it built from its own copy of the request, every signature still recovers to the account address, and the chain-id checks still apply.
- [ ] **What the node receives.** A KMS transaction reaches the node only as bytes the plugin signed and checked, in one `eth_sendRawTransaction` per send.
- [ ] **Late or lost answers.** A KMS answer after the timeout is never used, and one request never fills or signs again after its broadcast.
- [ ] **Send lock and nonces.** Sends from a KMS key still run inside the send lock, and the nonce high-water mark moves only when the node is known to have the transaction.
- [ ] **Lifecycle.** Closing a connection drops its sends and timers, and the signer cache closes a client only after signing in flight ends.
- [ ] **Errors and logs.** No credential, raw SDK error, node URL or the value behind a masked identifier reaches an error, the `debug` output or a warning.
- [ ] **Tests.** Tests cover the changed behaviour, including its failure path.
