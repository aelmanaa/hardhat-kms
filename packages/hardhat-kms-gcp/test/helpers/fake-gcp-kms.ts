import { createPrivateKey, createPublicKey } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { protos } from "@google-cloud/kms";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import gax from "google-gax";
import { crc32c } from "hardhat-kms/provider-utils";

import type {
  GaxModule,
  GcpCallOptions,
  GcpClientOptions,
  GcpKmsClient,
  GcpKmsSdk,
} from "../../src/internal/adapter.ts";

export const KEY_VERSION_NAME =
  "projects/p/locations/europe-west1/keyRings/r/cryptoKeys/deployer/cryptoKeyVersions/1";
const CURVE_ORDER = secp256k1.Point.CURVE().n;

/**
 * Encodes a secp256k1 public key as the PEM SubjectPublicKeyInfo Google Cloud KMS returns.
 *
 * @param secretKey - The private key.
 * @returns The public key's SPKI, PEM encoded, with a trailing newline.
 */
export function spkiPem(secretKey: Uint8Array): string {
  const point = secp256k1.getPublicKey(secretKey, false);
  const jwk = {
    kty: "EC",
    crv: "secp256k1",
    d: Buffer.from(secretKey).toString("base64url"),
    x: Buffer.from(point.slice(1, 33)).toString("base64url"),
    y: Buffer.from(point.slice(33)).toString("base64url"),
  };
  return createPublicKey(createPrivateKey({ key: jwk, format: "jwk" }))
    .export({ format: "pem", type: "spki" })
    .toString();
}

/**
 * Signs a digest as Google Cloud KMS does: DER, with a high S about half the time.
 *
 * @param secretKey - The private key.
 * @param digest - The 32-byte digest.
 * @param highS - Return the high-S twin of the signature.
 * @returns The DER signature.
 */
export function signDer(secretKey: Uint8Array, digest: Uint8Array, highS: boolean): Uint8Array {
  const compact = secp256k1.sign(digest, secretKey, {
    prehash: false,
    lowS: true,
    format: "compact",
  });
  const { r, s } = secp256k1.Signature.fromBytes(compact, "compact");
  return new secp256k1.Signature(r, highS ? CURVE_ORDER - s : s).toBytes("der");
}

/**
 * How many responses a fault applies to: a number of responses, counted from the first, or
 * `Infinity` for every response.
 */
type Times = number;

/** How the fake KMS behaves; defaults are a healthy secp256k1 HSM key version. */
export interface FakeKmsOptions {
  secretKey: Uint8Array;
  algorithm?: protos.google.cloud.kms.v1.IPublicKey["algorithm"];
  /** The `name` getPublicKey returns instead of the one requested; `null` for none. */
  publicKeyName?: string | null;
  /** The `name` asymmetricSign returns instead of the one requested; `null` for none. */
  signName?: string | null;
  omitPem?: boolean;
  omitSignature?: boolean;
  /** Return the high-S twin of every signature. */
  highS?: boolean;
  /** Return this instead of the DER signature (its checksum still matches). */
  signatureBytes?: Uint8Array;
  /** Answers with a wrong `pemCrc32c`. */
  corruptPemCrc32c?: Times;
  /** Answers without `pemCrc32c`. */
  omitPemCrc32c?: boolean;
  /** Answers with `verifiedDigestCrc32c: false`, as if the request's checksum got lost. */
  unverifiedDigest?: Times;
  /** Answers without `verifiedDigestCrc32c`. */
  omitVerifiedDigest?: boolean;
  /** Answers with a wrong `signatureCrc32c`. */
  corruptSignatureCrc32c?: Times;
  /** Answers without `signatureCrc32c`. */
  omitSignatureCrc32c?: boolean;
  /** How the checksums come back: a decimal string, as over REST (the default), or a number. */
  int64Form?: "number" | "string";
  /** Fail every call with this error. */
  callError?: Error;
  /** Reject `initialize()` with this error, as the SDK does when credentials cannot be loaded. */
  initializeError?: Error;
  /** How many clients, counted from the first, fail to initialize; every client by default. */
  initializeFailures?: Times;
  /**
   * How long each `initialize()` call, across all clients and counted from 0, waits before it
   * settles, in milliseconds: calls that share a client then see its outcome at different times.
   */
  initializeDelayMs?: (call: number) => number;
  /** Fail this many calls of one method, counted from the first, with this error. */
  failFirst?: { method: "getPublicKey" | "asymmetricSign"; error: Error; times: number };
  /** Answer getPublicKey only after the call's signal aborts, like a late network response. */
  hangPublicKey?: { signal: AbortSignal };
}

/** Whether a fault applies to the answer with this index (0 for the first). */
function faulty(times: Times | undefined, answer: number): boolean {
  return times !== undefined && answer < times;
}

/** A recorded SDK call. */
export interface RecordedCall {
  method: "getPublicKey" | "asymmetricSign";
  request: Record<string, unknown>;
  options: GcpCallOptions;
}

/** A recorded client: what it was created with, and how often it was initialized and closed. */
export interface RecordedClient {
  options: GcpClientOptions;
  gax: GaxModule;
  initialized: number;
  closed: number;
}

/** The fake SDK module, and what was done with it. */
export interface FakeGcpKms {
  sdk: GcpKmsSdk;
  calls: RecordedCall[];
  clients: RecordedClient[];
}

/**
 * A fake of the parts of @google-cloud/kms the adapter uses, recording every call. Like the real
 * service, it confirms `verifiedDigestCrc32c` only when the request's `digestCrc32c` matches the
 * digest it received.
 */
export function fakeGcpKmsSdk(options: FakeKmsOptions): FakeGcpKms {
  const calls: RecordedCall[] = [];
  const clients: RecordedClient[] = [];
  let failed = 0;
  let initializations = 0;
  let initializeCalls = 0;
  const fail = (method: "getPublicKey" | "asymmetricSign"): void => {
    if (options.callError !== undefined) {
      throw options.callError;
    }
    const first = options.failFirst;
    if (first !== undefined && first.method === method && failed < first.times) {
      failed++;
      throw first.error;
    }
  };
  let publicKeyAnswers = 0;
  let signAnswers = 0;
  const int64 = (value: number): { value: number | string } => ({
    value: options.int64Form === "number" ? value : String(value),
  });

  class KeyManagementServiceClient implements GcpKmsClient {
    readonly #record: RecordedClient;
    #initialization: Promise<void> | undefined;
    public constructor(clientOptions: GcpClientOptions, gaxModule?: GaxModule) {
      this.#record = { options: clientOptions, gax: gaxModule, initialized: 0, closed: 0 };
      clients.push(this.#record);
    }

    /** Like the SDK's, it keeps the outcome of its first initialization, a failure included. */
    public async initialize(): Promise<void> {
      this.#record.initialized++;
      const delay = options.initializeDelayMs?.(initializeCalls++) ?? 0;
      if (delay > 0) {
        await sleep(delay);
      }
      this.#initialization ??= this.#initialize(initializations++);
      await this.#initialization;
    }

    async #initialize(initialization: number): Promise<void> {
      if (
        options.initializeError !== undefined &&
        faulty(options.initializeFailures ?? Infinity, initialization)
      ) {
        throw options.initializeError;
      }
      await Promise.resolve();
    }

    public async getPublicKey(request: { name: string }, callOptions: GcpCallOptions) {
      calls.push({ method: "getPublicKey", request: { ...request }, options: callOptions });
      fail("getPublicKey");
      const hang = options.hangPublicKey?.signal;
      if (hang !== undefined && !hang.aborted) {
        await new Promise<void>((resolve) => {
          hang.addEventListener("abort", () => {
            resolve();
          });
        });
      }
      const answer = publicKeyAnswers++;
      const pem = spkiPem(options.secretKey);
      const pemCrc = crc32c(new TextEncoder().encode(pem));
      const response = {
        name: options.publicKeyName === undefined ? request.name : options.publicKeyName,
        algorithm: options.algorithm ?? "EC_SIGN_SECP256K1_SHA256",
        ...(options.omitPem === true ? {} : { pem }),
        ...(options.omitPemCrc32c === true
          ? {}
          : {
              pemCrc32c: int64(
                faulty(options.corruptPemCrc32c, answer) ? (pemCrc ^ 1) >>> 0 : pemCrc,
              ),
            }),
      };
      return await Promise.resolve<[typeof response, undefined, undefined]>([
        response,
        undefined,
        undefined,
      ]);
    }

    public async asymmetricSign(
      request: { name: string; digest: { sha256: Uint8Array }; digestCrc32c: { value: number } },
      callOptions: GcpCallOptions,
    ) {
      calls.push({ method: "asymmetricSign", request: { ...request }, options: callOptions });
      fail("asymmetricSign");
      const answer = signAnswers++;
      const digest = request.digest.sha256;
      const verified =
        crc32c(digest) === request.digestCrc32c.value && !faulty(options.unverifiedDigest, answer);
      const signature =
        options.signatureBytes ?? signDer(options.secretKey, digest, options.highS === true);
      const signatureCrc = crc32c(signature);
      const response = {
        name: options.signName === undefined ? request.name : options.signName,
        verifiedDataCrc32c: false,
        ...(options.omitVerifiedDigest === true ? {} : { verifiedDigestCrc32c: verified }),
        ...(options.omitSignature === true ? {} : { signature: Buffer.from(signature) }),
        ...(options.omitSignatureCrc32c === true
          ? {}
          : {
              signatureCrc32c: int64(
                faulty(options.corruptSignatureCrc32c, answer)
                  ? (signatureCrc ^ 0x80000000) >>> 0
                  : signatureCrc,
              ),
            }),
      };
      return await Promise.resolve<[typeof response, undefined, undefined]>([
        response,
        undefined,
        undefined,
      ]);
    }

    /** Like the SDK's, it waits for the initialization, and rejects with its failure. */
    public async close(): Promise<void> {
      this.#record.closed++;
      await (this.#initialization ?? Promise.resolve());
    }
  }

  return { sdk: { KeyManagementServiceClient, gax }, calls, clients };
}

/**
 * An error as the Google Cloud SDK throws it: a plain `Error` whose `code` is a gRPC status.
 *
 * @param code - The gRPC status code.
 * @param message - The server's message, which the adapter must not repeat.
 * @returns The error.
 */
export function googleError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}
