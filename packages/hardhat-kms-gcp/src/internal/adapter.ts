import type { KeyManagementServiceClient, protos } from "@google-cloud/kms";
import { crc32c, kmsError, publicKeyFromSpkiPem } from "hardhat-kms/provider-utils";
import type {
  GcpKmsKeyConfig,
  KmsKeyAdapter,
  SignatureOutput,
  SignContext,
} from "hardhat-kms/types";

import { crc32cMatches, networkErrorCode, type StatusName, statusOf } from "./wire.ts";

const ALGORITHM = "EC_SIGN_SECP256K1_SHA256";

/**
 * How many times a call is repeated after a checksum mismatch or an unavailable service, so at
 * most 4 attempts. The SDK's own retries are off: this is the only retry loop, and it stops when
 * the call's signal aborts.
 */
export const MAX_RETRIES = 3;

/** The pause before repeating a call the service could not take, doubled each time. */
const UNAVAILABLE_DELAY_MS = 100;

/** The options the adapter passes to the client: REST transport, so no gRPC channel stays open. */
export type GcpClientOptions = NonNullable<
  ConstructorParameters<typeof KeyManagementServiceClient>[0]
>;

/**
 * The per-call options the adapter passes: gax's deadline for the request, and no SDK retries.
 * google-gax 6.5.0 is the first 6.x release that enforces the deadline over REST.
 */
export interface GcpCallOptions {
  timeout: number;
  retry: null;
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

/** The google-gax module a client runs on, its constructor's second argument. */
export type GaxModule = ConstructorParameters<typeof KeyManagementServiceClient>[1];

/** The parts of @google-cloud/kms the adapter uses; tests pass a fake with the same shape. */
export interface GcpKmsSdk {
  KeyManagementServiceClient: new (options: GcpClientOptions, gax?: GaxModule) => GcpKmsClient;
  /**
   * The google-gax module to run the client on. hardhat-kms-gcp depends on google-gax `^6.5.0`
   * and passes it in, so the client enforces deadlines even when @google-cloud/kms resolves an
   * older google-gax of its own.
   */
  gax?: GaxModule;
}

/** Why a failed call is worth repeating, and what to say if it keeps failing. */
const RETRY_HINTS = {
  checksum: "Data is being corrupted between this machine and Google Cloud KMS",
  unavailable: "Check the network connection, DNS and any proxy",
} as const;

/** A call that failed in a way that repeating it may fix. */
class RetryableFailure extends Error {
  public override readonly name = "RetryableFailure";
  public readonly kind: keyof typeof RETRY_HINTS;

  public constructor(kind: keyof typeof RETRY_HINTS, message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Waits `ms` milliseconds, or less if `signal` aborts. The timer is not unref'd: a call in
 * progress waits on it, and with nothing else pending an unref'd timer would let the process
 * exit in the middle of a signature. An abort clears it at once.
 *
 * @param ms - The delay.
 * @param signal - Ends the wait early.
 */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
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
    const response = await this.#withRetries(operation, ctx, async () => {
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
        throw new RetryableFailure(
          "checksum",
          "the public key does not match its checksum (pemCrc32c)",
        );
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
    const signature = await this.#withRetries(operation, ctx, async () => {
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
        throw new RetryableFailure(
          "checksum",

          "Google Cloud KMS did not confirm the digest's checksum (verifiedDigestCrc32c)",
        );
      }
      const bytes: unknown = response.signature;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        throw this.#error(operation, "the response has no signature");
      }
      if (!crc32cMatches(bytes, response.signatureCrc32c)) {
        throw new RetryableFailure(
          "checksum",
          "the signature does not match its checksum (signatureCrc32c)",
        );
      }
      return bytes;
    });
    return { format: "der", bytes: signature };
  }

  public async close(): Promise<void> {
    await this.#client.close();
  }

  #options(): GcpCallOptions {
    return { timeout: this.#key.timeoutMs, retry: null };
  }

  /**
   * Runs `attempt`, repeating it after a checksum mismatch or an unavailable service, at most
   * {@link MAX_RETRIES} times, and never once the call's signal has aborted.
   */
  async #withRetries<T>(
    operation: string,
    ctx: SignContext,
    attempt: () => Promise<T>,
  ): Promise<T> {
    for (let retries = 0; ; retries++) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof RetryableFailure)) {
          throw error;
        }
        if (retries === MAX_RETRIES) {
          throw this.#error(
            operation,
            `${error.message}, after ${retries + 1} attempts. ${RETRY_HINTS[error.kind]}`,
          );
        }
        if (error.kind === "unavailable") {
          await pause(UNAVAILABLE_DELAY_MS * 2 ** retries, ctx.signal);
        }
        if (ctx.signal.aborted) {
          // The call was abandoned: report the failure, but do not ask again.
          throw this.#error(operation, error.message);
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
      if (status === "UNAVAILABLE") {
        // A refused connection, a failed DNS lookup or a proxy error arrives as UNAVAILABLE, with
        // the network error as its cause. Only the error code is shown, not the host.
        const code = networkErrorCode(error);
        throw new RetryableFailure(
          "unavailable",
          code === undefined
            ? "Google Cloud KMS is unavailable (UNAVAILABLE)"
            : `could not reach Google Cloud KMS (${code})`,
        );
      }
      // Cloud KMS refuses a digest whose checksum does not match: the request was corrupted on
      // its way. Its message is read only to tell this apart from other INVALID_ARGUMENT errors.
      if (
        status === "INVALID_ARGUMENT" &&
        error instanceof Error &&
        /digest_?crc32c/i.test(error.message)
      ) {
        throw new RetryableFailure(
          "checksum",
          "Google Cloud KMS refused the digest's checksum (digestCrc32c, INVALID_ARGUMENT)",
        );
      }
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
  const client = new sdk.KeyManagementServiceClient({ fallback: true }, sdk.gax);
  return new GcpKeyAdapter(key, name, client);
}
