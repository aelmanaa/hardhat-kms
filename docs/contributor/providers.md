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

## History readers

`kms history` reads a key's sign events from its provider's audit log ([tasks reference](../user/reference/tasks.md#kms-history), [decision 0013](decisions/0013-history-from-cloud-logs.md)). A provider plugin adds a reader with a second, optional method of the `kms` hook, `readSignHistory`. It is `@experimental` and frozen at 1.0 with the rest of the hook. A provider without a reader still signs; only `kms history` fails for its keys, with an error that names the provider. The types are exported from `hardhat-kms/types`:

```ts
import type { HookContext } from "hardhat/types/hooks";
import type { KmsKeyConfig } from "hardhat-kms/types";

type KmsHistoryField =
  "principal" | "sourceIp" | "userAgent" | "requestId" | "keyVersion" | "digest";

interface KmsHistoryRequest {
  key: KmsKeyConfig; // the whole key: every version, even when the config pins one
  since: Date; // inclusive, on a whole second
  until: Date; // inclusive, on a whole second
  limit: number; // 1 to 1000; return at most limit + 1 events
  signal?: AbortSignal | undefined; // aborts after 120 seconds; always set by the plugin
}
interface KmsHistoryEvent {
  time: string; // an existing ISO 8601 date and time with a time zone
  operation: string; // Sign, AsymmetricSign, KeySign
  outcome: "success" | "failed";
  errorCode: string | null;
  errorMessage: string | null; // shown only with --show-ids
  principal: string | null;
  sourceIp: string | null;
  userAgent: string | null;
  requestId: string | null; // the id the provider assigned to the request
  keyVersion: string | null; // the version id alone, such as "1"
  digest: string | null; // 0x-prefixed lowercase hex
  keyResource: string | null; // shown only with --show-ids
  // Field names: a letter, then up to 63 letters, digits, _ and .
  extra?: Readonly<Record<string, string | number | boolean | null>> | undefined;
  extraIds?: Readonly<Record<string, string | null>> | undefined; // shown only with --show-ids
}
interface KmsHistoryScope {
  description: string; // no ids, such as "us-east-1"
  ids?: Readonly<Record<string, string>> | undefined; // shown only with --show-ids
}
interface KmsHistoryResult {
  source: string; // words of lowercase letters joined by -, no digits, at most 64
  notLogged: readonly KmsHistoryField[];
  events: readonly KmsHistoryEvent[]; // newest first, at most limit + 1
  truncated: boolean;
  truncatedReason?: "limit" | "scan-limit" | undefined; // required when truncated
  completeForKey: boolean;
  scope?: KmsHistoryScope | undefined;
  hiddenValues?: readonly string[] | undefined;
  setupHint?: string | undefined;
  deliveryDelayMinutes?: number | undefined;
  retentionDays?: number | undefined;
  notes?: readonly { code: string; message: string }[] | undefined;
}
interface KmsHooks {
  readSignHistory(
    context: HookContext,
    request: KmsHistoryRequest,
    next: (nextContext: HookContext, nextRequest: KmsHistoryRequest) => Promise<KmsHistoryResult>,
  ): Promise<KmsHistoryResult>;
}
```

A reader for the `myvault` provider of the example above:

```ts
import type { HardhatPlugin } from "hardhat/types/plugins";
import { auditLogAccessDenied } from "hardhat-kms/provider-utils";
import type { KmsHistoryEvent, KmsHistoryRequest, KmsHooks } from "hardhat-kms/types";

// The plugin's own code: queries the vault's audit log, passing request.signal to each call, and
// maps each entry to an event. `stopped` is true when it stopped paging before the range's end.
declare function queryMyVaultLog(
  request: KmsHistoryRequest,
): Promise<{ denied: boolean; events: KmsHistoryEvent[]; stopped: boolean }>;

const plugin: HardhatPlugin = {
  id: "hardhat-kms-myvault",
  dependencies: () => [import("hardhat-kms")],
  hookHandlers: {
    kms: async () => ({
      default: async (): Promise<Partial<KmsHooks>> => ({
        readSignHistory: async (context, request, next) => {
          const provider: string = request.key.provider;
          if (provider !== "myvault") {
            return await next(context, request);
          }
          const { denied, events, stopped } = await queryMyVaultLog(request);
          if (denied) {
            throw auditLogAccessDenied("vault:ReadAuditLog", {
              provider,
              operation: "history",
              key: request.key.displayId,
            });
          }
          return {
            source: "myvault-audit-log",
            notLogged: ["digest"],
            events,
            ...(stopped
              ? { truncated: true, truncatedReason: "scan-limit" as const }
              : { truncated: false }),
            completeForKey: false,
            setupHint: "Check that audit logging is on in the vault's settings.",
            deliveryDelayMinutes: 5,
          };
        },
      }),
    }),
  },
};

export default plugin;
```

The rules:

- The handler reads only its own provider ids and passes every other request to `next`, as `createKeyAdapter` does. Handlers registered with `hre.hooks.registerHandlers("kms", …)` run first; tests use this to register a fake reader.
- Copy each field from the log entry and invent nothing. A field the provider never records goes in `notLogged` and is `null` in every event; a field it records but left empty in this entry is `null` too. Put the rest of the entry in `extra`, and any field that names a key, an account or a credential, such as an AWS access key id, in `extraIds`. Field names in `extra`, `extraIds` and `scope.ids` start with a letter, then up to 63 letters, digits, `_` and `.`.
- `requestId` is the id the provider assigned to the request. Google Cloud logs none: its reader lists `requestId` in `notLogged` and puts the entry's `insertId` in `extra.insertId`. Its digest is logged as 64 lowercase hex characters; the reader adds `0x`.
- Read the whole key: every version, even when the config pins one. Put the version that signed in `keyVersion` as the version id alone (`1`, or the Azure version segment), never as a resource name or URL.
- Never put key ids, account ids or other identifiers in `source`, `scope.description`, `setupHint`, note messages, `extra` or the errors you throw: they are printed without `--show-ids`. `source` is not masked, so the core accepts only words of lowercase letters joined by `-`, at most 64 characters: no digits, so no account or project number fits. `auditLogAccessDenied` takes one permission or several, such as Azure's two, and `auditLogThrottled` a limit, such as `200 per 30 seconds`. Each value is at most 200 letters, digits, spaces and `. , : ; ( ) _ / * -`. A value with a URL, an ARN, an alias, a `projects/` path, an Azure host, or a run of five digits or eight hex characters is not printed: the error then says the read was refused, or throttled, and that the reader named the permission or limit in a form the plugin does not print.
- `kms history` shows `keyResource`, `errorMessage`, `extraIds` and `scope.ids` only with `--show-ids`. Without it, the core shows the key's display id instead of the key resource, keeps only the error code, and replaces each of those values found in another field, in any case and in its URL-encoded and `\/`-escaped forms:
  - with the key's display id: the key's identifier and the key resources, and the parts that name the key on their own: an AWS key id and `key/` or `alias/` segment, an Azure versionless key URL, and a Google Cloud key name without its version;
  - with `<hidden>`: everything else, so that no key reference appears where the log had something else. That is an Azure vault host, vault name and `vaults/<name>` segment, a Google Cloud key ring path, `extraIds` values, scope ids, `kms.audit.azure.workspaceId` read from a configuration variable (for Azure keys only; other keys never read it), the value of each configuration variable part of a joined key, and `hiddenValues`.

  Put any other value that must not print, such as the key ARN an alias resolved to, in `hiddenValues`. Principals are shown as logged, except that key values and hidden values are masked there too; scope ids are not. So a Google Cloud project id from a configuration variable is hidden inside a service account's email, which is accepted.

- Return the events of the range, `since` and `until` included, newest first. The bounds are whole seconds; filter the provider's answer to them yourself, since provider queries may round their bounds, and the core refuses an event outside the range. Return at most `limit + 1` events: one more than `limit` tells the core there are more, and it marks the result truncated by `limit`. When you set `truncated`, set `truncatedReason` too: `"limit"` only with at least `limit` events, and `"scan-limit"` when you stopped before reading the whole range, for example after a page budget. Respect the provider's rate limits and let its SDK retry; when it still throttles, throw `auditLogThrottled` from `hardhat-kms/provider-utils`.
- Pass `request.signal` to the log SDK's calls and stop when it aborts. The core aborts it 120 seconds after the read starts, a fixed deadline for the whole read rather than the key's `timeoutMs`, which bounds one sign request. At that time the task fails with `core.history.timed-out`, even if the reader ignores the signal.
- When the log cannot be read, throw. Never return an empty result instead. For a refused read, throw `auditLogAccessDenied` with the permission to grant. The core never rethrows your error object. For a plugin or Hardhat error, it throws a new `core.history.reader-error` whose text is your error's message, or a Hardhat error's formatted message, masked as above. Anything shaped like an ARN, an Azure vault URL, a Google Cloud resource name, a GUID or an AWS account id is masked as `<hidden>` too, so the key ARN an alias resolved to is hidden even when the key is literal. The new error has no cause, since `--show-stack-traces` would print the cause chain unmasked. Any other error is reduced to its class name, as for adapters.
- Set `completeForKey` only when every sign request on this key is visible to this read: the provider logs every sign request with no setting that turns it off, and this read's credentials and location see all of them. AWS CloudTrail event history is kept per account and Region, so the AWS reader sets it only when the caller's account equals the key ARN's account and it reads the key's Region. Even then it covers every successful sign request, not every refused one: CloudTrail logs failed calls only in some cases, and a cross-account request refused for access only in the caller's account. Otherwise an empty result gets the `logging-not-confirmed` note, followed by `setupHint`. Describe what the read covered in `scope`, with ids such as the account in `scope.ids`.
- Set `deliveryDelayMinutes` and `retentionDays` to the provider's documented figures, or leave them out. The core uses them for the `recent-events-may-be-missing` and `before-retention` notes. Add notes of your own in `notes`, with codes in lowercase words joined by `-`; the core's three codes are reserved.
- Build a log query only from identifiers checked against the provider's character set, so a configuration variable cannot inject query text. Settings a reader needs live in `context.config.kms.audit`, such as `kms.audit.azure.workspaceId`.
- Load the log SDK inside `readSignHistory`, with a dynamic `import()`, so that loading the config and running other tasks never loads it.

The core checks every result in `packages/hardhat-kms/src/internal/history/read.ts`. These fail with `core.history.reader-invalid`: a `source` that is not words of letters, more than `limit + 1` events, an event outside the range, a time that does not exist, a value for a field in `notLogged`, a `keyVersion` that is not a version id, a digest that is not 32 bytes of lowercase hex, an error on a successful event, a field name that breaks the rule above, `truncated` without `truncatedReason` or the reverse, and `"limit"` with fewer than `limit` events. The error never repeats a value or field name the reader chose. The core sorts the events newest first and cuts them to `limit`. Times are shown in UTC, to the millisecond.

## First-party provider packages

`hardhat-kms-aws`, `hardhat-kms-gcp` and `hardhat-kms-azure` are provider plugins like the one above, kept in this repository and released with the core. They differ from a third-party plugin in these ways:

- Its key format lives in the core, as a [built-in descriptor](#built-in-descriptors). The config schema checks `aws`, `gcp` and `azure` keys strictly, and a missing package produces an error that names it. The package declares no key types. Its `src/index.ts` starts with `/// <reference types="hardhat-kms/types" preserve="true" />`, so a project that imports only one provider package still gets the `kms` config types. A reference adds nothing to the JavaScript: if `hardhat-kms` is missing, Hardhat reports it as a missing plugin dependency instead of Node failing to find the module.
- It builds on `hardhat-kms/provider-utils`: `publicKeyFromSpkiDer`, `publicKeyFromSpkiPem` (Google Cloud's PEM) and `InvalidPublicKeyError` to parse the key's public key, `crc32c` for Google Cloud's checksums, `kmsError` and its `ErrorDetails` for allow-listed errors, `catalogError`, `catalogMessage` and `internalError` with the `ErrorEntry` and `TemplateParams` types to build its errors from its [error catalogue](architecture.md#errors), `parseAwsKeyId` and its `ParsedAwsKeyId` to read the kind of an AWS key id and the region of an ARN, `publicKeyFromJwk` with its `EcJsonWebKey` type and `parseAzureKeyId` with its `ParsedAzureKeyId` for Azure's JWK public keys and key URLs, `checkProviderVersion`, which its handler calls before building an adapter, and `auditLogAccessDenied` and `auditLogThrottled` for [history readers](#history-readers). The entry point is marked `@experimental` until 1.0. Third-party providers may use it too, including the history reader errors, except `checkProviderVersion` and the catalogue helpers, which only fit packages released with the core: a third-party provider builds its errors with `kmsError`.
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
