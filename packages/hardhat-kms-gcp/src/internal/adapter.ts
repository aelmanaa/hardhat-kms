import type { KeyManagementServiceClient, protos } from "@google-cloud/kms";
import { crc32c, kmsError, publicKeyFromSpkiPem } from "hardhat-kms/provider-utils";
import type {
  GcpKmsKeyConfig,
  KmsKeyAdapter,
  SignatureOutput,
  SignContext,
} from "hardhat-kms/types";

import { crc32cMatches, type StatusName, statusOf } from "./wire.ts";

const ALGORITHM = "EC_SIGN_SECP256K1_SHA256";

/** How many times a call is repeated after a checksum mismatch, so at most 4 attempts. */
export const CHECKSUM_RETRIES = 3;

/** The options the adapter passes to the client: REST transport, so no gRPC channel stays open. */
export type GcpClientOptions = NonNullable<
  ConstructorParameters<typeof KeyManagementServiceClient>[0]
>;

/** The per-call options the adapter passes: gax's timeout, which also bounds the SDK's retries. */
export interface GcpCallOptions {
  timeout: number;
}

/** The parts of a `KeyManagementServiceClient` the adapter uses. */
export interface GcpKmsClient {
  getPublicKey(
    request: { name: string },
    options: GcpCallOptions,
  ): Promise<[protos.google.cloud.kms.v1.IPublicKey, ...unknown[]]>;
  asymmetricSign(
    request: { name: string; digest: { sha256: Uint8Array }; digestCrc32c: { value: number } },
    options: GcpCallOptions,
  ): Promise<[protos.google.cloud.kms.v1.IAsymmetricSignResponse, ...unknown[]]>;
  close(): Promise<void>;
}

/** The parts of @google-cloud/kms the adapter uses; tests pass a fake with the same shape. */
export interface GcpKmsSdk {
  KeyManagementServiceClient: new (options: GcpClientOptions) => GcpKmsClient;
}

/** A response that failed a checksum: corrupted in transit, so the call is worth repeating. */
class ChecksumMismatch extends Error {
  public override readonly name = "ChecksumMismatch";
}

/** What to tell the user for each status the SDK reports. Nothing from the server's message. */
const STATUS_MESSAGES: Partial<Record<StatusName, string>> = {
  NOT_FOUND:
    "the key version was not found (NOT_FOUND). Check the project, location, key ring, key and version",
  PERMISSION_DENIED:
    "permission denied (PERMISSION_DENIED). The caller needs cloudkms.cryptoKeyVersions.viewPublicKey and cloudkms.cryptoKeyVersions.useToSign on the key, for example through roles/cloudkms.signer and roles/cloudkms.publicKeyViewer",
  FAILED_PRECONDITION:
    "the key version cannot be used (FAILED_PRECONDITION). It may be disabled, destroyed or scheduled for destruction; enable it or configure another version",
  UNAUTHENTICATED:
    "the Google Cloud credentials were refused (UNAUTHENTICATED). Run `gcloud auth application-default login` again, or check GOOGLE_APPLICATION_CREDENTIALS",
  RESOURCE_EXHAUSTED:
    "Google Cloud KMS is throttling requests (RESOURCE_EXHAUSTED). Try again later, or raise the project's Cloud KMS quota",
  DEADLINE_EXCEEDED: "Google Cloud KMS did not answer in time (DEADLINE_EXCEEDED)",
};

/**
 * The Google Cloud KMS adapter for one key version.
 *
 * Every call is checked for corruption in transit with CRC32C, in both directions: the digest
 * goes with `digestCrc32c`, and the response must confirm it with `verifiedDigestCrc32c` and carry
 * a matching `signatureCrc32c`; a public key must match its `pemCrc32c`. A mismatch repeats the
 * call, at most {@link CHECKSUM_RETRIES} times. A response for another key version fails at once.
 */
class GcpKeyAdapter implements KmsKeyAdapter {
  readonly #key: GcpKmsKeyConfig;
  readonly #name: string;
  readonly #client: GcpKmsClient;
  #checked = false;

  public constructor(key: GcpKmsKeyConfig, name: string, client: GcpKmsClient) {
    this.#key = key;
    this.#name = name;
    this.#client = client;
  }

  public describe(): { provider: string; pinnedId: string; displayId: string } {
    return {
      provider: "gcp",
      pinnedId: this.#key.keyVersionName.display,
      displayId: this.#key.displayId,
    };
  }

  public async getPublicKey(ctx: SignContext): Promise<Uint8Array> {
    const operation = "get public key";
    const response = await this.#withChecksumRetries(operation, ctx, async () => {
      const [key] = await this.#call(
        operation,
        async () => await this.#client.getPublicKey({ name: this.#name }, this.#options()),
      );
      // The checks below do not trust the SDK's types: every field of a response is optional.
      if (key.name !== this.#name) {
        throw this.#error(
          operation,
          "the response is for another key version than the one requested",
        );
      }
      const pem: unknown = key.pem;
      if (typeof pem !== "string" || pem === "") {
        throw this.#error(operation, "the response has no public key");
      }
      if (!crc32cMatches(new TextEncoder().encode(pem), key.pemCrc32c)) {
        throw new ChecksumMismatch("the public key does not match its checksum (pemCrc32c)");
      }
      return { pem, algorithm: key.algorithm };
    });
    if (response.algorithm !== ALGORITHM) {
      throw this.#error(
        operation,
        `the key version's algorithm is ${String(response.algorithm)}, not ${ALGORITHM} (secp256k1). Create the key with --purpose asymmetric-signing --default-algorithm ec-sign-secp256k1-sha256 --protection-level hsm`,
      );
    }
    const publicKey = publicKeyFromSpkiPem(response.pem);
    // Trust the algorithm only from a call that was not abandoned, as the signer does.
    if (!ctx.signal.aborted) {
      this.#checked = true;
    }
    return publicKey;
  }

  public async signDigest(
    request: { digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput> {
    const operation = "sign";
    if (!this.#checked) {
      // The signer always resolves the key first; this keeps the algorithm check if it ever does not.
      await this.getPublicKey(ctx);
    }
    if (!this.#checked) {
      throw this.#error(
        operation,
        "the key lookup did not finish, so the key version's algorithm is not checked",
      );
    }
    const digestCrc32c = crc32c(request.digest);
    const signature = await this.#withChecksumRetries(operation, ctx, async () => {
      const [response] = await this.#call(
        operation,
        async () =>
          await this.#client.asymmetricSign(
            {
              name: this.#name,
              digest: { sha256: request.digest },
              digestCrc32c: { value: digestCrc32c },
            },
            this.#options(),
          ),
      );
      if (response.name !== this.#name) {
        throw this.#error(
          operation,
          "the response is for another key version than the one requested",
        );
      }
      // False means the checksum sent with the digest did not arrive: never sign on without it.
      if (response.verifiedDigestCrc32c !== true) {
        throw new ChecksumMismatch(
          "Google Cloud KMS did not confirm the digest's checksum (verifiedDigestCrc32c)",
        );
      }
      const bytes: unknown = response.signature;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        throw this.#error(operation, "the response has no signature");
      }
      if (!crc32cMatches(bytes, response.signatureCrc32c)) {
        throw new ChecksumMismatch("the signature does not match its checksum (signatureCrc32c)");
      }
      return bytes;
    });
    return { format: "der", bytes: signature };
  }

  public async close(): Promise<void> {
    await this.#client.close();
  }

  #options(): GcpCallOptions {
    return { timeout: this.#key.timeoutMs };
  }

  /** Runs `attempt`, repeating it after a checksum mismatch, at most {@link CHECKSUM_RETRIES} times. */
  async #withChecksumRetries<T>(
    operation: string,
    ctx: SignContext,
    attempt: () => Promise<T>,
  ): Promise<T> {
    for (let retries = 0; ; retries++) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof ChecksumMismatch)) {
          throw error;
        }
        if (ctx.signal.aborted) {
          // The call was abandoned: report the mismatch, but do not ask again.
          throw this.#error(operation, error.message);
        }
        if (retries === CHECKSUM_RETRIES) {
          throw this.#error(
            operation,
            `${error.message}, after ${retries + 1} attempts. Data is being corrupted between this machine and Google Cloud KMS`,
          );
        }
      }
    }
  }

  /** Runs one SDK call, replacing the SDK's errors with ones that say what to do. */
  async #call<T>(operation: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const status = statusOf(error);
      if (status !== undefined) {
        // Only the status: the server's message names the project and the key.
        throw this.#error(
          operation,
          STATUS_MESSAGES[status] ?? `the Google Cloud KMS call failed (${status})`,
        );
      }
      // google-auth-library's message for missing Application Default Credentials. It holds no
      // request details, so it is safe to recognise.
      if (
        error instanceof Error &&
        error.message.includes("Could not load the default credentials")
      ) {
        throw this.#error(
          "connect",
          "no Google Cloud credentials found. Run `gcloud auth application-default login`, or set GOOGLE_APPLICATION_CREDENTIALS",
        );
      }
      throw error;
    }
  }

  #error(operation: string, message: string) {
    return kmsError(message, { provider: "gcp", operation, key: this.#key.displayId });
  }
}

/**
 * Builds the adapter for a Google Cloud KMS key version.
 *
 * @param key - The resolved key.
 * @param sdk - The @google-cloud/kms module.
 * @returns The adapter.
 */
export async function createGcpKeyAdapter(
  key: GcpKmsKeyConfig,
  sdk: GcpKmsSdk,
): Promise<KmsKeyAdapter> {
  const name = await key.keyVersionName.get();
  // REST rather than gRPC: a gRPC channel would keep `hardhat run` alive after the script ends.
  const client = new sdk.KeyManagementServiceClient({ fallback: true });
  return new GcpKeyAdapter(key, name, client);
}
