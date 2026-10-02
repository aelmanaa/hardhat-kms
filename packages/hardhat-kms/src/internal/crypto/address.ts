import { addr } from "micro-eth-signer";

import { ERRORS } from "../error-catalog.ts";
import { catalogMessage } from "../errors.ts";
import { assertOnCurve } from "./public-key.ts";

/**
 * Derives the checksummed Ethereum address of an uncompressed secp256k1 public key.
 *
 * @param publicKey - The 65-byte uncompressed public key.
 * @returns The EIP-55 checksummed address.
 */
export function addressFromPublicKey(publicKey: Uint8Array): string {
  return addr.fromPublicKey(assertOnCurve(publicKey));
}

/**
 * Compares two Ethereum addresses case-insensitively.
 *
 * @param a - First address, with `0x` prefix.
 * @param b - Second address, with `0x` prefix.
 * @returns Whether both refer to the same account.
 */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Thrown when a configured or provider-returned address is malformed or fails its checksum. */
export class InvalidAddressError extends Error {
  public override name = "InvalidAddressError";
}

/**
 * Validates an Ethereum address and returns its EIP-55 checksummed form.
 *
 * All-lowercase and all-uppercase addresses are accepted as unchecksummed. A mixed-case address
 * must carry a valid EIP-55 checksum, since a wrong one usually means a typo.
 *
 * @param address - The address, with `0x` prefix.
 * @returns The checksummed address.
 * @throws {InvalidAddressError} If the address is malformed or its checksum is wrong.
 */
export function toChecksumAddress(address: string): string {
  // Stryker disable next-line Regex: addr.isValid is anchored, so it refuses text around an address
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !addr.isValid(address)) {
    throw new InvalidAddressError(catalogMessage(ERRORS.invalidAddress, { address }));
  }
  return addr.addChecksum(address);
}
