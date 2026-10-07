import type { KeyManagementServiceClient, protos } from "@google-cloud/kms";
import {
  catalogError,
  catalogMessage,
  crc32c,
  type ErrorEntry,
  publicKeyFromSpkiPem,
  type TemplateParams,
} from "hardhat-kms/provider-utils";
import type {
  GcpKmsKeyConfig,
  KmsKeyAdapter,
  SignatureOutput,
  SignContext,
} from "hardhat-kms/types";

import { ERRORS } from "./error-catalog.ts";
import {
  authFailure,
  crc32cMatches,
  credentialFailure,
  keyProject,
  networkErrorCode,
  type StatusName,
  statusOf,
} from "./wire.ts";

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
 * The per-call options the adapter passes: gax's deadline for the request, no SDK retries, and the
 * plugin's `User-Agent` header. google-gax 6.5.0 is the first 6.x release that enforces the
 * deadline over REST.
 */
export interface GcpCallOptions {
  timeout: number;
  retry: null;
  otherArgs: { headers: { "User-Agent": string } };
}

/** The parts of a `KeyManagementServiceClient` the adapter uses. */
export interface GcpKmsClient {
  /**
   * Finds the credentials and builds the client's service stub, once; later calls return the
   * same promise, even a rejected one. The adapter awaits it before every call, so a credentials
   * failure rejects here, and replaces a client whose initialization failed.
   */
  initialize(): Promise<unknown>;
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
   * The google-gax module to run the client on. @hardhat-kms/gcp depends on google-gax `^6.5.0`
   * and passes it in, so the client enforces deadlines even when @google-cloud/kms resolves an
   * older google-gax of its own.
   */
  gax?: GaxModule;
}

/** Why a failed call is worth repeating, and the error to give if it keeps failing. */
const RETRY_ERRORS = {
  checksum: ERRORS.checksumExhausted,
  unavailable: ERRORS.unavailableExhausted,
} as const;

/** A call that failed in a way that repeating it may fix. */
class RetryableFailure extends Error {
  public override readonly name = "RetryableFailure";
  public readonly kind: keyof typeof RETRY_ERRORS;

  public constructor(kind: keyof typeof RETRY_ERRORS, message: string) {
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

/** The entries of the statuses the adapter explains; none has a placeholder. */
type StatusEntry = (typeof ERRORS)[
  | "notFound"
  | "permissionDenied"
  | "failedPrecondition"
  | "unauthenticated"
  | "resourceExhausted"
  | "deadlineExceeded"];

/** What to tell the user for each status the SDK reports. Nothing from the server's message. */
const STATUS_ERRORS: Partial<Record<StatusName, StatusEntry>> = {
  NOT_FOUND: ERRORS.notFound,
  PERMISSION_DENIED: ERRORS.permissionDenied,
  FAILED_PRECONDITION: ERRORS.failedPrecondition,
  UNAUTHENTICATED: ERRORS.unauthenticated,
  RESOURCE_EXHAUSTED: ERRORS.resourceExhausted,
  DEADLINE_EXCEEDED: ERRORS.deadlineExceeded,
};

/**
 * The Google Cloud KMS adapter for one key version.
 *
 * Every call is checked for corruption in transit with CRC32C, in both directions: the digest
 * goes with `digestCrc32c`, and the response must confirm it with `verifiedDigestCrc32c` and carry
 * a matching `signatureCrc32c`; a public key must match its `pemCrc32c`. A mismatch repeats the
 * call, at most {@link MAX_RETRIES} times. A response for another key version fails at once.
 */
class GcpKeyAdapter implements KmsKeyAdapter {
  readonly #key: GcpKmsKeyConfig;
  readonly #name: string;
  readonly #createClient: () => GcpKmsClient;
  /** The client, created by the first call, and again by the call after one failed to initialize. */
  #client: GcpKmsClient | undefined;
  readonly #userAgent: string;
  #checked = false;

  public constructor(
    key: GcpKmsKeyConfig,
    name: string,
    createClient: () => GcpKmsClient,
    userAgent: string,
  ) {
    this.#key = key;
    this.#name = name;
    this.#createClient = createClient;
    this.#userAgent = userAgent;
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
        async (client) => await client.getPublicKey({ name: this.#name }, this.#options()),
      );
      // The checks below do not trust the SDK's types: every field of a response is optional.
      if (key.name !== this.#name) {
        throw this.#error(operation, ERRORS.responseVersion, {});
      }
      const pem: unknown = key.pem;
      if (typeof pem !== "string" || pem === "") {
        throw this.#error(operation, ERRORS.noPublicKey, {});
      }
      if (!crc32cMatches(new TextEncoder().encode(pem), key.pemCrc32c)) {
        throw new RetryableFailure("checksum", catalogMessage(ERRORS.pemChecksum, {}));
      }
      return { pem, algorithm: key.algorithm };
    });
    if (response.algorithm !== ALGORITHM) {
      throw this.#error(operation, ERRORS.algorithm, { algorithm: String(response.algorithm) });
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
      throw this.#error(operation, ERRORS.lookupUnfinished, {});
    }
    const digestCrc32c = crc32c(request.digest);
    const signature = await this.#withRetries(operation, ctx, async () => {
      const [response] = await this.#call(
        operation,
        async (client) =>
          await client.asymmetricSign(
            {
              name: this.#name,
              digest: { sha256: request.digest },
              digestCrc32c: { value: digestCrc32c },
            },
            this.#options(),
          ),
      );
      if (response.name !== this.#name) {
        throw this.#error(operation, ERRORS.responseVersion, {});
      }
      // False means the checksum sent with the digest did not arrive: never sign on without it.
      if (response.verifiedDigestCrc32c !== true) {
        throw new RetryableFailure("checksum", catalogMessage(ERRORS.digestNotConfirmed, {}));
      }
      const bytes: unknown = response.signature;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        throw this.#error(operation, ERRORS.noSignature, {});
      }
      if (!crc32cMatches(bytes, response.signatureCrc32c)) {
        throw new RetryableFailure("checksum", catalogMessage(ERRORS.signatureChecksum, {}));
      }
      return bytes;
    });
    return { format: "der", bytes: signature };
  }

  public async close(): Promise<void> {
    await this.#client?.close();
  }

  #options(): GcpCallOptions {
    return {
      timeout: this.#key.timeoutMs,
      retry: null,
      // google-auth-library puts its own user agent after this one, and Cloud Audit Logs records
      // the header as `callerSuppliedUserAgent`. The `libName` client option would only reach
      // `x-goog-api-client`, which the audit log does not show.
      otherArgs: { headers: { "User-Agent": this.#userAgent } },
    };
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
          throw this.#error(operation, RETRY_ERRORS[error.kind], {
            reason: error.message,
            attempts: retries + 1,
          });
        }
        if (error.kind === "unavailable") {
          await pause(UNAVAILABLE_DELAY_MS * 2 ** retries, ctx.signal);
        }
        if (ctx.signal.aborted) {
          // The call was abandoned: report the failure, but do not ask again.
          throw this.#error(operation, ERRORS.abandoned, { reason: error.message });
        }
      }
    }
  }

  /**
   * Runs one SDK call, replacing the SDK's errors with ones that say what to do.
   *
   * The client is initialized first, and the call is made only once that succeeded. Each method
   * of the client starts `initialize()` itself and rethrows its failure into a promise that
   * nothing awaits, so calling a method with credentials that cannot be loaded ends the process
   * with an unhandled rejection. Awaiting `initialize()` here handles that failure instead, and
   * the method never runs.
   */
  async #call<T>(operation: string, call: (client: GcpKmsClient) => Promise<T>): Promise<T> {
    try {
      return await call(await this.#initialized());
    } catch (error) {
      // Checked first: over REST the SDK turns the HTTP status of such a refusal into a gRPC
      // status, which would read as Cloud KMS's own answer. A 5xx, 408 or 429 is not a refusal
      // for good: it goes on to the status handling below and is retried as before.
      const auth = authFailure(error);
      if (auth !== undefined) {
        switch (auth.kind) {
          case "login":
            // As before for an expired or revoked login, which the SDK reported as UNAUTHENTICATED.
            throw this.#error(operation, ERRORS.unauthenticated, {});
          case "tokenExchange":
            throw this.#error("connect", ERRORS.tokenExchangeRefused, { code: auth.code });
          case "endpoint":
            throw this.#error("connect", ERRORS.authEndpointRefused, {
              endpoint: auth.endpoint,
              status: auth.status,
            });
        }
      }
      const status = statusOf(error);
      if (status === "UNAVAILABLE") {
        // A refused connection, a failed DNS lookup or a proxy error arrives as UNAVAILABLE, with
        // the network error as its cause. Only the error code is shown, not the host.
        const code = networkErrorCode(error);
        throw new RetryableFailure(
          "unavailable",
          code === undefined
            ? catalogMessage(ERRORS.unavailable, {})
            : catalogMessage(ERRORS.unreachable, { code }),
        );
      }
      // Cloud KMS refuses a digest whose checksum does not match: the request was corrupted on
      // its way. Its message is read only to tell this apart from other INVALID_ARGUMENT errors.
      if (
        status === "INVALID_ARGUMENT" &&
        error instanceof Error &&
        /digest_?crc32c/i.test(error.message)
      ) {
        throw new RetryableFailure("checksum", catalogMessage(ERRORS.digestChecksumRefused, {}));
      }
      if (status !== undefined) {
        // Only the status: the server's message names the project and the key.
        const known = STATUS_ERRORS[status];
        throw known === undefined
          ? this.#error(operation, ERRORS.callFailed, { status })
          : this.#error(operation, known, {});
      }
      const credentials = credentialFailure(error);
      if (credentials !== undefined) {
        throw this.#error("connect", ERRORS[credentials], {});
      }
      throw error;
    }
  }

  /**
   * Returns the client once it is initialized.
   *
   * The client keeps the promise of its first `initialize()`, even a rejected one: after a
   * passing failure, such as a credentials lookup that timed out, every later call would fail
   * the same way. So a client whose initialization failed is closed and dropped, and the next
   * call creates another, which looks the credentials up again. Never cache a failure.
   *
   * Every client is created by a call, just before `initialize()`, and never ahead of it: the
   * client's constructor starts a credentials lookup of its own, for its long-running operations
   * client, and keeps a failure of it, which its `close()` later prints with the credentials
   * file's path. Created just before `initialize()`, both share one lookup and its result.
   */
  async #initialized(): Promise<GcpKmsClient> {
    const client = (this.#client ??= this.#createClient());
    try {
      await client.initialize();
    } catch (error) {
      // Calls that share the failed client all land here: only the first closes it.
      if (this.#client === client) {
        this.#client = undefined;
        try {
          // Its close awaits the same rejected promise; the failure is already being reported.
          await client.close();
        } catch {
          // Nothing to release: the client never started.
        }
      }
      throw error;
    }
    return client;
  }

  #error<Template extends string>(
    operation: string,
    entry: ErrorEntry<Template, "error">,
    params: TemplateParams<Template>,
  ): Error {
    return catalogError(entry, params, { provider: "gcp", operation, key: this.#key.displayId });
  }
}

/**
 * Builds the adapter for a Google Cloud KMS key version.
 *
 * @param key - The resolved key.
 * @param sdk - The @google-cloud/kms module.
 * @param userAgent - The plugin's user-agent tag, such as `hardhat-kms/1.0.0`.
 * @returns The adapter.
 */
export async function createGcpKeyAdapter(
  key: GcpKmsKeyConfig,
  sdk: GcpKmsSdk,
  userAgent: string,
): Promise<KmsKeyAdapter> {
  const name = await key.keyVersionName.get();
  // The key's project, so that google-auth-library does not look it up. With workload identity
  // federation and no project in the environment, it would ask Cloud Resource Manager, which a
  // principal with only the key's roles may not call.
  const projectId = keyProject(name);
  // REST rather than gRPC: a gRPC channel would keep `hardhat run` alive after the script ends.
  const createClient = (): GcpKmsClient =>
    new sdk.KeyManagementServiceClient(
      { fallback: true, ...(projectId === undefined ? {} : { projectId }) },
      sdk.gax,
    );
  return new GcpKeyAdapter(key, name, createClient, userAgent);
}
