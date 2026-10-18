import type { TypedData } from "hardhat-kms/types";

/*
 * The `parameters` of Turnkey's `sign_raw_payload` activity for each adapter method. Turnkey's
 * `v1SignRawPayloadIntentV2` (https://docs.turnkey.com/api-reference/activities/sign-raw-payload,
 * and `@turnkey/http` 6.7.0's generated `public_api.types.d.ts`) takes `signWith`, `payload`,
 * `encoding` and `hashFunction`.
 *
 * - A digest: `PAYLOAD_ENCODING_HEXADECIMAL` with `HASH_FUNCTION_NO_OP`, so Turnkey signs the 32
 *   bytes as given. alloy's Turnkey signer sends the same, with the hex unprefixed
 *   (`crates/signer-turnkey/src/signer.rs`, `payload: hex::encode(hash)`).
 * - A message: the EIP-191 preimage with `HASH_FUNCTION_KECCAK256`, so Turnkey hashes it and its
 *   activity record holds the message itself.
 * - Typed data: the serialized typed data with `PAYLOAD_ENCODING_EIP712` and `HASH_FUNCTION_NO_OP`.
 *   Turnkey hashes it and its policies see `eth.eip_712`
 *   (https://docs.turnkey.com/features/networks/ethereum#eip-712). The JSON has the form viem's
 *   `serializeTypedData` gives it, which `@turnkey/viem` 0.14.46 sends.
 */

/** The parameters the three methods differ in. */
export interface PayloadParameters {
  payload: string;
  encoding: "PAYLOAD_ENCODING_HEXADECIMAL" | "PAYLOAD_ENCODING_EIP712";
  hashFunction: "HASH_FUNCTION_NO_OP" | "HASH_FUNCTION_KECCAK256";
}

/**
 * The parameters for a 32-byte digest.
 *
 * @param digest - The digest.
 * @returns The parameters.
 */
export function digestPayload(digest: Uint8Array): PayloadParameters {
  return {
    payload: Buffer.from(digest).toString("hex"),
    encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
    hashFunction: "HASH_FUNCTION_NO_OP",
  };
}

/**
 * The parameters for an EIP-191 personal message: `"\x19Ethereum Signed Message:\n"`, the
 * message's length in bytes as decimal text, then the message.
 *
 * @param message - The message bytes, without the prefix.
 * @returns The parameters.
 */
export function messagePayload(message: Uint8Array): PayloadParameters {
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`);
  return {
    payload: Buffer.concat([prefix, message]).toString("hex"),
    encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
    hashFunction: "HASH_FUNCTION_KECCAK256",
  };
}

/** EIP-712's domain fields, in the order the domain type lists them. */
const DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
] as const;

/**
 * The parameters for EIP-712 typed data. When `types` has no `EIP712Domain`, it gets one from the
 * domain's fields, in EIP-712's order, as viem's `serializeTypedData` and the plugin's encoder
 * both derive it. Big integers become decimal strings, as viem writes them.
 *
 * @param typedData - The typed data; the core already checked and hashed it.
 * @returns The parameters.
 */
export function typedDataPayload(typedData: TypedData): PayloadParameters {
  const { domain, message, primaryType, types } = typedData;
  // The request's own EIP712Domain, when it has one, replaces the derived one. The core refuses a
  // domain field set to `undefined` before it calls the adapter.
  const allTypes = {
    EIP712Domain: DOMAIN_FIELDS.filter(({ name }) => Object.hasOwn(domain, name)),
    ...types,
  };
  const payload = JSON.stringify(
    { domain, message, primaryType, types: allTypes },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
  return { payload, encoding: "PAYLOAD_ENCODING_EIP712", hashFunction: "HASH_FUNCTION_NO_OP" };
}
