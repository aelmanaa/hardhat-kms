import type { AwsKmsKeyConfig, KmsKeyConfig } from "../../../types.ts";
import { publicKeyFromSpkiDer } from "../../crypto/public-key.ts";
import type { SignatureOutput } from "../../crypto/signature.ts";
import { kmsError } from "../../errors.ts";
import type { KmsKeyAdapter, SignContext } from "../../signer/types.ts";
import type { ProviderDeps, ProviderModule } from "../types.ts";
import { wrongProvider } from "../wrong-provider.ts";
import { parseAwsKeyId } from "./key-id.ts";

const SDK_PACKAGE = "@aws-sdk/client-kms";
const KEY_SPEC = "ECC_SECG_P256K1";
const KEY_USAGE = "SIGN_VERIFY";
const SIGNING_ALGORITHM = "ECDSA_SHA_256";

// The few parts of @aws-sdk/client-kms the adapter uses. They are declared here, not imported,
// so the plugin's published types do not depend on a package most users do not install.

/** The client, as the adapter uses it. */
interface KmsClient {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  destroy(): void;
}

/** The SDK module, as the adapter uses it. */
interface KmsSdk {
  KMSClient: new (config: { region?: string; profile?: string; endpoint?: string }) => KmsClient;
  GetPublicKeyCommand: new (input: { KeyId: string }) => unknown;
  SignCommand: new (input: {
    KeyId: string;
    Message: Uint8Array;
    MessageType: "DIGEST";
    SigningAlgorithm: typeof SIGNING_ALGORITHM;
  }) => unknown;
}

function isKmsSdk(module: unknown): module is KmsSdk {
  return (
    typeof module === "object" &&
    module !== null &&
    ["KMSClient", "GetPublicKeyCommand", "SignCommand"].every(
      (name) => typeof Reflect.get(module, name) === "function",
    )
  );
}

/** Reads a field of an SDK response without trusting its shape. */
function field(response: unknown, name: string): unknown {
  return typeof response === "object" && response !== null
    ? Reflect.get(response, name)
    : undefined;
}

/**
 * The AWS KMS adapter for one key.
 *
 * It signs 32-byte digests with `MessageType: DIGEST`, so KMS signs the digest as given instead of
 * hashing it again. It learns the key ARN from `GetPublicKey` and signs with that ARN, never with
 * an alias, so an alias that is repointed later cannot switch keys between the address lookup and
 * a signature.
 */
class AwsKeyAdapter implements KmsKeyAdapter {
  readonly #key: AwsKmsKeyConfig;
  readonly #keyId: string;
  readonly #client: KmsClient;
  readonly #sdk: KmsSdk;
  #keyArn: string | undefined;

  public constructor(key: AwsKmsKeyConfig, keyId: string, sdk: KmsSdk, client: KmsClient) {
    this.#key = key;
    this.#keyId = keyId;
    this.#sdk = sdk;
    this.#client = client;
  }

  public describe(): { provider: string; pinnedId: string; displayId: string } {
    return { provider: "aws", pinnedId: this.#key.keyId.display, displayId: this.#key.displayId };
  }

  public async getPublicKey(ctx: SignContext): Promise<Uint8Array> {
    const response = await this.#client.send(
      new this.#sdk.GetPublicKeyCommand({ KeyId: this.#keyId }),
      {
        abortSignal: ctx.signal,
      },
    );
    const keySpec = field(response, "KeySpec");
    if (keySpec !== KEY_SPEC) {
      throw this.#error(
        "get public key",
        `the key spec is ${String(keySpec)}, not ${KEY_SPEC} (secp256k1). Create the key with --key-spec ${KEY_SPEC} --key-usage ${KEY_USAGE}`,
      );
    }
    const keyUsage = field(response, "KeyUsage");
    if (keyUsage !== KEY_USAGE) {
      throw this.#error("get public key", `the key usage is ${String(keyUsage)}, not ${KEY_USAGE}`);
    }
    const algorithms = field(response, "SigningAlgorithms");
    if (!Array.isArray(algorithms) || !algorithms.includes(SIGNING_ALGORITHM)) {
      throw this.#error("get public key", `the key does not support ${SIGNING_ALGORITHM}`);
    }
    const keyArn = field(response, "KeyId");
    if (typeof keyArn !== "string" || parseAwsKeyId(keyArn)?.kind !== "keyArn") {
      throw this.#error("get public key", "the response has no key ARN");
    }
    const publicKey = field(response, "PublicKey");
    if (!(publicKey instanceof Uint8Array)) {
      throw this.#error("get public key", "the response has no public key");
    }
    this.#keyArn = keyArn;
    return publicKeyFromSpkiDer(publicKey);
  }

  public async signDigest(
    request: { digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput> {
    if (this.#keyArn === undefined) {
      // The signer always resolves the key first; this keeps the ARN rule if it ever does not.
      await this.getPublicKey(ctx);
    }
    const keyArn = this.#keyArn ?? "";
    const response = await this.#client.send(
      new this.#sdk.SignCommand({
        KeyId: keyArn,
        Message: request.digest,
        MessageType: "DIGEST",
        SigningAlgorithm: SIGNING_ALGORITHM,
      }),
      { abortSignal: ctx.signal },
    );
    if (field(response, "KeyId") !== keyArn) {
      throw this.#error("sign", "the response is for another key than the one requested");
    }
    if (field(response, "SigningAlgorithm") !== SIGNING_ALGORITHM) {
      throw this.#error("sign", `the response does not use ${SIGNING_ALGORITHM}`);
    }
    const signature = field(response, "Signature");
    if (!(signature instanceof Uint8Array)) {
      throw this.#error("sign", "the response has no signature");
    }
    return { format: "der", bytes: signature };
  }

  public async close(): Promise<void> {
    this.#client.destroy();
    await Promise.resolve();
  }

  #error(operation: string, message: string) {
    return kmsError(message, { provider: "aws", operation, key: this.#key.displayId });
  }
}

/**
 * Builds the adapter for an AWS KMS key.
 *
 * @param key - The resolved key.
 * @param deps - What the plugin provides, including the SDK loader.
 * @returns The adapter.
 */
async function createAwsKeyAdapter(
  key: AwsKmsKeyConfig,
  deps: ProviderDeps,
): Promise<KmsKeyAdapter> {
  const sdk = await deps.loadSdk(SDK_PACKAGE);
  if (!isKmsSdk(sdk)) {
    throw kmsError(
      `the installed ${SDK_PACKAGE} does not export KMSClient, GetPublicKeyCommand and SignCommand`,
      {
        provider: "aws",
        operation: "load SDK",
        key: key.displayId,
      },
    );
  }
  const keyId = await key.keyId.get();
  // A key ARN names its region; it wins over the configured one, which the config checks already
  // compared with it.
  const region = parseAwsKeyId(keyId)?.region ?? key.region;
  const client = new sdk.KMSClient({
    ...(region === undefined ? {} : { region }),
    ...(key.profile === undefined ? {} : { profile: key.profile }),
    ...(key.endpoint === undefined ? {} : { endpoint: key.endpoint }),
  });
  return new AwsKeyAdapter(key, keyId, sdk, client);
}

/** The AWS provider's adapter module, loaded when an AWS key is first used. */
export const awsModule: ProviderModule = {
  createKeyAdapter: async (key: KmsKeyConfig, deps) =>
    key.provider === "aws"
      ? await createAwsKeyAdapter(key, deps)
      : wrongProvider("aws", key.provider),
};
