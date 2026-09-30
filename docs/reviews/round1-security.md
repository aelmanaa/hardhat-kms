# Design review round 1 — cryptography & security

Independent reviewer; experiments in the session scratchpad `sec-review/` (Node 22.23.3, micro-eth-signer 0.19.0/0.14.0, @noble/curves 2.4.0, ox 1.8.5).

## Experimental evidence
1. Noble DER parsing is strict: rejects trailing bytes, long-form length, non-minimal 0x00, negative ints, r=0, s=n, bad SEQUENCE length, 65-byte compact, compact r≥n; accepts high-S DER (`hasHighS()` correct).
2. Noble v2 `verify` defaults to `prehash: true` → returns false for a valid digest signature unless `{prehash:false}`; rejects high-S by default.
3. micro-eth-signer 0.19: constructor accepts high-S (serializes; only `recoverSender()` throws); low-S with wrong parity recovers silently to another address; legacy txs are EIP-155 on the wire; `Transaction.prepare` legacy without chainId **silently defaults to chainId 1**.
4. 7702 authorizations are not low-S checked (`getAuthority` recovers high-S); `authorization._getHash` returns bytes; empty authorizationList throws.
5. EIP-712: ox, 0.14 `encoder` and 0.19 `verifyTyped` digests agree on valid input; ox silently ignores undeclared fields (0.14/0.19 throw); ox rejects bad-checksum addresses (micro-eth-signer accepts).
6. personal_sign must hex-decode: `_getHash("0x68656c6c6f") ≠ _getHash("hello")`; 32-byte input is EIP-191-prefixed, not raw.
7. viem retries on non-dev networks (hardhat-viem sets `retryCount: 0` only on dev networks); `shouldRetry` true for errors without numeric code (UnknownRpcError -1), -32603, -32005, 429.

## BLOCKER
- **B1 Double broadcast on retried `eth_sendTransaction`.** If we throw after `eth_sendRawTransaction` was accepted, viem retries → we re-read pending nonce (N+1) and broadcast a different second tx (e.g. two deploys). Fix: explicit non-retryable JSON-RPC codes; short-lived idempotency cache keyed by (chainId, from, hash(normalized request)) that rebroadcasts the SAME raw bytes; include the computed tx hash in ambiguous send errors; test with hardhat-viem on an http network.
- **B2 Mutex scope.** Process-global mutex keyed `chainId:address` + local nonce high-water mark `max(pending, lastUsed+1)` advanced only after a successful send. Document: separate processes are not coordinated.
- **B3 chainId always explicit.** Never let `prepare` default to mainnet; assert `tx.chainId == eth_chainId` and `== networkConfig.chainId` when set (our hook bypasses ChainIdValidator). No pre-155 legacy txs.

## SHOULD
- **S1 Verification order:** strict parse → range → low-S → trial recovery vs cached pubkey (throw; no x-reduced recids) → final check (`recoverSender().address === from` for txs; `eip191Signer.verify` / `verifyTyped` for messages). Any `secp256k1.verify` with `{prehash:false}`; fakes sign with `prehash:false`.
- **S2 Pinning:** check once before the first signature is released; cache pubkey only after it matches the `address` pin. AWS: sign with the ARN from GetPublicKey (not the alias); assert KeySpec/KeyUsage/SigningAlgorithms. GCP: disabled/destroyed → clear error, never auto-select another version; check response `name` and `algorithm`. Azure: versioned id; check `enabled`, `keyOps ∋ sign`, `exp`/`nbf`; on-curve check after JWK padding.
- **S3 Messages:** keep Hardhat's `eth_sign` = EIP-191 semantics, never raw-digest signing; strict hex decoding for eth_sign/personal_sign; EIP-712 reject `domain.chainId ≠ eth_chainId` by default (opt-out flag); 7702 authorization signing (if added): low-S, opt-in for chainId 0, nonce+1 when sender == authority; lint pre-signed tuples.
- **S4 EIP-712 lib:** ox pulls zod ^4, @noble/post-quantum, scure bip32/39, ens-normalize, abitype, eventemitter3 (~30 MB) and diverges in strictness → vendor micro-eth-signer 0.19 `core/typed-data.js` encoder (327 lines, MIT, same code as Hardhat core). If ox is kept: pin exactly + runtime `verifyTyped`.
- **S5 Secrets:** errors from an allowlist (provider, operation, pinned id, SDK error name/code, HTTP status, request id); never attach raw SDK errors as `cause` (AWS `$response`, Azure `RestError.request`, gaxios `config`); debug output: digests + addresses only; recommend narrowing credential chains.
- **S6 Timeouts/retries:** timeout covers the whole call incl. SDK retries; AWS/Azure `abortSignal`; GCP gax `timeout`/`retry` + `Promise.race`; retry sign on CRC mismatch / throttling (≤3, honour Retry-After); never re-enter fill→sign after a send.
- **S7 Versions:** declare micro-eth-signer as our own exact dependency; generate equivalence vectors against the Hardhat version users install. *(Note: reviewer checked hardhat 3.14.0 (^0.14); current hardhat 3.18.0 depends on ^0.19.0 — verified on npm 2026-09-30.)*

## NICE
- N1 Supply chain: lockfile, `npm ci --ignore-scripts`, Dependabot cooldown ~7 days (except security), trusted publishing + provenance, SHA-pinned actions; SDKs optional peers with tested floor versions + min/max CI job.
- N2 `eth_signTransaction` opt-in (signed txs outside the nonce lock).
- N3 On trial-recovery failure: one fresh sign attempt, then throw.

## README security model (proposed)
Protects: key never leaves the KMS/HSM; nothing on disk. Doesn't protect: a compromised machine/CI with valid credentials can sign anything; not a policy engine. Controls: AWS least privilege + conditions `kms:SigningAlgorithm`/`kms:MessageType`, deny ScheduleKeyDeletion/UpdateAlias to signers; GCP signer + publicKeyViewer at key scope, HSM level; Azure Crypto User at key scope, soft-delete + purge protection; short-lived creds; audit logs + alerting. Warn: deleting the key loses the account forever (non-exportable). EIP-712/191 signatures can authorize off-chain actions (permits).
