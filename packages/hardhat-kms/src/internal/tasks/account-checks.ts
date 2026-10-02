import { randomBytes } from "node:crypto";

import { ERRORS } from "../error-catalog.ts";
import { catalogError } from "../errors.ts";

/** How many random bytes the `--check-sign` message carries. */
const CHECK_SIGN_RANDOM_BYTES = 32;
/** Wei in one ether. */
const WEI_PER_ETHER = 10n ** 18n;
/** The longest node answer an error shows. */
const MAX_SHOWN_LENGTH = 66;

/**
 * The EIP-191 message `kms accounts --check-sign` asks a key to sign: a fixed prefix and 32 fresh
 * random bytes, so the signature authorizes nothing and is never the same twice.
 *
 * @param random - The random bytes; a fresh 32 by default.
 * @returns The message, as UTF-8 bytes.
 */
export function checkSignMessage(
  random: Uint8Array = randomBytes(CHECK_SIGN_RANDOM_BYTES),
): Uint8Array {
  return new TextEncoder().encode(`hardhat-kms check-sign ${Buffer.from(random).toString("hex")}`);
}

/**
 * Reads a node's answer to `eth_getBalance`, which the JSON-RPC spec makes a hex quantity.
 *
 * @param answer - What the node returned.
 * @returns The balance in wei.
 */
export function parseBalance(answer: unknown): bigint {
  if (typeof answer !== "string" || !/^0x[0-9a-fA-F]+$/.test(answer)) {
    const text = typeof answer === "string" ? answer : typeof answer;
    const shown =
      text.length > MAX_SHOWN_LENGTH ? `${text.slice(0, MAX_SHOWN_LENGTH - 3)}...` : text;
    throw catalogError(ERRORS.balanceNotHex, { answer: shown }, { operation: "eth_getBalance" });
  }
  return BigInt(answer);
}

/**
 * Writes a wei amount in ether, with every significant decimal and no trailing zeros, such as
 * `1.5` or `0.000000000000000001`.
 *
 * @param wei - The amount in wei, not negative.
 * @returns The amount in ether.
 */
export function formatEther(wei: bigint): string {
  const whole = wei / WEI_PER_ETHER;
  const fraction = (wei % WEI_PER_ETHER).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}
