# 0019: Call Turnkey's API without a Turnkey SDK

Status: Accepted (2026-10-17). Amends [0009](0009-one-package-per-provider.md).

Issue: [#54](https://github.com/aelmanaa/hardhat-kms/issues/54)

## Context

[Decision 0009](0009-one-package-per-provider.md) says each provider package "depends on its SDK at versions this project tests". `@hardhat-kms/aws`, `@hardhat-kms/gcp` and `@hardhat-kms/azure` do. Turnkey's API needs much less than a cloud SDK: every request is a JSON `POST` to `https://api.turnkey.com` with an `X-Stamp` header, the base64url of `{ publicKey, scheme, signature }`, where `signature` is a DER ECDSA P-256 signature over the exact body ([Stamps](https://docs.turnkey.com/api-reference/overview/stamps)). The provider needed two calls when this was decided, `sign_raw_payload` and `get_activity`. [#515](https://github.com/aelmanaa/hardhat-kms/issues/515) added a third, `sign_transaction`, before the first release; the reasoning below holds for it unchanged.

The research ([Turnkey provider: research and design](../research/turnkey.md), F19 and section 3.1) weighed three transports:

- `@turnkey/http`: typed request bodies, but `TurnkeyClient.request` takes no `AbortSignal`, the package unpacks to 19 MB, and its polling helpers throw on consensus instead of letting the caller decide.
- `@turnkey/api-key-stamper` with our own `fetch`: keeps Turnkey's stamping code, and brings `@turnkey/crypto` with its pinned dependencies.
- No Turnkey dependency: stamp with `node:crypto` and call `fetch`, about 40 lines for the stamp. The plugin then owns abort, redirects, retries and error parsing, which every other provider needs it to control: the key's `timeoutMs` bounds the whole sign, a redirect must never carry the stamped body to another host, and an error must never quote Turnkey's message, which can name organizations.

## Decision

`@hardhat-kms/turnkey` has no runtime dependency besides its peer, `hardhat-kms`. It derives the P-256 API public key from the private key, stamps each body with `node:crypto` (`packages/hardhat-kms-turnkey/src/internal/stamp.ts`) and sends it with the global `fetch`, with the call's signal and `redirect: "manual"` (`src/internal/client.ts`). The API URL is fixed; tests pass another one to the adapter factory, and users cannot set it.

A conformance test keeps the stamp honest: `test/unit/stamp.test.ts` verifies the plugin's stamp with Turnkey's verifier and a stamp from `@turnkey/api-key-stamper` with the plugin's, for the same body and key. `@turnkey/api-key-stamper` and `@turnkey/crypto` are devDependencies only.

This amends 0009 for Turnkey: the package depends on no SDK. The rest of 0009 stands: one package per provider, released with the core at the same version, with the key format in the core.

## Consequences

- Installing `@hardhat-kms/turnkey` adds no package to a project, and there is no SDK version range to test, so `scripts/test-sdk-floors.ts` does not list it.
- The plugin owns a small implementation of Turnkey's request protocol. A change to the stamp format would break signing with a 401 until the plugin follows. The conformance test catches a change in Turnkey's stamper when its devDependency is updated; a change in the service shows only against the live API.
- Retries, polling and error mapping are the plugin's own and follow its rules: a retry resends the same body, so Turnkey answers the same activity and signs once, and errors carry the status and an allow-listed `turnkeyErrorCode` only.
- Revisit if the provider needs much more of Turnkey's API, such as wallet queries for a `getPublicKey`, where typed bodies would pay for a dependency.
