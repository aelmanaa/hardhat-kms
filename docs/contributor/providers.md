# Provider contract

Audience: Contributors adding or changing a KMS or HSM provider.

Status: the adapter contract is in `packages/hardhat-kms/src/internal/signer/types.ts`, and `hardhat-kms/types` exports it (see [Adding a provider from another plugin](#adding-a-provider-from-another-plugin)). The built-in providers' descriptors and the registry are internal code (see [Built-in descriptors](#built-in-descriptors)). `hardhat-kms-aws`, `hardhat-kms-gcp` and `hardhat-kms-azure` are the first-party provider packages (see [First-party provider packages](#first-party-provider-packages)). Transactions are signed through the adapter's `signDigest`. `signTransaction` and `sendTransaction` are planned and arrive with the providers that need them, Turnkey ([#54](https://github.com/aelmanaa/hardhat-kms/issues/54)) and Fireblocks ([#55](https://github.com/aelmanaa/hardhat-kms/issues/55)).

## Provider contract

The contract is exported from `hardhat-kms/types`. It is marked `@experimental` and is frozen at 1.0, so that the Turnkey and Fireblocks adapters can add their methods before then. A provider is a plugin whose `kms` hook handler returns a key adapter for each of its keys. This is the contract as exported today:

```ts
import type { TypedData } from "hardhat-kms/types";

interface SignContext {
  signal: AbortSignal;
  displayMessage(message: string): Promise<void>;
  requestId: string;
  idempotencyKey?: string | undefined; // declared for transaction sends; the core does not set it yet
  chainId?: bigint | undefined; // declared; the core does not set it yet
}
interface KeyDescription {
  provider: string;
  pinnedId: string;
  displayId: string;
}
interface KmsKeyAdapter {
  describe(): KeyDescription;
  getPublicKey?(ctx: SignContext): Promise<Uint8Array>;
  getAddress?(ctx: SignContext): Promise<string>; // API/vault signers without a public-key call
  signDigest?(request: { digest: Uint8Array }, ctx: SignContext): Promise<SignatureOutput>;
  signMessage?(
    request: { message: Uint8Array; digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput>;
  signTypedData?(
    request: { typedData: TypedData; digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput>;
  close?(): Promise<void>;
}
type SignatureOutput =
  | { format: "der" | "compact"; bytes: Uint8Array }
  | { r: bigint; s: bigint; yParity?: 0 | 1 | undefined }; // the core ignores yParity and derives it
```

Two methods are planned and not yet in the exported types. They arrive with Turnkey ([#54](https://github.com/aelmanaa/hardhat-kms/issues/54)) and Fireblocks ([#55](https://github.com/aelmanaa/hardhat-kms/issues/55)):

<!-- docs-check: skip -->

```ts
// Planned, not exported yet.
interface KmsKeyAdapter {
  signTransaction?(
    request: { unsigned: Uint8Array; digest: Uint8Array; tx: FilledTx },
    ctx: SignContext,
  ): Promise<SignatureOutput>;
  sendTransaction?(request: { tx: FilledTx }, ctx: SignContext): Promise<{ hash: Hex }>; // remote broadcaster (Fireblocks)
}
```

The core calls the adapter as follows (`packages/hardhat-kms/src/internal/signer/kms-signer.ts`):

| Request                                                                                            | Adapter method                                                   |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `personal_sign`, `eth_sign`, `kms sign`                                                            | `signMessage` if present, otherwise `signDigest`                 |
| `eth_signTypedData_v4`, `kms sign --data`                                                          | `signTypedData` if present, otherwise `signDigest`               |
| `eth_sendTransaction`, `eth_signTransaction`, `kms sign-tx`, `kms sign-auth`, `kms sign --no-hash` | `signDigest`                                                     |
| The key's address, on first use                                                                    | `getPublicKey`; without it, the `address` pin, then `getAddress` |
| `kms address`, `kms accounts`, `kms verify --key`                                                  | as above, but `getAddress` is called even when the key has a pin |

The core enforces these rules on adapters:

- When the core builds an adapter, it checks for `describe()`, at least one signing method (`signDigest`, `signMessage` or `signTypedData`), and `getPublicKey` or `getAddress` unless the key has an `address` pin.
- `signMessage` and `signTypedData` exist so that providers with a policy engine see the full request, not only a digest. The core uses them when present and falls back to `signDigest`. Transactions and EIP-7702 authorizations always go through `signDigest` until `signTransaction` arrives. Whichever method signs, the core verifies the recovered signer against the account address.
- A request with no method to serve it fails with `core.signer.cannot-sign` ("the provider cannot sign a {kind}"). For example, an adapter with only `signMessage` cannot sign a transaction.
- The core calls `getPublicKey` once per key and caches the result; a failed call is retried on the next request. It checks the key against the `address` pin before the first signature.
- An adapter without `getPublicKey` (a Turnkey-style API signer) is identified by the `address` pin, or by `getAddress` when the key has no pin. The core recovers the public key from the first signature and checks that it matches that address.
- Adapters receive copies of the digest, message and typed data, which they may change. The core copies the public key an adapter returns, so an adapter may also reuse or change that array later.
- Each call gets `requestId` and a `signal` that aborts when the key's `timeoutMs` runs out. An invalid signature gets one retry with a fresh call before the core fails.

Planned with `sendTransaction` ([#55](https://github.com/aelmanaa/hardhat-kms/issues/55)): an adapter with `sendTransaction` broadcasts on its own. For those adapters the core will skip the nonce high-water mark, reject `eth_signTransaction` and EDR or fork networks with clear errors, pass the idempotency key (Fireblocks' `externalTxId`), and check `from` against the receipt.

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
- The plugin checks every returned adapter: it must have `describe()` returning non-empty `provider`, `pinnedId` and `displayId`, a signing method (`signDigest`, `signMessage` or `signTypedData`), and either `getPublicKey`, `getAddress` or an `address` pin on the key. Any of these methods that is set must be a function. The core calls `describe()` only while it sets up the adapter, twice: once in this check and once when it builds the signer. It keeps the result and never calls `describe()` while signing or reporting an error. Its signatures then go through the same [signing pipeline](signing-pipeline.md) as those of the first-party providers.
- Handlers registered at run time with `hre.hooks.registerHandlers("kms", …)` run before plugin handlers, the most recently registered first. Tests use this to replace a provider with a fake.
- Nothing stops two plugins from claiming the same id, or a plugin from claiming `aws`, `gcp` or `azure`: the handler that runs first wins, silently. Plugin handlers run in reverse order of the resolved plugin list.
- A handler must return an adapter or the result of `next`. Returning nothing fails with an error that names the `kms.createKeyAdapter` handler.

The chain runs in `packages/hardhat-kms/src/internal/providers/create-adapter.ts`. The hook and adapter types are marked `@experimental` until 1.0; the Turnkey and Fireblocks providers ([#54](https://github.com/aelmanaa/hardhat-kms/issues/54), [#55](https://github.com/aelmanaa/hardhat-kms/issues/55)) will add the planned `signTransaction` and `sendTransaction` methods.

## First-party provider packages

`hardhat-kms-aws`, `hardhat-kms-gcp` and `hardhat-kms-azure` are provider plugins like the one above, kept in this repository and released with the core. They differ from a third-party plugin in these ways:

- Its key format lives in the core, as a [built-in descriptor](#built-in-descriptors). The config schema checks `aws`, `gcp` and `azure` keys strictly, and a missing package produces an error that names it. The package declares no key types. Its `src/index.ts` starts with `/// <reference types="hardhat-kms/types" preserve="true" />`, so a project that imports only one provider package still gets the `kms` config types. A reference adds nothing to the JavaScript: if `hardhat-kms` is missing, Hardhat reports it as a missing plugin dependency instead of Node failing to find the module.
- It builds on `hardhat-kms/provider-utils`: `publicKeyFromSpkiDer`, `publicKeyFromSpkiPem` (Google Cloud's PEM) and `InvalidPublicKeyError` to parse the key's public key, `crc32c` for Google Cloud's checksums, `kmsError` and its `ErrorDetails` for allow-listed errors, `catalogError`, `catalogMessage` and `internalError` with the `ErrorEntry` and `TemplateParams` types to build its errors from its [error catalogue](architecture.md#errors), `parseAwsKeyId` and its `ParsedAwsKeyId` to read the kind of an AWS key id and the region of an ARN, `publicKeyFromJwk` with its `EcJsonWebKey` type and `parseAzureKeyId` with its `ParsedAzureKeyId` for Azure's JWK public keys and key URLs, and `checkProviderVersion`, which its handler calls before building an adapter. The entry point is marked `@experimental` until 1.0. Third-party providers may use it too, except `checkProviderVersion` and the catalogue helpers, which only fit packages released with the core: a third-party provider builds its errors with `kmsError`.
- It requires the same version of `hardhat-kms`. Its peer dependency on `hardhat-kms` is exact (`workspace:*` becomes the version itself when packed), so npm refuses a mismatched install. pnpm and Yarn only warn, so `checkProviderVersion` also fails at the first key with both versions and the install command.
- It depends on its SDK and imports it in its `kms` handler on first use (see [SDK loading](architecture.md#sdk-loading)).

To add another first-party provider package:

1. Create `packages/hardhat-kms-<id>` with the layout of `packages/hardhat-kms-aws` (see [Module layout](architecture.md#module-layout)). The plugin declares `dependencies: () => [import("hardhat-kms")]` and a `kms` hook handler. The handler claims the provider's keys, passes other keys to `next`, calls `checkProviderVersion` with the package's own name and version, and loads the adapter and the SDK with dynamic `import()`. The adapter takes the SDK as an argument, so unit tests can pass a fake.
2. In its `package.json`, put the SDK in `dependencies` as a caret range on a tested version (`^x.y.z`), `hardhat` in `peerDependencies`, and `hardhat-kms` in `peerDependencies` as `workspace:*`. `pnpm run test:sdk-floors` tests every dependency under `@aws-sdk/`, `@google-cloud/` or `@azure/` at its floor and rejects other range forms. An SDK in another scope goes into `CLOUD_SDK` in `scripts/test-sdk-floors.ts` and into the Dependabot `cloud-sdks` group, as `google-gax` does.
3. In the core, set the descriptor's `adapter` to `{ package: "hardhat-kms-<id>" }`.
4. Move any helper the adapter needs from the core to `packages/hardhat-kms/src/provider-utils.ts`, and update the export list checked by `packages/hardhat-kms/test/unit/plugin.test.ts`.
5. Give the package its error catalogue, `src/internal/error-catalog.ts`, with ids under the provider id, and a test that checks it, as `packages/hardhat-kms-aws` has. Build every error from it (see [Errors](architecture.md#errors)), then run `pnpm run docs:errors`.
6. Register the package with the tooling: the `fixed` group in `.changeset/config.json`, a workspace entry in `knip.json`, a reference in the root `tsconfig.json`, a root devDependency so doc snippets can import it, and the package list in `scripts/consumer-typecheck.ts`.
7. Test it as `hardhat-kms-aws` is tested: adapter unit tests with a fake SDK, an integration test with the real SDK against a local endpoint, and an import test that loads a config without loading the SDK (see [Testing](testing.md)). The package's `.c8rc.json` holds it to 95% coverage.
