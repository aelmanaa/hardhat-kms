# Research 03 — Cloud KMS SDKs, crypto pipeline, existing implementations

Checked against installed package sources (2026-09-30). A working end-to-end prototype of the crypto pipeline is in `pipeline-prototype.mjs` (20 rounds passed).

## 1. Official SDKs
| | AWS | GCP | Azure |
|---|---|---|---|
| Packages | `@aws-sdk/client-kms` 3.1143.0 (node>=20) | `@google-cloud/kms` 6.2.1 (node>=22) | `@azure/keyvault-keys` 4.10.2 (node>=20), `@azure/identity` 4.13.3 (node>=22) |
| Default creds | `new KMSClient({ region })`; default chain (env → sso/ini → process → web identity → IMDS/ECS); region REQUIRED | `new KeyManagementServiceClient()` uses ADC (`gcloud auth application-default login`); `{fallback:true}` = REST | `new DefaultAzureCredential()` (Env → WorkloadIdentity → ManagedIdentity → AzureCli → AzDeveloperCli → PowerShell → VSCode/Broker); `AZURE_TOKEN_CREDENTIALS` narrows |
| Public key | `GetPublicKeyCommand({KeyId})` → `PublicKey` DER SPKI + `KeySpec`, `KeyUsage`, `SigningAlgorithms` | `getPublicKey({name: .../cryptoKeyVersions/N})` → `pem` (SPKI PEM), `pemCrc32c`, `algorithm`, `protectionLevel` | `KeyClient.getKey(name,{version})` → JWK `kty` EC/EC-HSM, `crv` P-256K, `x`/`y` big-endian, MAY BE SHORTER THAN 32 BYTES |
| Sign | `SignCommand({KeyId, Message: digest32, MessageType:'DIGEST', SigningAlgorithm:'ECDSA_SHA_256'})` — default MessageType is RAW (would hash again) | `asymmetricSign({name, digest:{sha256}, digestCrc32c:{value}})` | `CryptographyClient(keyOrVersionedId, cred).sign('ES256K', digest32)` |
| Signature | DER | DER + `signatureCrc32c`, `verifiedDigestCrc32c`, `name`, `protectionLevel` | raw 64-byte r‖s |
| Key spec | `ECC_SECG_P256K1`, usage SIGN_VERIFY | `EC_SIGN_SECP256K1_SHA256`, purpose ASYMMETRIC_SIGN | `EC`/`EC-HSM` on `P-256K` |

Caveats:
- GCP: proto comment says secp256k1 "only supported for HSM protection level"; docs page may list more — UNRESOLVED; document HSM. Docs claim lower-S output; normalize anyway.
- GCP default retry config: 60 s per RPC, 600 s total → override with call options.
- Azure Managed HSM supports P-256K (330 sign/s per partition).
- Azure `CryptographyClient` with a string id: lazy `getKey` on first op (403 → silently remote-only); a VERSIONLESS id signs with the current version (rotation silently changes the address); `SignResult.keyID` is built client-side (can't confirm which version signed). Fix: `getKey` once, pin `properties.version`, build the client from the versioned key.
- Azure `ensureValid` checks `keyOperations` includes `sign` and `notBefore`/`expiresOn`.

## 2. Crypto pipeline (reuse what Hardhat ships)
Hardhat core: `micro-eth-signer ^0.19.0` (→ `@noble/curves` 2.2.0, `@noble/hashes` 2.2.0), `ethereum-cryptography ^3`; hardhat-ledger: `micro-eth-signer ^0.14`. Hardhat min Node 22.13.0.
1. Public key: AWS `crypto.createPublicKey({key: der, format:'der', type:'spki'})`, GCP PEM likewise; assert `asymmetricKeyDetails.namedCurve === 'secp256k1'`; export JWK; left-pad x,y to 32 → `04‖x‖y`. Azure: check kty/crv, left-pad. Never slice "last 65 bytes".
2. Address: `addr.fromPublicKey(pub65)` or `keccak_256(pub[1:])[12:]`.
3. Parse: `secp256k1.Signature.fromBytes(der,'der')` (AWS/GCP), `'compact'` (Azure). Noble's DER parser is strict.
4. Low-S: `if sig.hasHighS() s = n − s` (micro-eth-signer `recoverSender` throws on high-S).
5. Parity: try rec 0/1 with `recoverPublicKey(digest)`, compare to cached pubkey; ERROR if neither (never default to 1/28).
6. Encoding: typed txs `yParity`; legacy `v` derived by micro-eth-signer (EIP-155); messages `r‖s‖(27+yParity)`.
7. Hashes: `eip191Signer._getHash(msg)`, `authorization._getHash({chainId,address,nonce})`; EIP-712 digest not exported by micro-eth-signer 0.19/0.20 → choose 0.14's `typed-data` encoder (like ledger) or viem/ox `hashTypedData`, with test vectors.
8. Self-check: re-verify each signature against the cached address.

## 3. Existing JS implementations — concrete bugs
| Package | Findings |
|---|---|
| `evm-kms-signer` 2.0.4 (viem; AWS+GCP) | `signMessage({raw})` does `raw.toString()` (wrong bytes); ignores custom serializer; no 7702; SPKI sliced (no curve check); GCP CRC ignored when `verifiedDigestCrc32c` false; `response.name` unchecked; `@google-cloud/kms ^5`. Good: cached pubkey, strict recovery. |
| `@rumblefishdev/eth-signer-kms` 4.3.1 (ethers v6, AWS) | Two DER parsers (hand-rolled one ignores length byte); `authorize()` ignores request chainId (chainId 0 impossible); no curve check. Good: low-S, strict recovery. |
| `@rumblefishdev/hardhat-kms-signer` 2.0.0 | Hardhat 2 only; only `eth_sendTransaction`; drops `accessList`; no 2930/7702; `tx.from` unchecked; resolves sender (KMS call) on every RPC; no region config; replaces the HTTP provider. |
| `ethers-gcp-kms-signer` 1.1.6 | New gRPC client per sign/getPublicKey, never closed; no CRC32C; `determineCorrectV` returns 28 unverified; `dotenv.config()` on import; ethers v5. |
| `@cuonghx.gu-tech/ethers-gcp-kms-signer` 0.9.1 | Unverified 27/28 fallback; no CRC32C. |
| `viem-kms-signer` 1.0.1 (AWS) | New client per call; keyId inside client config; unverified 27/28 fallback; `console.log` of responses; no effective caching. |
Common gaps: no timeouts/retry policy, no key-version pinning, no key-spec validation, no GCP integrity checks, unverified parity fallback.

## 4. Testing options
- AWS: LocalStack supports `ECC_SECG_P256K1` + `DIGEST` (pyca cryptography → DER, ~50% high-S → good normalization test); deterministic keys via `_custom_key_material_` tag. Since 2026.3.0 the image needs `LOCALSTACK_AUTH_TOKEN` (free Hobby tier); pin `localstack/localstack:4.14.0` for tokenless CI (untested inference). moto 5.2.3 does NOT implement DIGEST (unusable).
- GCP: no official emulator. Azure: no official emulator; community Lowkey Vault claims P-256K/ES256K (untested).
- Primary: inject fake SDK clients that sign with a local noble key and return real wire formats (AWS SPKI DER + DER sig; GCP PEM + DER + correct CRC32C; Azure JWK with stripped leading zeros + 64-byte r‖s), force high-S and wrong-key cases.

## 5. Minimal permissions
- AWS: `kms:GetPublicKey`, `kms:Sign` on the key ARN (optionally conditions `kms:SigningAlgorithm = ECDSA_SHA_256`, `kms:MessageType = DIGEST` — verify).
- GCP: `roles/cloudkms.signerVerifier` (or `roles/cloudkms.signer` + `roles/cloudkms.publicKeyViewer`) at key level.
- Azure vault: RBAC "Key Vault Crypto User" or access policy keys `get` + `sign`. Managed HSM: local RBAC "Managed HSM Crypto User" (verify).

## 6. Quotas, retries, timeouts
- AWS: ECC crypto ops share 1,000 rps per account/region; `GetPublicKey` 2,000 rps; `ThrottlingException`; SDK retry "standard", maxAttempts 3; timeouts via `requestHandler: {requestTimeout, connectionTimeout}`.
- GCP: `crypto_requests` 60,000 QPM; `read_requests` 300 QPM (GetPublicKey → cache!); `hsm_asymmetric_requests` 50 QPS/region; pass `{timeout, retry}`; limited retries on CRC mismatch.
- Azure vault: SECP256K1 2,000 (HSM) / 4,000 (software) tx per 10 s per vault; 429 + Retry-After honoured by core-rest-pipeline. Managed HSM 330 sign/s per partition.
- Retry only transport/throttling/integrity errors; never retry after broadcast.

## Recommended adapter interface
```ts
interface KmsSignerAdapter {
  readonly id: string;                         // pinned identifier (ARN / version name / versioned kid)
  getPublicKey(): Promise<Uint8Array>;         // 65-byte 0x04||x||y, curve-validated, called once
  signDigest(digest: Uint8Array, opts?: { signal?: AbortSignal }): Promise<{ r: bigint; s: bigint }>;
  close?(): Promise<void>;
}
```
Core: memoized pubkey/address, low-S, trial recovery, self-verify, 191/712/7702/tx hashing, tx assembly, from/chainId checks, timeouts, error wrapping. Adapters: SDK construction, credential chain, version pinning, wire decoding, CRC32C. SDKs lazily imported as optional peers.

Sources: AWS KMS quotas, GCP KMS quotas/algorithms/roles, Azure Key Vault service limits, Managed HSM scaling guidance, Lowkey Vault, LocalStack 2026.03 release notes.
