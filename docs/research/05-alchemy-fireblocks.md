# Research 05 — Alchemy and Fireblocks (2026-09-30)

## Verdict

- **Alchemy — no signer adapter; docs recipe in v1.1.** Account Kit v4 / Alchemy Signer (Turnkey-backed) / server signer are deprecated; new signer sign-ups off (changelog snippet, ~2026-06-18); Alchemy recommends Privy as signer. What remains is **Wallet APIs v5** (`@alchemy/wallet-apis` 5.2.7): signer-agnostic, takes any viem `LocalAccount`/`WalletClient`; defaults to EIP-7702 (EOA delegated to Alchemy smart-account code) + 4337 UserOps via bundler, optional Gas Manager sponsorship. Signer only receives `personal_sign` (UserOp hash), `eth_signTypedData_v4`, and `eip7702Auth` (needs `signAuthorization` → requires a LocalAccount, i.e. our v1.1 `getAccount()`). Smart-account send mode inside the plugin: v2, only on demand. Risk: delegating a deployer EOA to third-party code.
- **Fireblocks — real provider in v1.x after Turnkey, two modes.** `broadcast` (default): Fireblocks builds, approves (TAP policies, co-signers, async — minutes), broadcasts and returns the tx hash; caller nonce ignored (Fireblocks assigns); `eth_signTransaction` impossible (web3-provider returns 4200). `raw`: signs arbitrary digests — premium add-on, disabled by default in Testnet/Mainnet workspaces, enabled in the free Developer Sandbox; policy engine only sees an opaque hash. Messages/typed data map to `TYPED_MESSAGE` (ETH_MESSAGE / EIP712), returning {r,s,v∈{0,1}}. Auth: API key + RSA-signed JWT. `@fireblocks/hardhat-fireblocks` 1.3.6 (2024-11-12) is Hardhat-2-only (uses HH2 internals), ~3.4k/month, issue #24 "Add Hardhat V3 support" unanswered since 2025-11-21.

## Measured npm (last month 2026-08-31..09-29; trend Sep 2025 → Aug 2026)

@fireblocks/ts-sdk 254k (82k→249k) · fireblocks-sdk 251k · @fireblocks/fireblocks-web3-provider 72k (43k→87k) · @fireblocks/hardhat-fireblocks 3.4k (flat/declining) · @aa-sdk/core 191k · @account-kit/signer 38k (falling) · @alchemy/wallet-apis 51k (0→53k since 2026-01) · hardhat ~1.82M.

## Recommendation

| Target              | Support                                                    | When                   | Effort | Accounts                                                                                                                                  |
| ------------------- | ---------------------------------------------------------- | ---------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Alchemy signer      | none (sunset)                                              | —                      | —      | —                                                                                                                                         |
| Alchemy Wallet APIs | docs recipe (KMS LocalAccount as 7702 owner + sponsorship) | v1.1 with `getAccount` | S      | free Alchemy key + Sepolia gas policy                                                                                                     |
| Alchemy send mode   | on demand                                                  | v2                     | M      | same                                                                                                                                      |
| Turnkey             | provider                                                   | v1.1–1.2, first        | S–M    | Turnkey account                                                                                                                           |
| Fireblocks          | provider, `mode: "broadcast"` (default) + `"raw"`          | v1.3                   | M–L    | free Developer Sandbox (auto-approves, RAW on); Testnet workspace for approval/rejection paths (paid?) or mocks (`firemocks` unevaluated) |

Contract changes to make NOW (pre-1.0; breaking later): context object instead of positional signal; optional `signDigest`; structured `signMessage`/`signTypedData`/`signTransaction`; `getAddress?`; remote-broadcaster `sendTransaction?` (core skips nonce logic, rejects `eth_signTransaction` + EDR/fork, uses idempotency key as Fireblocks `externalTxId`, verifies `from` via receipt); `approvalTimeoutMs`. Approval UX: `displayMessage` on status change, cancel on abort, map BLOCKED_BY_POLICY/REJECTED to clear errors.

Uncertain: Alchemy sign-up shutdown date; Fireblocks duplicate `externalTxId` behaviour; Ignition vs Fireblocks-assigned nonces; viem refusing `signAuthorization` on JSON-RPC accounts; Testnet workspace pricing.
