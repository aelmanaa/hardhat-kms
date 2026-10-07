<!-- Every pull request closes or references an issue. Open one first if none exists. -->

Closes #

## What changes

## How it was tested

## Docs

<!-- Which user or contributor pages changed? New pages are linked from AGENTS.md and docs/README.md. Write "None" if nothing user- or contributor-visible changed. -->

## Security checklist

<!-- Each ### heading below is a list of paths in docs/contributor/security-review.md. Keep the items of each list whose paths the pull request changes; a CI check requires them. Delete the rest, and the whole section if no listed path changed. Tick an item when your change keeps it true or does not touch it, and add a short note when that is not obvious. docs/contributor/security-review.md explains each item. -->

### Signing and sending

- [ ] **Key.** The configured key signs, and no other: the identity checks and the `address` pin still run before a signature or address is returned.
- [ ] **Signed bytes.** The plugin signs the digest it built from its own copy of the request, every signature still recovers to the account address, and the chain-id checks still apply.
- [ ] **What the node receives.** A KMS transaction reaches the node only as bytes the plugin signed and checked, in one `eth_sendRawTransaction` per send.
- [ ] **Late or lost answers.** A KMS answer after the timeout is never used, and one request never fills or signs again after its broadcast.
- [ ] **Send lock and nonces.** Sends from a KMS key still run inside the send lock, and the nonce high-water mark moves only when the node is known to have the transaction.
- [ ] **Lifecycle.** Closing a connection drops its sends and timers, and the signer cache closes a client only after signing in flight ends.
- [ ] **Errors and logs.** No credential, raw SDK error, node URL or the value behind a masked identifier reaches an error, the `debug` output or a warning.
- [ ] **Tests.** Tests cover the changed behaviour, including its failure path.

### Release and supply chain

- [ ] **What gets published.** The tarballs hold only the files each manifest allows, built from the tagged commit and checked by `check-tarballs.ts`; a new dependency, lifecycle script or `bin` entry is named in the description.
- [ ] **Who can publish.** Only a signed tag pushed by a repository admin starts a release, and the `npm-publish` and `npm-latest` approvals still apply. No job gains a token, secret or permission it does not need, and every action stays pinned by SHA.
- [ ] **What the release gate checks.** Every check before publishing or moving `latest` still runs, and still fails when it cannot get an answer (a missing run, an API error). The security checklist still reads its script, lists and template from the base branch.
