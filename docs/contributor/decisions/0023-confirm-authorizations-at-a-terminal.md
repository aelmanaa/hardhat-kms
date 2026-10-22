# 0023: Confirm EIP-7702 authorizations at a terminal, and refuse ones that cannot apply

Status: Accepted

Issue: [#563](https://github.com/aelmanaa/hardhat-kms/issues/563)

## Context

An EIP-7702 authorization lets the code at the delegate act for the account until another authorization replaces it. A security auditor called it "the one signature I'd want a human to look at every time". Before this decision, `kms sign-auth` printed one line about the authorization and signed without waiting for anyone. It refused chain 0 without `--force`, but it signed tuples that cannot work: a nonce the account has already used, a delegate that is itself a delegated account, a precompile. It did not show the account's current delegation or the delegate's code.

[EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) says what makes a tuple fail or misbehave. Its Behavior section skips a tuple whose authority has code that is not a delegation, or whose nonce is not the authority's nonce. Its Loops section says clients follow one delegation only, so a delegate that is itself delegated runs nothing. Its Precompiles section says a delegation to a precompile runs empty code, so calls succeed and do nothing. Its Security Considerations, with [ERC-7201](https://eips.ethereum.org/EIPS/eip-7201) and [ERC-7779](https://eips.ethereum.org/EIPS/eip-7779), describe storage collisions when an account moves from one delegate to another. A proxy delegate can change its code after the signature; its ERC-1967 implementation slot shows that.

Foundry's `cast wallet sign-auth` 1.8 asks only on chain 0 without `--force`, and on any answer but `y`, or closed input, prints `Aborted.` and returns success (`crates/cast/src/cmd/wallet/mod.rs`, `confirm_continue` in `crates/cast/src/cmd/mod.rs`), so a script cannot tell a refusal from a signature. Hardware wallets show the delegate and the chain on their own screen before they sign, and refuse delegates outside their list ([decision 0022](0022-per-key-delegate-allowlist.md)).

[Decision 0021](0021-raw-digests-need-a-person-or-an-opt-in.md) added the question helper (`src/internal/tasks/confirm.ts`) for raw digests and said `kms sign-auth` would reuse it. [Decision 0022](0022-per-key-delegate-allowlist.md) added `allowedDelegates`, which this decision uses for its non-interactive rule.

## Decision

`kms sign-auth` shows what the authorization does, refuses tuples that cannot apply, and signs only after a person agrees at a terminal or, with `--yes`, for a delegate the config allows.

- With `--network`, before it asks, the task reads `eth_getTransactionCount` for the account at `latest` and `pending`, `eth_getCode` for the account and the delegate (once each; the pin check of 0022 hashes the same answer the question shows), and `eth_getStorageAt` for the delegate's ERC-1967 implementation slot. With `--network` it always connects, even with `--nonce` and a configured `chainId`. With `--chain` alone it reads nothing, and the lines that need a node say "not checked".
- The summary shows the action (DELEGATE, or REVOKE for the zero address), the account and key, the delegate with its `allowedDelegates` label beside the checksummed address, the chain (`ALL CHAINS` for chain 0), the nonce against the account's nonce and whether the account sponsors it, the delegate's code size and keccak-256 hash, the account's current delegation, the node it read, the warnings, and three closing lines: the delegation lasts until replaced, it is not undone if the carrying transaction reverts, and anyone who holds the signature can submit it. Node data appears only as numbers, hashes and checksummed addresses.
- It refuses, before the question and any KMS call: a nonce below the account's `latest` nonce; a delegate whose code starts with `0xef0100`; a delegate from `0x01` to `0x1ff`, which covers Ethereum's precompiles (0x01 to 0x11, and 0x100 for P256VERIFY, EIP-7951 and RIP-7212) and Arbitrum's (0x64 to 0xff) where no contract can be deployed; and an account whose code is neither empty nor a delegation. Chain 0 still needs `--force`, now checked before the connection opens when `--chain` or the config gives it.
- It warns, and still asks, for a nonce above the pending count (+1 with `--self-broadcast`), a re-delegation from one delegate to another, a non-zero ERC-1967 slot, and a delegate without code.
- When standard input and standard error are both terminals, it asks with the 0021 helper, inside `hre.interruptions.uninterrupted`. Default no; only `y` or `yes` signs. Any other answer, or closed input, fails with `core.task.auth-declined`, exits non-zero, prints nothing on standard output and makes no sign request. A key with an `address` pin shows the pin, so a declined question makes no KMS call at all.
- `--yes` skips the question only for a delegate `checkDelegate` reports as `listed`, or the zero address. A key without `allowedDelegates` reports `unrestricted`, which is not a listing: at a terminal `--yes` prints a note and the task still asks.
- Without a terminal the task refuses unless `--yes` is given (`core.task.auth-no-terminal`) and the delegate is listed or the zero address (`core.task.auth-not-listed-no-terminal` for a key without the list; the 0022 errors for one that does not allow the delegate). Both refusals come before the connection opens. With `--yes`, or without a terminal, the summary goes to standard error without the prompt.
- `--force` stays the chain-0 switch. It does not skip the question and does not stand for `--yes`. No flag overrides the list.

## Consequences

- A person at a terminal sees what the signature does, from the node they chose, before anything is signed, and a declined question is an error a script can detect, unlike cast's.
- A non-interactive `kms sign-auth` that worked before fails until the delegate is in the key's `allowedDelegates` (or is the zero address) and the run passes `--yes`. Keys from `--kms` have no config, so they delegate only at a terminal. This shipped in a minor as a security change; the changeset says what to add.
- With `--network` the task always connects, so a `--network --nonce` run that used to need no node now does. The node's answers are untrusted: a lying node can hide code or a delegation, and the question says which network it read.
- The question stops callers without a terminal. As in 0021, it does not prove a person answered: a pseudo-terminal passes the check, and code in the same process can feed the input or run the task with `--yes` for a listed delegate. The list is the control that binds such code.
- Library accounts (`signAuthorization`) and transactions' self-authorizations have no person to ask; the list of 0022 is their only check. Simulating the delegate's code and a question before a signed tuple reaches the node for gas estimation are out of scope.
- Revisit the precompile range if a chain that supports EIP-7702 places precompiles above `0x1ff`.
