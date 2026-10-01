# Testing

Audience: Contributors writing or running tests.

Status: M1 adds the signing core's unit tests: crypto vectors and properties, the signer against a fake adapter, and byte equivalence with Hardhat's message and typed-data vectors. M3 adds the AWS adapter's tests in `packages/hardhat-kms-aws/test`. The other tests arrive with their milestones.

## Testing strategy

Tests form a pyramid. The lower layers are fast and pure; the upper layers exercise real SDKs and real chains.

1. Unit tests for pure crypto:
   - Vectors for SPKI DER/PEM, JWK with stripped zeros, the wrong curve, and DER strictness.
   - fast-check properties: high-S and low-S DER both normalise and recover to the address; parsing random bytes never succeeds silently; JWK and SPKI encodings convert back and forth without loss.
   - CRC32C vectors.
   - The vendored EIP-712 code checked against the package's `verifyTyped`.
2. Unit tests for the signer and adapters:
   - Injected fake SDK clients sign with a local key and return the exact wire formats: AWS SPKI + DER; GCP PEM + DER + CRC (including corrupted CRCs); Azure JWK + r‖s.
   - Assertions on request parameters: `MessageType: DIGEST`, the ARN taken from `GetPublicKey`, `ES256K` with the versioned id, the GCP call options.
   - A fake adapter that returns a signature from the wrong key, and an address-pin mismatch.
   - An AbortSignal timeout, driven by an injected clock.
   - Bounded GCP CRC retries, and the Azure managed identity timeout.
   - The AWS adapter's tests are in `packages/hardhat-kms-aws/test/unit/adapter.test.ts`, with the fake SDK in `packages/hardhat-kms-aws/test/helpers/fake-aws-kms.ts`.
3. Byte equivalence:
   - A deterministic fake backend (RFC6979 with Hardhat's test key) must produce raw transactions and signatures byte-identical to Hardhat's `local-accounts.ts` vectors: legacy, 2930, 1559, 7702, eth_sign, personal_sign, 712.
   - Differential checks against viem `signTransaction` and ethers `Wallet.signTransaction`.
   - The differential fill test described under [Transaction filling](transactions.md#transaction-filling), run against the Hardhat floor and `latest`.
4. Integration tests on a real HRE with `edr-simulated` and a fake adapter registered through the `kms` hook:
   - hardhat-viem and hardhat-ethers flows: deploy, every transaction type, and `signMessage`/`signTypedData` verified on chain with `ecrecover`.
   - N parallel sends plus reads: consecutive nonces and no deadlock.
   - Retry behaviour with viem on an http network: no double broadcast, and no retry after send.
   - Mixed local and KMS accounts.
   - Chain-id guards.
   - Config errors reported at the exact path.
   - Every task.
   - `hardhat run` exits.
   - Error messages never contain the injected fake secrets.
5. Provider packages with their real SDK against a local endpoint:
   - `packages/hardhat-kms-aws/test/integration/plugin.test.ts` loads `hardhat-kms-aws` in an HRE and signs through the real `@aws-sdk/client-kms`. The SDK talks to a local HTTP server that speaks the KMS JSON 1.1 protocol (`packages/hardhat-kms-aws/test/helpers/kms-server.ts`). The test checks the `X-Amz-Target` of each request, that `Sign` uses the key ARN from `GetPublicKey` with `MessageType: DIGEST`, and the region in the SigV4 credential scope. It also checks that the handler passes keys of other providers on, and that listing `hardhatKms` and `hardhatKmsAws` together works.
   - `packages/hardhat-kms-aws/test/integration/sdk-loading.test.ts` checks that loading a config loads no AWS SDK module, and that creating an AWS adapter does (see [SDK loading](architecture.md#sdk-loading)).
   - These tests run the SDK version in `pnpm-lock.yaml`. Testing the lowest version each package allows is tracked in [#94](https://github.com/aelmanaa/hardhat-kms/issues/94).
6. Emulated AWS: `packages/hardhat-kms-aws/test/localstack/aws-kms.test.ts` starts LocalStack `4.14.0`, pinned by digest and bound to a random port on 127.0.0.1, and runs the real `@aws-sdk/client-kms` through the plugin against keys it creates. Each of 32 signatures must verify and recover to the key; about half come back high-S, and the test fails unless it saw both kinds. An alias moved to another key after the first lookup must keep signing with the first key, a key ARN without a configured region must work, and P-256 and symmetric keys are refused. Real KMS always echoes the key ARN and algorithm and never offers secp256k1 keys for encryption, so the checks on those response fields are covered by the unit tests only. Run it with `pnpm run test:localstack`, which needs Docker. In CI it runs on Ubuntu only, in the `localstack` job.
7. Live tests (`pnpm run test:live`) use real AWS, GCP and Azure keys on Sepolia. A developer runs them locally with their own `aws`, `gcloud` and `az` logins; nothing is stored in the repository, and providers without a configured key are skipped. They deploy, send every transaction type, and verify message and typed-data signatures on chain. Transaction hashes are recorded in `docs/live-proof.md`. Running them in GitHub Actions with OIDC federation is planned before the repository goes public ([#79](https://github.com/aelmanaa/hardhat-kms/issues/79)).
8. Mutation testing runs Stryker (tap-runner) on `crypto/` and `signer/`. It becomes a nightly job after milestone M9.

Test code follows a few conventions:

- Each test opens a fresh connection with `hre.network.create()` (`connect()` is deprecated since Hardhat 3.18; `getOrCreate()` reuses cached connections, so per-connection state must tolerate reuse).
- HRE test files run with `concurrency:false`.
- Test globs are quoted in scripts, so the shell does not expand them.
- Helpers live in each package's own `test/helpers`, because `hardhat-test-utils` is private.
- The root `test`, `test:unit` and `coverage` scripts run `pnpm run build` first, because provider packages import the core from its built `dist/`.

Coverage uses c8 on native TypeScript (Node 24), with a threshold of 95% for lines, branches, functions and statements across each package's `src/`, set in the package's `.c8rc.json`. Provider adapters are tested with fake SDK clients, so they are held to the same bar. `types.ts` and `type-extensions.ts` are excluded.
