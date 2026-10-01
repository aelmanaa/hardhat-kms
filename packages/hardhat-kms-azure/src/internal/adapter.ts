import type { TokenCredential } from "@azure/identity";
import type {
  CryptographyClientOptions,
  KeyClientOptions,
  KeyVaultKey,
} from "@azure/keyvault-keys";
import {
  kmsError,
  type ParsedAzureKeyId,
  parseAzureKeyId,
  publicKeyFromJwk,
} from "hardhat-kms/provider-utils";
import type {
  AzureKmsKeyConfig,
  KmsKeyAdapter,
  SignatureOutput,
  SignContext,
} from "hardhat-kms/types";

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

type CryptographyClient<Key extends KeyVaultKeyLike> = InstanceType<
  AzureKeyVaultSdk<Key>["CryptographyClient"]
>;

/** Error names of @azure/identity when no credential returned a token. */
const NO_CREDENTIAL = new Set(["CredentialUnavailableError", "AggregateAuthenticationError"]);
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** A short value from a response, or a placeholder when it is missing or looks unusual. */
function shown(value: unknown): string {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : "missing";
}

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

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
  readonly #options: AzureClientOptions;
  readonly #keys: InstanceType<AzureKeyVaultSdk<Key>["KeyClient"]>;
  #pinned: { version: string; client: CryptographyClient<Key> } | undefined;

  public constructor(
    key: AzureKmsKeyConfig,
    id: ParsedAzureKeyId,
    sdk: AzureKeyVaultSdk<Key>,
    credential: TokenCredential,
    options: AzureClientOptions,
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
      throw this.#error("get public key", "the response is for another key version");
    }
    this.#checkUsable(response);
    const jwk = response.key;
    if (jwk === undefined) {
      throw this.#error("get public key", "the response has no public key");
    }
    if (jwk.kty === undefined || !KEY_TYPES.has(jwk.kty)) {
      throw this.#error(
        "get public key",
        `the key type is ${shown(jwk.kty)}, not EC or EC-HSM. Create an EC key on the ${CURVE} curve`,
      );
    }
    if (jwk.crv !== CURVE) {
      throw this.#error(
        "get public key",
        `the key curve is ${shown(jwk.crv)}, not ${CURVE} (secp256k1). Create the key with --kty EC --curve ${CURVE}`,
      );
    }
    const publicKey = publicKeyFromJwk({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
    // Pin only a validated key from a call that was not abandoned, so a late answer to a
    // timed-out call cannot choose the version.
    if (!ctx.signal.aborted && this.#pinned === undefined) {
      this.#pinned = {
        version,
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
      throw this.#error(
        "sign",
        "the key lookup did not finish, so there is no key version to sign with",
      );
    }
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
      throw this.#error("sign", "the signature is from another key version than the pinned one");
    }
    const signature: unknown = response.result;
    if (!(signature instanceof Uint8Array)) {
      throw this.#error("sign", "the response has no signature");
    }
    // 64 bytes `r || s`; the core rejects any other length.
    return { format: "compact", bytes: signature };
  }

  /** Reads the key version from a response's key id, which must name this key. */
  #versionOf(id: unknown, operation: string): string {
    const parsed = typeof id === "string" ? parseAzureKeyId(id) : undefined;
    if (parsed?.keyVersion === undefined) {
      throw this.#error(operation, "the response has no versioned key id");
    }
    if (!sameId(parsed.keyName, this.#id.keyName)) {
      throw this.#error(operation, "the response is for another key than the one requested");
    }
    return parsed.keyVersion;
  }

  /** Checks the key's attributes, as Key Vault would before signing, to fail with a clear error. */
  #checkUsable(response: KeyVaultKeyLike): void {
    const { enabled, notBefore, expiresOn } = response.properties;
    const now = Date.now();
    if (enabled === false) {
      throw this.#error(
        "get public key",
        "the key version is disabled. Enable it with `az keyvault key set-attributes --enabled true`",
      );
    }
    if (notBefore instanceof Date && notBefore.getTime() > now) {
      throw this.#error(
        "get public key",
        `the key version is not valid before ${notBefore.toISOString()}`,
      );
    }
    if (expiresOn instanceof Date && expiresOn.getTime() <= now) {
      throw this.#error("get public key", `the key version expired at ${expiresOn.toISOString()}`);
    }
    const operations: unknown = response.keyOperations;
    if (Array.isArray(operations) && !operations.includes(SIGN_OPERATION)) {
      throw this.#error(
        "get public key",
        "the key's permitted operations do not include sign. Set them with `az keyvault key set-attributes --ops sign verify`",
      );
    }
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
      return this.#error(
        operation,
        `no Azure credential returned a token (${error.name}). Run \`az login\`, or set AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET for a service principal`,
      );
    }
    if (error.name !== "RestError") {
      return undefined;
    }
    const status: unknown = Reflect.get(error, "statusCode");
    const code: unknown = Reflect.get(error, "code");
    const shownCode = typeof code === "string" && SAFE_CODE.test(code) ? code : undefined;
    if (typeof status !== "number" || !Number.isInteger(status)) {
      // No HTTP answer: the request did not reach Key Vault.
      return this.#error(
        operation,
        `Key Vault could not be reached${shownCode === undefined ? "" : ` (${shownCode})`}. Check the vault URL, the network and any proxy`,
      );
    }
    const answer = `Key Vault answered ${status}${shownCode === undefined ? "" : ` ${shownCode}`}`;
    if (status === 401) {
      return this.#error(operation, `${answer}: the credential was not accepted`);
    }
    if (status === 403) {
      return this.#error(
        operation,
        `${answer}: the identity may not use this key. It needs the keys/get and keys/sign permissions: the Key Vault Crypto User role on an RBAC vault, or the Get and Sign key permissions in an access policy. A disabled key or a firewall rule also gives 403`,
      );
    }
    if (status === 404) {
      return this.#error(
        operation,
        `${answer}: the key or key version does not exist in this vault. Check the key id`,
      );
    }
    return this.#error(operation, answer);
  }

  #error(operation: string, message: string) {
    return kmsError(message, { provider: "azure", operation, key: this.#key.displayId });
  }
}

/**
 * Builds the adapter for an Azure Key Vault or Managed HSM key. It makes no request: the key is
 * read on first use.
 *
 * @param key - The resolved key.
 * @param sdk - The @azure/keyvault-keys module.
 * @param credential - The credential for Key Vault requests.
 * @param options - Client settings for both Key Vault clients.
 * @returns The adapter.
 */
export async function createAzureKeyAdapter<Key extends KeyVaultKeyLike>(
  key: AzureKmsKeyConfig,
  sdk: AzureKeyVaultSdk<Key>,
  credential: TokenCredential,
  options: AzureClientOptions = {},
): Promise<KmsKeyAdapter> {
  const keyId = await key.keyId.get();
  const id = parseAzureKeyId(keyId);
  if (id === undefined) {
    // resolveIdentifier already checked the format; this only keeps the types honest.
    throw kmsError("the key id is not an Azure Key Vault key URL", {
      provider: "azure",
      operation: "create adapter",
      key: key.displayId,
    });
  }
  return new AzureKeyAdapter(key, id, sdk, credential, options);
}
