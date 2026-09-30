import { createPrivateKey, createPublicKey } from "node:crypto";

import { secp256k1 } from "@noble/curves/secp256k1.js";

import type { AwsKmsSdk } from "../../src/internal/adapter.ts";

export const KEY_ARN =
  "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
const CURVE_ORDER = secp256k1.Point.CURVE().n;

/**
 * Encodes a secp256k1 public key as the DER SubjectPublicKeyInfo KMS returns.
 *
 * @param secretKey - The private key.
 * @returns The public key's SPKI, DER encoded.
 */
export function spkiDer(secretKey: Uint8Array): Uint8Array {
  const point = secp256k1.getPublicKey(secretKey, false);
  const jwk = {
    kty: "EC",
    crv: "secp256k1",
    d: Buffer.from(secretKey).toString("base64url"),
    x: Buffer.from(point.slice(1, 33)).toString("base64url"),
    y: Buffer.from(point.slice(33)).toString("base64url"),
  };
  return new Uint8Array(
    createPublicKey(createPrivateKey({ key: jwk, format: "jwk" })).export({
      format: "der",
      type: "spki",
    }),
  );
}

/** How the fake KMS behaves; defaults are a healthy secp256k1 signing key. */
export interface FakeKmsOptions {
  secretKey: Uint8Array;
  keySpec?: string;
  keyUsage?: string;
  signingAlgorithms?: string[] | undefined;
  /** The key ARN GetPublicKey returns. */
  keyArn?: string | undefined;
  /** The key id Sign returns, when it should differ from the one requested. */
  signResponseKeyId?: string;
  signResponseAlgorithm?: string;
  omitPublicKey?: boolean;
  omitSignature?: boolean;
  /** Return the high-S twin of every signature, as KMS may. */
  highS?: boolean;
  /** Fail every call with this error, as the SDK does, for example, without a region. */
  sendError?: Error;
  /** Answer GetPublicKey only after the call's signal aborts, like a late network response. */
  answerAfterAbort?: boolean;
}

/** A recorded SDK call. */
export interface RecordedCall {
  command: string;
  input: Record<string, unknown>;
  abortSignal: AbortSignal | undefined;
}

/** A recorded client: the config it was created with, and whether it was destroyed. */
export interface RecordedClient {
  config: Record<string, unknown>;
  destroyed: boolean;
}

/** The fake SDK module, and what was done with it. */
export interface FakeAwsKms {
  sdk: AwsKmsSdk;
  calls: RecordedCall[];
  clients: RecordedClient[];
}

/** A fake of the parts of @aws-sdk/client-kms the adapter uses, recording every call. */
export function fakeAwsKmsSdk(options: FakeKmsOptions): FakeAwsKms {
  const calls: RecordedCall[] = [];
  const clients: RecordedClient[] = [];

  class GetPublicKeyCommand {
    public readonly name = "GetPublicKey";
    public readonly input: Record<string, unknown>;
    public constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class SignCommand {
    public readonly name = "Sign";
    public readonly input: Record<string, unknown>;
    public constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }

  const spki = (): Uint8Array => spkiDer(options.secretKey);

  class KMSClient {
    readonly #record: RecordedClient;
    public constructor(config: Record<string, unknown>) {
      this.#record = { config, destroyed: false };
      clients.push(this.#record);
    }
    public async send(
      command: GetPublicKeyCommand | SignCommand,
      sendOptions?: { abortSignal?: AbortSignal },
    ) {
      calls.push({
        command: command.name,
        input: command.input,
        abortSignal: sendOptions?.abortSignal,
      });
      if (options.sendError !== undefined) {
        throw options.sendError;
      }
      if (options.answerAfterAbort === true && command instanceof GetPublicKeyCommand) {
        const signal = sendOptions?.abortSignal;
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => {
            resolve();
          });
        });
      }
      if (command instanceof GetPublicKeyCommand) {
        return await Promise.resolve({
          KeyId: "keyArn" in options ? options.keyArn : KEY_ARN,
          KeySpec: options.keySpec ?? "ECC_SECG_P256K1",
          KeyUsage: options.keyUsage ?? "SIGN_VERIFY",
          SigningAlgorithms:
            "signingAlgorithms" in options ? options.signingAlgorithms : ["ECDSA_SHA_256"],
          ...(options.omitPublicKey === true ? {} : { PublicKey: spki() }),
        });
      }
      const digest = command.input.Message;
      if (!(digest instanceof Uint8Array)) {
        throw new TypeError("Message must be bytes");
      }
      const compact = secp256k1.sign(digest, options.secretKey, {
        prehash: false,
        lowS: true,
        format: "compact",
      });
      let { r, s } = secp256k1.Signature.fromBytes(compact, "compact");
      if (options.highS === true) {
        s = CURVE_ORDER - s;
      }
      return await Promise.resolve({
        KeyId: options.signResponseKeyId ?? command.input.KeyId,
        SigningAlgorithm: options.signResponseAlgorithm ?? command.input.SigningAlgorithm,
        ...(options.omitSignature === true
          ? {}
          : { Signature: new secp256k1.Signature(r, s).toBytes("der") }),
      });
    }
    public destroy(): void {
      this.#record.destroyed = true;
    }
  }

  const sdk: unknown = { KMSClient, GetPublicKeyCommand, SignCommand };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake has the shape the adapter uses, not the SDK's full types
  return { sdk: sdk as AwsKmsSdk, calls, clients };
}
