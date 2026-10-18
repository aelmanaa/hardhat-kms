# 0020: Fail at once when a Turnkey activity needs approval

Status: Accepted (2026-10-17)

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
