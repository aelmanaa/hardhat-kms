# Provider contract

Audience: Contributors adding or changing a KMS or HSM provider.

Status: M1 implements `KmsKeyAdapter` and `SignContext` in `packages/hardhat-kms/src/internal/signer/types.ts`, without `signTransaction` and `sendTransaction`. M2 adds the built-in providers' descriptors and the registry as internal code (see [Built-in descriptors](#built-in-descriptors)), and the `kms` hook with the adapter contract exported from `hardhat-kms/types` (see [Adding a provider from another plugin](#adding-a-provider-from-another-plugin)). M3 adds `hardhat-kms-aws`, the first provider package (see [First-party provider packages](#first-party-provider-packages)), and M6 adds `hardhat-kms-gcp` and `hardhat-kms-azure`. The code below is the planned full contract; the types exported today are in `packages/hardhat-kms/src/types.ts`. Transactions (M5) go through the adapter's `signDigest`. The exported types therefore have no `signTransaction` or `sendTransaction` yet; those arrive with the providers that need them, Turnkey ([#54](https://github.com/aelmanaa/hardhat-kms/issues/54)) and Fireblocks ([#55](https://github.com/aelmanaa/hardhat-kms/issues/55)).

## Provider contract

The contract is exported from `hardhat-kms/types`. It is frozen before 1.0 so that Turnkey and Fireblocks adapters can be added later without breaking changes. A provider is a plugin whose `kms` hook handler returns a key adapter for each of its keys:

<!-- docs-check: skip -->

```ts
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
```

The core enforces these rules on adapters:

- An adapter implements at least one of `getPublicKey` and `getAddress`, and at least one signing method.
- The core prefers the structured methods (`signMessage`, `signTypedData`, `signTransaction`) and falls back to `signDigest`. Structured methods exist so that providers with a policy engine see the full request, not only a digest. Whichever method signs, the core verifies the recovered signer against the account address.
- An adapter without `getPublicKey` (a Turnkey-style API signer) requires an `address` pin in config. Trial recovery then compares against the pinned address instead of a public key.
- A missing capability produces a "provider X cannot do Y" error.
- An adapter with `sendTransaction` broadcasts on its own. For those adapters the core skips the nonce high-water mark, rejects `eth_signTransaction` and EDR or fork networks with clear errors, passes the idempotency key (Fireblocks' `externalTxId`), and checks `from` against the receipt.

Built-in providers' keys are validated inside the root zod schema with `conditionalUnionType` on `provider`. For any other `provider` id, the root schema checks only the fields every key shares. Provider packages, third-party providers and tests plug in through the plugin-owned `kms` hook category with `createKeyAdapter(context, key, next)` (see [Adding a provider from another plugin](#adding-a-provider-from-another-plugin)). Tests register fakes with `hre.hooks.registerHandlers("kms", …)`; the package ships no public fake provider.

## Built-in descriptors

Each built-in provider has a descriptor in `packages/hardhat-kms/src/internal/providers/<id>/descriptor.ts`, registered under its `id` in `packages/hardhat-kms/src/internal/providers/registry.ts`. The internal shape, in `packages/hardhat-kms/src/internal/providers/types.ts`, differs from the public contract above:

| Field     | Meaning                                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | The value of `provider` in a key's config.                                                                                                                                                                                                                                     |
| `schema`  | The zod schema for a key's config, with the provider's format checks.                                                                                                                                                                                                          |
| `resolve` | Turns a validated key config into its resolved form, including `displayId`.                                                                                                                                                                                                    |
| `name`    | The provider's name in messages, for example `AWS KMS`.                                                                                                                                                                                                                        |
| `adapter` | Where the adapter comes from: `{ package: "hardhat-kms-aws" }` for AWS, `{ package: "hardhat-kms-gcp" }` for Google Cloud and `{ package: "hardhat-kms-azure" }` for Azure. A provider without a package yet names the issue that tracks it instead, as `{ issue: <number> }`. |

The config hook imports every descriptor through the registry, so a descriptor must never import an SDK. It imports its provider's config module and a few SDK-free helpers. A descriptor builds no adapter: the core reads `name` and `adapter` only to explain a key that no `kms` handler claims.

## Adding a provider from another plugin

A third-party provider ships as its own Hardhat plugin. It adds its key types and handles its keys in the `kms` hook:

```ts
import type { HardhatPlugin } from "hardhat/types/plugins";
import type {
  ExternalKmsKeyConfig,
  KmsHooks,
  KmsKeyAdapter,
  KmsKeyCommonUserConfig,
} from "hardhat-kms/types";

declare module "hardhat-kms/types" {
  interface KmsProviderUserConfigs {
    myvault: { provider: "myvault"; keyPath: string } & KmsKeyCommonUserConfig;
  }
  interface KmsProviderConfigs {
    myvault: ExternalKmsKeyConfig<"myvault">;
  }
}

// The plugin's own code: validates key.userConfig and returns an adapter.
declare function createMyVaultAdapter(key: ExternalKmsKeyConfig<"myvault">): Promise<KmsKeyAdapter>;

const plugin: HardhatPlugin = {
  id: "hardhat-kms-myvault",
  // Loads hardhat-kms, so its config section and the kms hook exist when only this plugin is listed.
  dependencies: () => [import("hardhat-kms")],
  hookHandlers: {
    kms: async () => ({
      default: async (): Promise<Partial<KmsHooks>> => ({
        createKeyAdapter: async (context, key, next) =>
          key.provider === "myvault" ? await createMyVaultAdapter(key) : await next(context, key),
      }),
    }),
  },
};

export default plugin;
```

The rules:

- The handler builds adapters only for its own provider ids and passes every other key to `next`.
- Declare `hardhat-kms` in the plugin's `dependencies`, as above, and as a `peerDependency` in its `package.json`, so the project has a single copy of it.
- The provider id must not look like a misspelled built-in id. The config schema rejects an id that matches `aws`, `gcp` or `azure` in another case or is one edit away from one (a changed, added or removed letter, or two adjacent letters swapped), such as `AWS`, `gpc` or `azurre`. Ids such as `kms` or `hsm` are fine.
- Augment `KmsProviderConfigs` as above. Without it, `key.provider === "myvault"` does not compile, because resolved keys are typed as the registered providers only.
- The plugin validates only `provider`, `address`, `timeoutMs` and `approvalTimeoutMs`. The handler validates the rest of `userConfig`, which holds every field of the user's key. Configuration variables in it arrive as `ResolvedConfigurationVariable` objects; call `get()` to read one.
- The core builds no adapter itself, so a key that no handler claims fails. For an `aws`, `gcp` or `azure` key the error names the provider package and the command that installs it. For any other id it says that no plugin provides the provider. With `DEBUG=hardhat:kms:providers`, the core logs `<displayId>: no plugin claimed the key` first.
- The plugin checks every returned adapter: it must have `describe()` returning non-empty `provider`, `pinnedId` and `displayId`, a signing method (`signDigest`, `signMessage` or `signTypedData`), and either `getPublicKey`, `getAddress` or an `address` pin on the key. Any of these methods that is set must be a function. `describe()` is called once, when the adapter is created. Its signatures then go through the same [signing pipeline](signing-pipeline.md) as those of the first-party providers.
- Handlers registered at run time with `hre.hooks.registerHandlers("kms", …)` run before plugin handlers, the most recently registered first. Tests use this to replace a provider with a fake.
- Nothing stops two plugins from claiming the same id, or a plugin from claiming `aws`, `gcp` or `azure`: the handler that runs first wins, silently. Plugin handlers run in reverse order of the resolved plugin list.
- A handler must return an adapter or the result of `next`. Returning nothing fails with an error that names the `kms.createKeyAdapter` handler.

The chain runs in `packages/hardhat-kms/src/internal/providers/create-adapter.ts`. The hook and adapter types are marked `@experimental` until 1.0; the Turnkey and Fireblocks providers ([#54](https://github.com/aelmanaa/hardhat-kms/issues/54), [#55](https://github.com/aelmanaa/hardhat-kms/issues/55)) add optional transaction methods.

## First-party provider packages

`hardhat-kms-aws` and `hardhat-kms-gcp` are provider plugins like the one above, kept in this repository and released with the core. They differ from a third-party plugin in these ways:

- Its key format lives in the core, as a [built-in descriptor](#built-in-descriptors). The config schema checks `aws`, `gcp` and `azure` keys strictly, and a missing package produces an error that names it. The package declares no key types. Its `src/index.ts` starts with `/// <reference types="hardhat-kms/types" preserve="true" />`, so a project that imports only one provider package still gets the `kms` config types. A reference adds nothing to the JavaScript: if `hardhat-kms` is missing, Hardhat reports it as a missing plugin dependency instead of Node failing to find the module.
- It builds on `hardhat-kms/provider-utils`: `publicKeyFromSpkiDer`, `publicKeyFromSpkiPem` (Google Cloud's PEM) and `InvalidPublicKeyError` to parse the key's public key, `crc32c` for Google Cloud's checksums, `kmsError` and its `ErrorDetails` for allow-listed errors, `catalogError`, `catalogMessage` and `internalError` with the `ErrorEntry` and `TemplateParams` types to build its errors from its [error catalogue](architecture.md#errors), `parseAwsKeyId` and its `ParsedAwsKeyId` to read the kind of an AWS key id and the region of an ARN, `publicKeyFromJwk` and `parseAzureKeyId` for Azure's JWK public keys and key URLs, and `checkProviderVersion`, which its handler calls before building an adapter. The entry point is marked `@experimental` until 1.0. Third-party providers may use it too, except `checkProviderVersion` and the catalogue helpers, which only fit packages released with the core: a third-party provider builds its errors with `kmsError`.
- It requires the same version of `hardhat-kms`. Its peer dependency on `hardhat-kms` is exact (`workspace:*` becomes the version itself when packed), so npm refuses a mismatched install. pnpm and Yarn only warn, so `checkProviderVersion` also fails at the first key with both versions and the install command.
- It depends on its SDK and imports it in its `kms` handler on first use (see [SDK loading](architecture.md#sdk-loading)).

To add another first-party provider package:

1. Create `packages/hardhat-kms-<id>` with the layout of `packages/hardhat-kms-aws` (see [Module layout](architecture.md#module-layout)). The plugin declares `dependencies: () => [import("hardhat-kms")]` and a `kms` hook handler. The handler claims the provider's keys, passes other keys to `next`, calls `checkProviderVersion` with the package's own name and version, and loads the adapter and the SDK with dynamic `import()`. The adapter takes the SDK as an argument, so unit tests can pass a fake.
2. In its `package.json`, put the SDK in `dependencies` as a caret range on a tested version (`^x.y.z`), `hardhat` in `peerDependencies`, and `hardhat-kms` in `peerDependencies` as `workspace:*`. `pnpm run test:sdk-floors` tests every dependency under `@aws-sdk/`, `@google-cloud/` or `@azure/` at its floor and rejects other range forms. An SDK in another scope goes into `CLOUD_SDK` in `scripts/test-sdk-floors.ts` and into the Dependabot `cloud-sdks` group, as `google-gax` does.
3. In the core, set the descriptor's `adapter` to `{ package: "hardhat-kms-<id>" }`.
4. Move any helper the adapter needs from the core to `packages/hardhat-kms/src/provider-utils.ts`, and update the export list checked by `packages/hardhat-kms/test/unit/plugin.test.ts`.
5. Register the package with the tooling: the `fixed` group in `.changeset/config.json`, a workspace entry in `knip.json`, a reference in the root `tsconfig.json`, a root devDependency so doc snippets can import it, and the package list in `scripts/consumer-typecheck.ts`.
6. Test it as `hardhat-kms-aws` is tested: adapter unit tests with a fake SDK, an integration test with the real SDK against a local endpoint, and an import test that loads a config without loading the SDK (see [Testing](testing.md)). The package's `.c8rc.json` holds it to 95% coverage.
