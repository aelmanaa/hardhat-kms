import { keccak_256 } from "@noble/hashes/sha3.js";
import { eip191Signer, verifyTyped } from "micro-eth-signer";
import { RLP } from "micro-eth-signer/core/rlp.js";

import { ERRORS } from "../error-catalog.ts";
import { catalogMessage } from "../errors.ts";
import { sigHash } from "../vendor/micro-eth-signer/typed-data.ts";

/**
 * An EIP-712 typed-data payload, as accepted by `eth_signTypedData_v4`.
 *
 * Requests arrive as untyped JSON, so the shape is kept loose here; the encoder validates it at
 * runtime.
 */
export interface TypedData {
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

type EncoderInput = Parameters<typeof sigHash>[0];

/** Thrown when a value does not have the shape of EIP-712 typed data. */
export class InvalidTypedDataError extends Error {
  public override readonly name = "InvalidTypedDataError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isField(value: unknown): value is { name: string; type: string } {
  return isRecord(value) && typeof value.name === "string" && typeof value.type === "string";
}

/**
 * Checks that a value has the shape of EIP-712 typed data and computes its digest once, so that a
 * malformed payload fails here, before any KMS call.
 *
 * @param input - The payload, for example the parsed `eth_signTypedData_v4` param.
 * @returns A private copy of the payload, typed. Later checks and the signature must use it.
 * @throws {InvalidTypedDataError} If the shape is wrong or the encoder rejects it.
 */
export function parseTypedData(input: unknown): TypedData {
  // Work on a private copy: a caller's live object could change between the checks and the
  // signature, so that the signed digest commits to other values than the checked ones. The copy
  // runs each getter once, and refuses functions and other values that are not plain data.
  let value: unknown;
  try {
    value = structuredClone(input);
  } catch {
    throw new InvalidTypedDataError(catalogMessage(ERRORS.typedDataPlainData, {}));
  }
  if (!isRecord(value)) {
    throw new InvalidTypedDataError(catalogMessage(ERRORS.typedDataObject, {}));
  }
  const { types, primaryType, domain, message } = value;
  if (!isRecord(types)) {
    throw new InvalidTypedDataError(catalogMessage(ERRORS.typedDataTypes, {}));
  }
  const entries: [string, { name: string; type: string }[]][] = [];
  for (const [name, fields] of Object.entries(types)) {
    if (!Array.isArray(fields) || !fields.every(isField)) {
      throw new InvalidTypedDataError(
        catalogMessage(ERRORS.typedDataTypeFields, { typeName: name }),
      );
    }
    entries.push([name, fields]);
  }
  if (typeof primaryType !== "string" || !isRecord(domain) || !isRecord(message)) {
    throw new InvalidTypedDataError(catalogMessage(ERRORS.typedDataShape, {}));
  }
  // fromEntries defines own properties, so a type named `__proto__` cannot reach the prototype.
  const typedFields: TypedData["types"] = Object.fromEntries(entries);
  const typedData: TypedData = { types: typedFields, primaryType, domain, message };
  try {
    typedDataDigest(typedData);
  } catch (error) {
    throw new InvalidTypedDataError(
      catalogMessage(ERRORS.typedDataEncoder, {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return typedData;
}

/**
 * Computes the EIP-191 ("personal message") digest of `message`.
 *
 * The same function backs Hardhat's `eth_sign` and `personal_sign`, which both prefix the
 * message; raw digests are never signed.
 *
 * @param message - The message bytes (already hex-decoded by the caller).
 * @returns The 32-byte digest.
 */
export function personalMessageDigest(message: Uint8Array): Uint8Array {
  return hexToBytes(eip191Signer._getHash(message));
}

/** The fields of an EIP-7702 authorization that its signature covers. */
export interface AuthorizationRequest {
  chainId: bigint;
  /** The 20-byte address of the code to delegate to. */
  address: Uint8Array;
  nonce: bigint;
}

/** EIP-7702's `MAGIC`, the first byte of an authorization's signed message. */
const AUTHORIZATION_MAGIC = 0x05;

/**
 * Computes the digest an EIP-7702 authority signs: `keccak256(0x05 || rlp([chainId, address,
 * nonce]))`.
 *
 * @param request - The authorization's chain id, address and nonce.
 * @returns The 32-byte digest.
 */
export function authorizationDigest(request: AuthorizationRequest): Uint8Array {
  const encoded = RLP.encode([request.chainId, request.address, request.nonce]);
  const message = new Uint8Array(encoded.length + 1);
  message[0] = AUTHORIZATION_MAGIC;
  message.set(encoded, 1);
  return keccak_256(message);
}

/**
 * Computes the EIP-712 digest of typed data with the encoder Hardhat core uses.
 *
 * @param typedData - The typed data.
 * @returns The 32-byte digest.
 */
export function typedDataDigest(typedData: TypedData): Uint8Array {
  return hexToBytes(sigHash(toEncoderInput(typedData)));
}

/**
 * Checks a typed-data signature with micro-eth-signer's published `verifyTyped`, the function
 * Hardhat itself relies on, so a signature is only returned if Hardhat would accept it.
 *
 * @param signature - `0x`-prefixed `r || s || v` signature.
 * @param typedData - The typed data that was signed.
 * @param address - The expected signer.
 * @returns Whether the signature is valid for `address`.
 */
export function verifyTypedDataSignature(
  signature: string,
  typedData: TypedData,
  address: string,
): boolean {
  return verifyTyped(signature, toEncoderInput(typedData), address);
}

/**
 * Checks a personal-message signature with micro-eth-signer's published EIP-191 verifier.
 *
 * @param signature - `0x`-prefixed `r || s || v` signature.
 * @param message - The message bytes.
 * @param address - The expected signer.
 * @returns Whether the signature is valid for `address`.
 */
export function verifyPersonalMessageSignature(
  signature: string,
  message: Uint8Array,
  address: string,
): boolean {
  return eip191Signer.verify(signature, message, address);
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(
    Buffer.from(
      // Stryker disable next-line StringLiteral: micro-eth-signer returns both digests 0x-prefixed
      hex.startsWith("0x") ? hex.slice(2) : hex,
      "hex",
    ),
  );
}

// The encoder's types are derived from a statically known schema, which RPC requests never have.
// It validates the payload against its own `types` at runtime and throws on any mismatch.
function toEncoderInput(typedData: TypedData): EncoderInput {
  // For a schema known only at run time, the encoder's type says every field is a nested struct.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- schema-derived types, allowed in scripts/type-escapes.json
  return typedData as EncoderInput;
}
