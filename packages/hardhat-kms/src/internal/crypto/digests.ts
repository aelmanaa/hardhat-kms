import { eip191Signer, verifyTyped } from "micro-eth-signer";

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
 * @param value - The payload, for example the parsed `eth_signTypedData_v4` param.
 * @returns The same value, typed.
 * @throws {InvalidTypedDataError} If the shape is wrong or the encoder rejects it.
 */
export function parseTypedData(value: unknown): TypedData {
  if (!isRecord(value)) {
    throw new InvalidTypedDataError("the typed data must be an object");
  }
  const { types, primaryType, domain, message } = value;
  if (!isRecord(types)) {
    throw new InvalidTypedDataError("`types` must map each type name to a list of {name, type}");
  }
  const entries: [string, { name: string; type: string }[]][] = [];
  for (const [name, fields] of Object.entries(types)) {
    if (!Array.isArray(fields) || !fields.every(isField)) {
      throw new InvalidTypedDataError(`\`types.${name}\` must be a list of {name, type}`);
    }
    entries.push([name, fields]);
  }
  if (typeof primaryType !== "string" || !isRecord(domain) || !isRecord(message)) {
    throw new InvalidTypedDataError(
      "the typed data needs a string `primaryType` and object `domain` and `message`",
    );
  }
  // fromEntries defines own properties, so a type named `__proto__` cannot reach the prototype.
  const typedFields: TypedData["types"] = Object.fromEntries(entries);
  const typedData: TypedData = { types: typedFields, primaryType, domain, message };
  try {
    typedDataDigest(typedData);
  } catch (error) {
    throw new InvalidTypedDataError(error instanceof Error ? error.message : String(error));
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
  return new Uint8Array(Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex"));
}

// The encoder's types are derived from a statically known schema, which RPC requests never have.
// It validates the payload against its own `types` at runtime and throws on any mismatch.
function toEncoderInput(typedData: TypedData): EncoderInput {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated by the encoder
  return typedData as EncoderInput;
}
