/**
 * The bytes of a request field that `rpcData` from `@nomicfoundation/hardhat-zod-utils` has
 * validated, decoded by the plugin itself (#614).
 *
 * `rpcData` decodes a string with `hexStringToBytes` from its own copy of
 * `@nomicfoundation/hardhat-utils`, and every release of it before 5.1.1 reads `"0x"` as one zero
 * byte. Which copy that is depends on the user's lockfile, not on the plugin's ranges, so the
 * plugin decodes the caller's string again: `"0x"` is then empty whatever copy is installed.
 *
 * @param value - The field as the caller sent it.
 * @param parsed - What `rpcData` made of it, which accepts only `0x` and whole bytes in hex, or a
 *   `Buffer`.
 * @returns The bytes of a string; `parsed` for anything else, such as a `Buffer`.
 */
export function rpcDataBytes(value: unknown, parsed: Uint8Array): Uint8Array {
  return typeof value === "string" ? Uint8Array.from(Buffer.from(value.slice(2), "hex")) : parsed;
}
