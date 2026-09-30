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
