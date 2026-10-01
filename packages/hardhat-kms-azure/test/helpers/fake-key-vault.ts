import { secp256k1 } from "@noble/curves/secp256k1.js";

import type {
  AzureKeyVaultSdk,
  KeyVaultKeyLike,
  SignCallOptions,
} from "../../src/internal/adapter.ts";

export const VAULT_URL = "https://test-vault.vault.azure.net";
export const KEY_NAME = "deployer";
export const KEY_VERSION = "0123456789abcdef0123456789abcdef";
export const KEY_URL: string = `${VAULT_URL}/keys/${KEY_NAME}`;
export const VERSIONED_KEY_URL: string = `${KEY_URL}/${KEY_VERSION}`;

const CURVE_ORDER = secp256k1.Point.CURVE().n;

/** How the fake Key Vault behaves; defaults are a healthy, enabled P-256K key. */
export interface FakeKeyVaultOptions {
  secretKey: Uint8Array;
  /** The current version of the key, which an unversioned lookup returns. */
  currentVersion?: string;
  kty?: string | undefined;
  crv?: string | undefined;
  /** Strip leading zero bytes from x and y, as Key Vault may. */
  trimCoordinates?: boolean;
  enabled?: boolean | undefined;
  notBefore?: Date;
  expiresOn?: Date;
  keyOperations?: string[] | undefined;
  omitJwk?: boolean;
  /** The key id getKey returns; by default the requested (or current) version's. */
  keyId?: string | undefined;
  /** The `kid` the sign response carries; by default the signing client's key id. */
  signKid?: unknown;
  omitSignBody?: boolean;
  /** Return the high-S twin of every signature, as Key Vault may. */
  highS?: boolean;
  /** Return this many bytes instead of the 64-byte signature. */
  signatureLength?: number;
  omitSignature?: boolean;
  /** Fail every call with this error. */
  error?: Error;
  /** Answer getKey only after the call's signal aborts, like a late network response. */
  answerAfterAbort?: boolean;
}

/** A recorded SDK call. */
export interface RecordedCall {
  method: "getKey" | "sign";
  /** The key name for getKey; the key id of the client for sign. */
  target: string;
  version?: string | undefined;
  algorithm?: string;
  digest?: Uint8Array;
  abortSignal: AbortSignal | undefined;
}

/** The key a fake getKey returns. */
export interface FakeKey extends KeyVaultKeyLike {
  id?: string | undefined;
}

/** The fake SDK module, and what was done with it. */
export interface FakeKeyVault {
  sdk: AzureKeyVaultSdk<FakeKey>;
  calls: RecordedCall[];
  /** The vault URLs KeyClients were created for. */
  vaults: string[];
  /** The key ids CryptographyClients were created for. */
  cryptographyKeys: Array<string | undefined>;
}

/** Strips leading zero bytes. */
function trim(bytes: Uint8Array): Uint8Array {
  const first = bytes.findIndex((byte) => byte !== 0);
  return first === -1 ? new Uint8Array() : bytes.slice(first);
}

/**
 * Signs a digest with a secp256k1 key the way Key Vault's ES256K does: 64 bytes `r || s`.
 *
 * @param secretKey - The private key.
 * @param digest - The 32-byte digest.
 * @param highS - Return the high-S twin.
 * @returns The compact signature.
 */
export function signCompact(secretKey: Uint8Array, digest: Uint8Array, highS = false): Uint8Array {
  const compact = secp256k1.sign(digest, secretKey, {
    prehash: false,
    lowS: true,
    format: "compact",
  });
  if (!highS) {
    return compact;
  }
  const { r, s } = secp256k1.Signature.fromBytes(compact, "compact");
  return new secp256k1.Signature(r, CURVE_ORDER - s).toBytes("compact");
}

/** A fake of the parts of @azure/keyvault-keys the adapter uses, recording every call. */
export function fakeKeyVaultSdk(options: FakeKeyVaultOptions): FakeKeyVault {
  const calls: RecordedCall[] = [];
  const vaults: string[] = [];
  const cryptographyKeys: Array<string | undefined> = [];
  const point = secp256k1.getPublicKey(options.secretKey, false);
  const coordinate = (bytes: Uint8Array) =>
    options.trimCoordinates === true ? trim(bytes) : bytes;

  class KeyClient {
    readonly #vaultUrl: string;
    public constructor(vaultUrl: string) {
      this.#vaultUrl = vaultUrl;
      vaults.push(vaultUrl);
    }
    public async getKey(
      name: string,
      getOptions?: { version?: string; abortSignal?: AbortSignal },
    ): Promise<FakeKey> {
      calls.push({
        method: "getKey",
        target: name,
        version: getOptions?.version,
        abortSignal: getOptions?.abortSignal,
      });
      if (options.error !== undefined) {
        throw options.error;
      }
      if (options.answerAfterAbort === true) {
        const signal = getOptions?.abortSignal;
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => {
            resolve();
          });
        });
      }
      const version = getOptions?.version ?? options.currentVersion ?? KEY_VERSION;
      return {
        id: "keyId" in options ? options.keyId : `${this.#vaultUrl}/keys/${name}/${version}`,
        ...(options.omitJwk === true
          ? {}
          : {
              key: {
                kty: "kty" in options ? options.kty : "EC",
                crv: "crv" in options ? options.crv : "P-256K",
                x: coordinate(point.slice(1, 33)),
                y: coordinate(point.slice(33)),
              },
            }),
        keyOperations: "keyOperations" in options ? options.keyOperations : ["sign", "verify"],
        properties: {
          enabled: "enabled" in options ? options.enabled : true,
          ...(options.notBefore === undefined ? {} : { notBefore: options.notBefore }),
          ...(options.expiresOn === undefined ? {} : { expiresOn: options.expiresOn }),
        },
      };
    }
  }

  class CryptographyClient {
    readonly #keyId: string | undefined;
    public constructor(key: FakeKey) {
      this.#keyId = key.id;
      cryptographyKeys.push(key.id);
    }
    public async sign(
      algorithm: string,
      digest: Uint8Array,
      signOptions: SignCallOptions,
    ): Promise<{ result?: Uint8Array | undefined }> {
      calls.push({
        method: "sign",
        target: String(this.#keyId),
        algorithm,
        digest,
        abortSignal: signOptions.abortSignal,
      });
      if (options.error !== undefined) {
        throw options.error;
      }
      let signature = signCompact(options.secretKey, digest, options.highS === true);
      if (options.signatureLength !== undefined) {
        const resized = new Uint8Array(options.signatureLength);
        resized.set(signature.slice(0, options.signatureLength));
        signature = resized;
      }
      const kid = "signKid" in options ? options.signKid : this.#keyId;
      signOptions.onResponse({
        status: 200,
        ...(options.omitSignBody === true
          ? {}
          : { parsedBody: { kid, value: Buffer.from(signature).toString("base64url") } }),
      });
      return await Promise.resolve(options.omitSignature === true ? {} : { result: signature });
    }
  }

  return { sdk: { KeyClient, CryptographyClient }, calls, vaults, cryptographyKeys };
}

/**
 * An error shaped like the Azure SDK's RestError.
 *
 * @param statusCode - The HTTP status, if a response came back.
 * @param code - The service's error code.
 * @returns The error.
 */
export function restError(statusCode: number | undefined, code?: string): Error {
  const error = new Error(
    `secret details: https://test-vault.vault.azure.net/keys/${KEY_NAME} caller oid=1234`,
  );
  error.name = "RestError";
  Object.assign(error, {
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(code === undefined ? {} : { code }),
  });
  return error;
}
