import type { TokenCredential } from "@azure/identity";
import type {
  CryptographyClientOptions,
  KeyClientOptions,
  KeyVaultKey,
} from "@azure/keyvault-keys";
import {
  catalogError,
  type ErrorEntry,
  type ParsedAzureKeyId,
  parseAzureKeyId,
  publicKeyFromJwk,
  type TemplateParams,
} from "hardhat-kms/provider-utils";
import type {
  AzureKmsKeyConfig,
  KmsKeyAdapter,
  SignatureOutput,
  SignContext,
} from "hardhat-kms/types";

import { ERRORS } from "./error-catalog.ts";

/** Key Vault's name for ECDSA over secp256k1 on a pre-hashed 32-byte digest. */
const ALGORITHM = "ES256K";
const KEY_TYPES: ReadonlySet<string> = new Set(["EC", "EC-HSM"]);
const CURVE = "P-256K";
const SIGN_OPERATION = "sign";

/** The fields of a Key Vault key the adapter reads. @azure/keyvault-keys' `KeyVaultKey` has them. */
export interface KeyVaultKeyLike {
  /** The versioned key identifier, from the service's `kid`. */
  id?: string | undefined;
  key?:
    | {
        kty?: string | undefined;
        crv?: string | undefined;
        x?: Uint8Array | undefined;
        y?: Uint8Array | undefined;
      }
    | undefined;
  keyOperations?: string[] | undefined;
  properties: {
    enabled?: boolean | undefined;
    notBefore?: Date | undefined;
    expiresOn?: Date | undefined;
  };
}

/** What the adapter passes to `CryptographyClient.sign`. */
export interface SignCallOptions {
  abortSignal: AbortSignal;
  /** Receives the raw response, whose body carries the `kid` of the key version that signed. */
  onResponse: (response: { status: number; parsedBody?: unknown }) => void;
}

/** The parts of @azure/keyvault-keys the adapter uses; tests pass a fake with the same shape. */
export interface AzureKeyVaultSdk<Key extends KeyVaultKeyLike = KeyVaultKey> {
  KeyClient: new (
    vaultUrl: string,
    credential: TokenCredential,
    options?: KeyClientOptions,
  ) => {
    getKey(name: string, options?: { version?: string; abortSignal?: AbortSignal }): Promise<Key>;
  };
  CryptographyClient: new (
    key: Key,
    credential: TokenCredential,
    options?: CryptographyClientOptions,
  ) => {
    sign(
      algorithm: typeof ALGORITHM,
      digest: Uint8Array,
      options: SignCallOptions,
    ): Promise<{ result?: Uint8Array | undefined }>;
  };
}

/** Client settings shared by both Key Vault clients; tests pass an `httpClient`. */
export type AzureClientOptions = Pick<KeyClientOptions, "httpClient">;

/** What the adapter passes to both Key Vault clients. */
type ClientOptions = Pick<KeyClientOptions, "httpClient" | "userAgentOptions">;

type CryptographyClient<Key extends KeyVaultKeyLike> = InstanceType<
  AzureKeyVaultSdk<Key>["CryptographyClient"]
>;

/** Error names of @azure/identity when no credential returned a token. */
const NO_CREDENTIAL = new Set(["CredentialUnavailableError", "AggregateAuthenticationError"]);
/** Error names of @azure/identity when a configured credential source could not sign in. */
const FAILED_CREDENTIAL = new Set(["AuthenticationError", "AuthenticationRequiredError"]);
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** A short value from a response, or a placeholder when it is missing or looks unusual. */
function shown(value: unknown): string {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : "missing";
}

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const KEYS_PATH = "/keys/";

/** Whether a part of a key id's display form was printed as written, not as `<VARIABLE_NAME>`. */
const shownAsWritten = (part: string | undefined): boolean =>
  part !== undefined && !part.startsWith("<");

/**
 * The `az keyvault key set-attributes` arguments that name one key version, for the hints of the
 * key checks. Without `--version` the command changes the latest version, which may not be the
 * one the config signs with. A part read from a configuration variable is shown as a placeholder:
 * its display form is `<VARIABLE_NAME>`, and a key id read whole from one has no `/keys/` in it.
 */
function setAttributesTarget(
  id: ParsedAzureKeyId,
  display: string,
  version: string,
): { vaultOption: string; vaultName: string; keyName: string; keyVersion: string } {
  const host = new URL(id.vaultUrl).hostname;
  const hsm = host.toLowerCase().includes(".managedhsm.");
  const at = display.indexOf(KEYS_PATH);
  if (at === -1) {
    return {
      vaultOption: hsm ? "--hsm-name" : "--vault-name",
      vaultName: hsm ? "<hsm-name>" : "<vault-name>",
      keyName: "<key-name>",
      keyVersion: "<version>",
    };
  }
  const [nameShown, versionShown] = display.slice(at + KEYS_PATH.length).split("/");
  return {
    vaultOption: hsm ? "--hsm-name" : "--vault-name",
    vaultName: shownAsWritten(display.slice(0, at))
      ? host.slice(0, host.indexOf("."))
      : hsm
        ? "<hsm-name>"
        : "<vault-name>",
    keyName: shownAsWritten(nameShown) ? id.keyName : "<key-name>",
    // An unversioned key id shows the version Key Vault returned, which the adapter pins.
    keyVersion: versionShown === undefined || shownAsWritten(versionShown) ? version : "<version>",
  };
}

/**
 * The Azure Key Vault (and Managed HSM) adapter for one key.
 *
 * It reads the key's JWK once, checks that it is an enabled secp256k1 key that may sign, and pins
 * the key version from the response: an unversioned key id is resolved to the current version
 * once, and every signature uses that version. Each sign response must name the pinned version
 * in its `kid`, as Foundry's Azure signer checks. Key Vault signs the 32-byte digest as given with
 * `ES256K` and returns `r || s`; the core normalizes S, recovers the parity and verifies it.
 */
class AzureKeyAdapter<Key extends KeyVaultKeyLike> implements KmsKeyAdapter {
  readonly #key: AzureKmsKeyConfig;
  readonly #id: ParsedAzureKeyId;
  readonly #sdk: AzureKeyVaultSdk<Key>;
  readonly #credential: TokenCredential;
  readonly #options: ClientOptions;
  readonly #keys: InstanceType<AzureKeyVaultSdk<Key>["KeyClient"]>;
  #pinned: { version: string; key: Key; client: CryptographyClient<Key> } | undefined;

  public constructor(
    key: AzureKmsKeyConfig,
    id: ParsedAzureKeyId,
    sdk: AzureKeyVaultSdk<Key>,
    credential: TokenCredential,
    options: ClientOptions,
  ) {
    this.#key = key;
    this.#id = id;
    this.#sdk = sdk;
    this.#credential = credential;
    this.#options = options;
    this.#keys = new sdk.KeyClient(id.vaultUrl, credential, options);
  }

  public describe(): { provider: string; pinnedId: string; displayId: string } {
    return { provider: "azure", pinnedId: this.#key.keyId.display, displayId: this.#key.displayId };
  }

  public async getPublicKey(ctx: SignContext): Promise<Uint8Array> {
    // Once a version is pinned, a later lookup reads that version, never the current one.
    const wanted = this.#id.keyVersion ?? this.#pinned?.version;
    const response = await this.#send(
      "get public key",
      async () =>
        await this.#keys.getKey(this.#id.keyName, {
          ...(wanted === undefined ? {} : { version: wanted }),
          abortSignal: ctx.signal,
        }),
    );
    // The checks below do not trust the SDK's types: every field of a response is optional.
    const version = this.#versionOf(response.id, "get public key");
    if (wanted !== undefined && !sameId(version, wanted)) {
      throw this.#error("get public key", ERRORS.responseVersion, {});
    }
    this.#checkUsable(response, "get public key", version);
    const jwk = response.key;
    if (jwk === undefined) {
      throw this.#error("get public key", ERRORS.noPublicKey, {});
    }
    if (jwk.kty === undefined || !KEY_TYPES.has(jwk.kty)) {
      throw this.#error("get public key", ERRORS.keyType, { keyType: shown(jwk.kty) });
    }
    if (jwk.crv !== CURVE) {
      throw this.#error("get public key", ERRORS.keyCurve, { curve: shown(jwk.crv) });
    }
    const publicKey = publicKeyFromJwk({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
    // Pin only a validated key from a call that was not abandoned, so a late answer to a
    // timed-out call cannot choose the version.
    if (!ctx.signal.aborted && this.#pinned === undefined) {
      this.#pinned = {
        version,
        key: response,
        client: new this.#sdk.CryptographyClient(response, this.#credential, this.#options),
      };
    }
    return publicKey;
  }

  public async signDigest(
    request: { digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput> {
    if (this.#pinned === undefined) {
      // The signer always resolves the key first; this keeps the version rule if it ever does not.
      await this.getPublicKey(ctx);
    }
    const pinned = this.#pinned;
    if (pinned === undefined) {
      // The lookup above was abandoned (its signal aborted): never sign without a pinned version.
      throw this.#error("sign", ERRORS.lookupUnfinished, {});
    }
    // The SDK checks the dates of the key it was given too, but fails with a message that names
    // the key URL, which the signer can only show as "Error". A key that expired since it was
    // pinned gets the same clear error as at the lookup.
    this.#checkUsable(pinned.key, "sign", pinned.version);
    let kid: unknown;
    const response = await this.#send(
      "sign",
      async () =>
        await pinned.client.sign(ALGORITHM, request.digest, {
          abortSignal: ctx.signal,
          onResponse: ({ parsedBody }) => {
            kid =
              typeof parsedBody === "object" && parsedBody !== null
                ? Reflect.get(parsedBody, "kid")
                : undefined;
          },
        }),
    );
    // The SDK's result echoes the key id it was asked for; only the service's `kid` says which
    // version signed.
    const version = this.#versionOf(kid, "sign");
    if (!sameId(version, pinned.version)) {
      throw this.#error("sign", ERRORS.signatureVersion, {});
    }
    const signature: unknown = response.result;
    if (!(signature instanceof Uint8Array)) {
      throw this.#error("sign", ERRORS.noSignature, {});
    }
    // 64 bytes `r || s`; the core rejects any other length.
    return { format: "compact", bytes: signature };
  }

  /** Reads the key version from a response's key id, which must name this key. */
  #versionOf(id: unknown, operation: string): string {
    const parsed = typeof id === "string" ? parseAzureKeyId(id) : undefined;
    if (parsed?.keyVersion === undefined) {
      throw this.#error(operation, ERRORS.noVersionedId, {});
    }
    if (!sameId(parsed.keyName, this.#id.keyName)) {
      throw this.#error(operation, ERRORS.responseKey, {});
    }
    return parsed.keyVersion;
  }

  /** Checks the key's attributes, as Key Vault would before signing, to fail with a clear error. */
  #checkUsable(response: KeyVaultKeyLike, operation: string, version: string): void {
    const { enabled, notBefore, expiresOn } = response.properties;
    const now = Date.now();
    if (enabled === false) {
      throw this.#error(operation, ERRORS.disabled, this.#target(version));
    }
    if (notBefore instanceof Date && notBefore.getTime() > now) {
      throw this.#error(operation, ERRORS.notYetValid, { date: notBefore.toISOString() });
    }
    if (expiresOn instanceof Date && expiresOn.getTime() <= now) {
      throw this.#error(operation, ERRORS.expired, { date: expiresOn.toISOString() });
    }
    const operations: unknown = response.keyOperations;
    if (Array.isArray(operations) && !operations.includes(SIGN_OPERATION)) {
      throw this.#error(operation, ERRORS.noSignOperation, this.#target(version));
    }
  }

  #target(version: string): ReturnType<typeof setAttributesTarget> {
    return setAttributesTarget(this.#id, this.#key.keyId.display, version);
  }

  /**
   * Runs a Key Vault call and explains the errors users can act on. Azure SDK errors keep only
   * their HTTP status and service error code, never their message, which names the vault and key.
   */
  async #send<Output>(operation: string, send: () => Promise<Output>): Promise<Output> {
    try {
      return await send();
    } catch (error) {
      throw this.#explain(operation, error) ?? error;
    }
  }

  #explain(operation: string, error: unknown): Error | undefined {
    if (!(error instanceof Error)) {
      return undefined;
    }
    if (NO_CREDENTIAL.has(error.name)) {
      return this.#error(operation, ERRORS.noCredential, { errorName: error.name });
    }
    if (FAILED_CREDENTIAL.has(error.name)) {
      return this.#error(operation, ERRORS.credentialFailed, { errorName: error.name });
    }
    if (error.name !== "RestError") {
      return undefined;
    }
    const status: unknown = Reflect.get(error, "statusCode");
    const code: unknown = Reflect.get(error, "code");
    const shownCode = typeof code === "string" && SAFE_CODE.test(code) ? code : undefined;
    if (typeof status !== "number" || !Number.isInteger(status)) {
      // No HTTP answer: the request did not reach Key Vault.
      return shownCode === undefined
        ? this.#error(operation, ERRORS.unreachable, {})
        : this.#error(operation, ERRORS.unreachableCode, { code: shownCode });
    }
    // The status, then Key Vault's error code when it has a safe one, such as "403 Forbidden".
    const answer = { status: `${status}${shownCode === undefined ? "" : ` ${shownCode}`}` };
    if (status === 401) {
      return this.#error(operation, ERRORS.unauthorized, answer);
    }
    if (status === 403) {
      return this.#error(operation, ERRORS.forbidden, answer);
    }
    if (status === 404) {
      return this.#error(operation, ERRORS.notFound, answer);
    }
    return this.#error(operation, ERRORS.answered, answer);
  }

  #error<Template extends string>(
    operation: string,
    entry: ErrorEntry<Template, "error">,
    params: TemplateParams<Template>,
  ): Error {
    return catalogError(entry, params, { provider: "azure", operation, key: this.#key.displayId });
  }
}

/**
 * Builds the adapter for an Azure Key Vault or Managed HSM key. It makes no request: the key is
 * read on first use.
 *
 * @param key - The resolved key.
 * @param sdk - The @azure/keyvault-keys module.
 * @param credential - The credential for Key Vault requests.
 * @param userAgent - The plugin's user-agent tag, such as `hardhat-kms/1.0.0`.
 * @param options - Client settings for both Key Vault clients.
 * @returns The adapter.
 */
export async function createAzureKeyAdapter<Key extends KeyVaultKeyLike>(
  key: AzureKmsKeyConfig,
  sdk: AzureKeyVaultSdk<Key>,
  credential: TokenCredential,
  userAgent: string,
  options: AzureClientOptions = {},
): Promise<KmsKeyAdapter> {
  const keyId = await key.keyId.get();
  const id = parseAzureKeyId(keyId);
  if (id === undefined) {
    // resolveIdentifier already checked the format; this only keeps the types honest.
    throw catalogError(
      ERRORS.notKeyUrl,
      {},
      { provider: "azure", operation: "create adapter", key: key.displayId },
    );
  }
  // Put before the SDK's own user agent, so the Key Vault audit log's `ClientInfo` shows which
  // calls came through the plugin.
  return new AzureKeyAdapter(key, id, sdk, credential, {
    ...options,
    userAgentOptions: { userAgentPrefix: userAgent },
  });
}
