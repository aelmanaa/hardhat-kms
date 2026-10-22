# 0022: Each key can limit its EIP-7702 delegates, per chain

Status: Accepted

Issue: #562

## Context

An EIP-7702 authorization lets the code at its delegate act for the account until another authorization replaces it. Before this decision, nothing limited which contract a key could delegate to: a wrong address in a script, a malicious dependency, or an agent driven by injected text could get a production key to sign an authorization to any contract, through `kms sign-auth`, a library account's `signAuthorization`, or a self-authorization in a transaction.

Hardware wallets refuse delegates outside a list. Ledger's Ethereum app keeps one entry per delegate with a chain id or "all chains", and a chain-0 authorization matches only an "all chains" entry (`whitelist_7702.c`; app 1.22.4 fixed a bug where it also matched chain-specific entries). Trezor keeps a list per chain and refuses chain 0. Wallet services let a policy do the same: Privy on `ethereum_7702_authorization.contract`, Turnkey on `eth.eip_7702_authorization.address`. ERC-7902 says wallets "MUST maintain a strict shortlist" of acceptable delegations. The [security model](../../user/explanation/security-model.md#eip-7702-delegates) has the sources.

## Decision

A key may set `allowedDelegates`, a list of entries `{ address, chains, label?, codeHash? }`, where `chains` is `"all"` or a non-empty list of chain ids. It is validated with the fields every key shares, so it works the same for each built-in provider and for third-party keys.

- Unset, nothing changes. Set, a delegate must match an entry for the authorization's chain. An empty list allows only the zero address.
- A chain-N authorization matches entries listing N or `"all"`. A chain-0 authorization matches only `"all"`. Chain 0 cannot be listed as a number: it would read as "chain 0 only", which is "every chain".
- The zero address always passes, so a delegation can always be cleared.
- `codeHash` pins the delegate's runtime code. The plugin reads `eth_getCode` from the connection's node and refuses a mismatch, empty code, or an answer that is not hex. When no node is available (`kms sign-auth --chain`), a pinned delegate is refused: an unchecked pin would look like a check. For chain 0 the code is read on the connection's chain only, and a note says so.
- When several entries match, one without `codeHash` is enough; otherwise the code must match one of their hashes.
- No flag overrides the list: not `--force` (which only allows chain 0), not `allowChainZeroAuthorization`, and not the `--yes` that #563 adds.
- The check runs before any KMS sign request in `kms sign-auth`, `signAuthorization`, and for each authorization in a KMS sender's transaction that recovers to the sender (`eth_sendTransaction`, `eth_signTransaction`, `kms sign-tx`, the library `signTransaction`), next to the nonce and chain checks of #435. `kms sign-auth --network` refuses a delegate that no entry names before it connects, since opening the connection can call the KMS.

The plugin ships no built-in list. Which delegates a key needs is the project's decision, a built-in list would have to track deployments per chain, and a project that wants Ledger's list can copy its entries.

## Consequences

- A project that sets the list gets a refusal, with the key, delegate and chain, for every authorization the key's owner did not plan. #563 uses the list and its labels for its non-interactive rule and its question, and #564 builds the privileged-key rule on it.
- The list guards against mistakes and driven signing only. It does not help when the key or its cloud credential has leaked, which is how most early malicious delegations happened, nor against batch phishing through a listed delegate. Raw digests (`kms sign --no-hash`, `rawSign`) can be authorization hashes the list cannot see; #561 gates them. Tuples signed by other accounts are not checked.
- The list guards against mistakes, and agents or scripts that use the configured key names, not against code written to get around it. Whoever edits the config can widen it. The plugin freezes each resolved key, its list and the `kms.keys` record, so the list cannot be widened in place, but code in the same process can replace `hre.config.kms` or a network's `kmsAccounts`, edit the config before it loads, or call the cloud SDK. A `codeHash` trusts the node's `eth_getCode`, and pins a proxy's code, not its implementation.
- Keys from `--kms` have no config and so no list. `kms sign-auth` and `kms sign-tx` refuse a `--kms` key that is the same KMS key as a config key with a list, by key identity or by that key's `address` pin, since they can run without a connection, where the network hook makes the same comparison. A `--kms` key that names the key another way and matches no pin is not caught.
- Revisit if Turnkey authorizations move to `PAYLOAD_ENCODING_EIP7702_AUTHORIZATION`, where a Turnkey policy could enforce the same list outside the process.
