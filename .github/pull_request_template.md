<!-- Every pull request closes or references an issue. Open one first if none exists. -->

Closes #

## What changes

## How it was tested

## Docs

<!-- Which user or contributor pages changed? New pages are linked from AGENTS.md and docs/README.md. Write "None" if nothing user- or contributor-visible changed. -->

## Security checklist

<!-- Required when the pull request changes a path listed in docs/contributor/security-review.md; the "Security checklist" check enforces it. Delete this section otherwise. Tick an item when the change keeps it true or does not touch it, and add a note after the label when that is not obvious from the diff. What each item means: docs/contributor/security-review.md, "Checklist items". -->

- [ ] **Key.** The configured key signs, and no other: the identity checks and the `address` pin still run before anything is released.
- [ ] **Signed bytes.** The plugin signs the digest it built from its own copy of the request, every signature still recovers to the account address, and the chain-id checks still apply.
- [ ] **What the node receives.** A KMS transaction reaches the node only as bytes the plugin signed and checked, in one `eth_sendRawTransaction` per send.
- [ ] **Late or lost answers.** A KMS answer after the timeout is never used, and a request never fills or signs again once it has broadcast.
- [ ] **Send lock and nonces.** Sends from a KMS key still run inside the send lock, and the nonce mark moves only when the node is known to have the transaction.
- [ ] **Lifecycle.** Closing a connection or the signer cache releases its clients and timers, after signing in flight ends.
- [ ] **Errors and logs.** No credential, raw SDK error, node URL or masked identifier reaches an error, the `debug` output or a warning.
- [ ] **Tests.** Tests cover the changed behaviour, including its failure path.
