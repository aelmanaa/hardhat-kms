# 0020: Fail at once when a Turnkey activity needs approval

Status: Accepted (2026-10-17), amended (2026-10-18)

Amended by [#537](https://github.com/aelmanaa/hardhat-kms/issues/537): a `sign_transaction` that fails after its request was sent, an activity that needs approval included, keeps its nonce held unless Turnkey refused the request for certain, and its error carries the activity id too. See [Amendment: transactions the plugin gave up on](#amendment-transactions-the-plugin-gave-up-on).

Issue: [#54](https://github.com/aelmanaa/hardhat-kms/issues/54)

## Context

A Turnkey policy can require more approvers through its `consensus`, which puts a signing activity in `ACTIVITY_STATUS_CONSENSUS_NEEDED`; an MFA policy can put it in `ACTIVITY_STATUS_AUTHENTICATORS_NEEDED`. Activities do not expire. The request counts as the first approval and starts a 24-hour window, after which approvals expire and must be submitted again ([Activities](https://docs.turnkey.com/api-reference/activities/overview)). An approval therefore takes a person minutes to a day.

The plugin signs inside JSON-RPC calls such as `eth_sendTransaction`, which a viem, ethers or Ignition script awaits, and it fills the transaction's nonce before it signs ([decision 0002](0002-fill-transactions-in-plugin.md)). Waiting for a person inside that call holds the script and the nonce. Giving up after `timeoutMs` leaves the activity pending: if someone approves it later, Turnkey produces a signature for a request the plugin abandoned, with a nonce the plugin may reuse.

Foundry's Turnkey client fails at once on consensus and puts the activity id in its error ([research, Foundry parity, P19](../research/turnkey.md#foundry-parity)). The plugin's errors otherwise carry no ids from the provider's answer. [#177](https://github.com/aelmanaa/hardhat-kms/issues/177) removed `approvalTimeoutMs` before 1.0 so that a wait could come back later as an additive field.

## Decision

The adapter fails as soon as an activity is in `ACTIVITY_STATUS_CONSENSUS_NEEDED` or `ACTIVITY_STATUS_AUTHENTICATORS_NEEDED`, with `turnkey.activity.approval-needed`. The message names the activity by its id when the id is a UUID, says that the activity stays pending, and tells the user to reject it. It is the only Turnkey error that carries the activity id: the id names no organization, and without it the user cannot find the activity to reject. An activity that is only `ACTIVITY_STATUS_PENDING` or `ACTIVITY_STATUS_CREATED` is polled until it ends or `timeoutMs` runs out, since Turnkey finishes it without a person.

A wait mode for keys that need approval is a follow-up: an optional per-key field, additive to the stable config types.

## Consequences

- A key whose policy needs approval cannot sign from the plugin. The [setup guide](../../user/guides/turnkey-setup.md#when-a-policy-needs-approval) gives a policy without approval for the API user and the steps to reject a pending activity by its id.
- A pending activity left by a failed call is the user's to reject. Whether the requesting API user can reject its own activity through `ACTIVITY_TYPE_REJECT_ACTIVITY` is not documented; if it can, a follow-up can reject on failure.
- An activity id appears in an error message, so a log of the error holds it. It identifies one activity, and every user of the organization can read that activity anyway.
- Revisit when users need human approval for deploys from Hardhat: the wait mode, its `displayMessage` and its interaction with the filled nonce then need their own design.

## Amendment: transactions the plugin gave up on

Amended on 2026-10-18 by [#537](https://github.com/aelmanaa/hardhat-kms/issues/537).

The context above reasons about "a signature for a request the plugin abandoned". It was written for digests, where a late signature is harmless. Since `sign_transaction` (#529), an abandoned transaction activity can complete and hold a signed transaction that every user of the organization can read and broadcast. A timeout or an abort while Turnkey has not finished leaves such an activity as surely as an approval does. The core released the nonce then, so the next send could sign it again: two valid transactions at one nonce, either of which could win.

The owner's rule is gap over duplicate. So:

- The Turnkey adapter sets `signTransactionOutlivesAbort` when it signs transactions with `sign_transaction`, and calls `ctx.requestSent` right before each submission leaves and again with the activity id ([Provider contract](../providers.md#provider-contract)).
- A `signTransaction` that then fails in any way fails with `core.signer.transaction-outstanding`, unless the adapter called `ctx.requestRefused`. Its message starts with the cause, names the nonce and, when it is a UUID, the activity id, and tells the user to reject the activity while it is pending, then to send a replacement with that nonce. The adapter reports a refusal only when Turnkey answered a submission with a 4xx and no earlier attempt of that body lost its answer or got a 5xx, or when the activity ended `FAILED` or `REJECTED`. This is a second error that carries the activity id, for the same reason as `turnkey.activity.approval-needed`: without it the user cannot find the activity.
- The connection's sends from the account skip that nonce until a transaction with it reaches the node through the connection, or the connection closes ([Transactions a provider may still sign](../transactions.md#transactions-a-provider-may-still-sign)). A failure before the request left, and a key with `transactionSigning: "digest"`, release the nonce as before.

This covers `turnkey.activity.approval-needed`: it is the most likely way for an abandoned activity to yield a transaction later, when someone approves it. The plugin still fails at once, as decided above, but the core wraps the error in `core.signer.transaction-outstanding` and keeps the nonce held; the user rejects the activity, then sends a replacement with that nonce. It also covers a poll that fails, an answer the adapter cannot read, and `turnkey.sign.transaction-mismatch`, after which Turnkey may hold a signed transaction at that nonce. Polling the activity once more before giving up remains a possible follow-up.

A completed signature is a copy too: Turnkey keeps every signed transaction, and one the node refused, for example for insufficient funds, becomes valid once the cause goes away. So a completed flagged `signTransaction` holds its nonce until a transaction with it reaches the node through the connection. A send whose broadcast the node refuses for certain fails with `core.tx.refused-provider-copy`, which names the nonce and the node's answer and asks the user to fix the cause, then send a replacement with that nonce or broadcast the copy. `eth_signTransaction` chooses its nonce as a send would, so it skips held nonces, and holds its own.
