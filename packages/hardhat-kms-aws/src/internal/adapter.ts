import type {
  GetPublicKeyCommand,
  KMSClient,
  KMSClientConfig,
  SignCommand,
} from "@aws-sdk/client-kms";
import { kmsError, parseAwsKeyId, publicKeyFromSpkiDer } from "hardhat-kms/provider-utils";
import type {
  AwsKmsKeyConfig,
  KmsKeyAdapter,
  SignatureOutput,
  SignContext,
} from "hardhat-kms/types";

const KEY_SPEC = "ECC_SECG_P256K1";
const KEY_USAGE = "SIGN_VERIFY";
const SIGNING_ALGORITHM = "ECDSA_SHA_256";

/** The parts of @aws-sdk/client-kms the adapter uses; tests pass a fake with the same shape. */
export interface AwsKmsSdk {
  KMSClient: new (config: KMSClientConfig) => Pick<KMSClient, "send" | "destroy">;
  GetPublicKeyCommand: typeof GetPublicKeyCommand;
  SignCommand: typeof SignCommand;
}

type KmsClient = InstanceType<AwsKmsSdk["KMSClient"]>;

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
  readonly #sdk: AwsKmsSdk;
  #keyArn: string | undefined;

  public constructor(key: AwsKmsKeyConfig, keyId: string, sdk: AwsKmsSdk, client: KmsClient) {
    this.#key = key;
    this.#keyId = keyId;
    this.#sdk = sdk;
    this.#client = client;
  }

  public describe(): { provider: string; pinnedId: string; displayId: string } {
    return { provider: "aws", pinnedId: this.#key.keyId.display, displayId: this.#key.displayId };
  }

  public async getPublicKey(ctx: SignContext): Promise<Uint8Array> {
    const response = await this.#send(
      async () =>
        await this.#client.send(new this.#sdk.GetPublicKeyCommand({ KeyId: this.#keyId }), {
          abortSignal: ctx.signal,
        }),
    );
    // The checks below do not trust the SDK's types: every field of a response is optional.
    const keySpec = response.KeySpec;
    if (keySpec !== KEY_SPEC) {
      throw this.#error(
        "get public key",
        `the key spec is ${String(keySpec)}, not ${KEY_SPEC} (secp256k1). Create the key with --key-spec ${KEY_SPEC} --key-usage ${KEY_USAGE}`,
      );
    }
    const keyUsage = response.KeyUsage;
    if (keyUsage !== KEY_USAGE) {
      throw this.#error("get public key", `the key usage is ${String(keyUsage)}, not ${KEY_USAGE}`);
    }
    const algorithms: unknown = response.SigningAlgorithms;
    if (!Array.isArray(algorithms) || !algorithms.includes(SIGNING_ALGORITHM)) {
      throw this.#error("get public key", `the key does not support ${SIGNING_ALGORITHM}`);
    }
    const keyArn = response.KeyId;
    if (typeof keyArn !== "string" || parseAwsKeyId(keyArn)?.kind !== "keyArn") {
      throw this.#error("get public key", "the response has no key ARN");
    }
    const publicKey: unknown = response.PublicKey;
    if (!(publicKey instanceof Uint8Array)) {
      throw this.#error("get public key", "the response has no public key");
    }
    const parsed = publicKeyFromSpkiDer(publicKey);
    // Keep the ARN only for a validated key from a call that was not abandoned, so a late answer
    // to a timed-out call cannot replace it.
    if (!ctx.signal.aborted) {
      this.#keyArn = keyArn;
    }
    return parsed;
  }

  public async signDigest(
    request: { digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput> {
    if (this.#keyArn === undefined) {
      // The signer always resolves the key first; this keeps the ARN rule if it ever does not.
      await this.getPublicKey(ctx);
    }
    const keyArn = this.#keyArn;
    if (keyArn === undefined) {
      // The lookup above was abandoned (its signal aborted): never sign without the ARN.
      throw this.#error(
        "sign",
        "the key lookup did not finish, so there is no key ARN to sign with",
      );
    }
    const command = new this.#sdk.SignCommand({
      KeyId: keyArn,
      Message: request.digest,
      MessageType: "DIGEST",
      SigningAlgorithm: SIGNING_ALGORITHM,
    });
    const response = await this.#send(
      async () => await this.#client.send(command, { abortSignal: ctx.signal }),
    );
    if (response.KeyId !== keyArn) {
      throw this.#error("sign", "the response is for another key than the one requested");
    }
    if (response.SigningAlgorithm !== SIGNING_ALGORITHM) {
      throw this.#error("sign", `the response does not use ${SIGNING_ALGORITHM}`);
    }
    const signature: unknown = response.Signature;
    if (!(signature instanceof Uint8Array)) {
      throw this.#error("sign", "the response has no signature");
    }
    return { format: "der", bytes: signature };
  }

  async #send<Output>(send: () => Promise<Output>): Promise<Output> {
    try {
      return await send();
    } catch (error) {
      // The SDK reports a missing region with a plain Error, which the signer would show only as
      // "Error". Its message holds no request details, so it is safe to recognise.
      if (error instanceof Error && error.message.includes("Region is missing")) {
        throw this.#error(
          "connect",
          "no AWS region is configured. Set `region` on the key, `kms.defaults.aws.region`, AWS_REGION, or a region in the AWS profile, or use a key ARN",
        );
      }
      throw error;
    }
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
 * @param sdk - The @aws-sdk/client-kms module.
 * @returns The adapter.
 */
export async function createAwsKeyAdapter(
  key: AwsKmsKeyConfig,
  sdk: AwsKmsSdk,
): Promise<KmsKeyAdapter> {
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
