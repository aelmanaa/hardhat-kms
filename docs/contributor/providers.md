# Provider contract

Audience: Contributors adding or changing a KMS or HSM provider.

Status: M1 implements `KmsKeyAdapter` and `SignContext` in `src/internal/signer/types.ts`, without `signTransaction` and `sendTransaction`. Exporting the contract from `hardhat-kms/types`, the descriptors, the registry and the `kms` hook are planned for M2. The transaction methods come with the transaction work (M5) and the providers that need them.

## Provider contract

The contract is exported from `hardhat-kms/types`. It is frozen before 1.0 so that Turnkey and Fireblocks adapters can be added later without breaking changes. A provider is a descriptor plus a lazily loaded key adapter:

```ts
interface KmsProviderDescriptor<UserCfg, ResolvedCfg> {
  id: string; // "aws" | "gcp" | "azure" | third-party ids
  userSchema: ZodType<UserCfg>; // validated inside the root schema
  resolve(user: UserCfg, resolveVar: ResolveConfigurationVariable): ResolvedCfg; // pure
  displayId(cfg: ResolvedCfg): string; // safe to print; honours <VAR_NAME> masking
  sdk?: { packageName: string; range: string }; // checked at load time -> install instructions
  load(): Promise<{ createKey(cfg: ResolvedCfg, deps: ProviderDeps): Promise<KmsKeyAdapter> }>;
}
interface SignContext {
  signal: AbortSignal;
  displayMessage(m: string): Promise<void>;
  requestId: string;
  idempotencyKey?: string;
  chainId?: bigint;
}
interface KmsKeyAdapter {
  describe(): { provider: string; pinnedId: string; displayId: string };
  getPublicKey?(ctx: SignContext): Promise<Uint8Array>;
  getAddress?(ctx: SignContext): Promise<Address>; // API/vault signers without a public-key call
  signDigest?(req: { digest: Uint8Array }, ctx: SignContext): Promise<SignatureOutput>;
  signMessage?(
    req: { message: Uint8Array; digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput>;
  signTypedData?(
    req: { typedData: TypedData; digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput>;
  signTransaction?(
    req: { unsigned: Uint8Array; digest: Uint8Array; tx: FilledTx },
    ctx: SignContext,
  ): Promise<SignatureOutput>;
  sendTransaction?(req: { tx: FilledTx }, ctx: SignContext): Promise<{ hash: Hex }>; // remote broadcaster (Fireblocks)
  close?(): Promise<void>;
}
type SignatureOutput =
  { format: "der" | "compact"; bytes: Uint8Array } | { r: bigint; s: bigint; yParity?: 0 | 1 }; // yParity is a hint only: the core always re-derives and verifies it
interface ProviderDeps {
  displayMessage(msg: string): Promise<void>;
  debug: Debugger;
  now(): number;
}
```

The core enforces these rules on adapters:

- An adapter implements at least one of `getPublicKey` and `getAddress`, and at least one signing method.
- The core prefers the structured methods (`signMessage`, `signTypedData`, `signTransaction`) and falls back to `signDigest`. Structured methods exist so that providers with a policy engine see the full request, not only a digest. Whichever method signs, the core verifies the recovered signer against the account address.
- An adapter without `getPublicKey` (a Turnkey-style API signer) requires an `address` pin in config. Trial recovery then compares against the pinned address instead of a public key.
- A missing capability produces a "provider X cannot do Y" error.
- An adapter with `sendTransaction` broadcasts on its own. For those adapters the core skips the nonce high-water mark, rejects `eth_signTransaction` and EDR or fork networks with clear errors, passes the idempotency key (Fireblocks' `externalTxId`), and checks `from` against the receipt.

Built-in providers are validated inside the root zod schema with `conditionalUnionType` on `provider`. The root schema accepts any other `provider` id as an opaque object. At runtime, the `kms` hook handler that claims that id validates it; an id that no handler claims produces a clear error. Third-party providers and tests plug in through the plugin-owned `kms` hook category with `createKeyAdapter(ctx, accountConfig, next)`. Tests register fakes with `hre.hooks.registerHandlers("kms", …)`; the package ships no public fake provider. The `kms` hook types are marked `@experimental`.
