/*
 * A strict RLP decoder, for reading the signed transaction Turnkey returns. It accepts only the
 * canonical encoding of the Ethereum Yellow Paper, appendix B: a single byte below 0x80 is its own
 * encoding, a length of at most 55 is in the short form, a long-form length has no leading zero,
 * and the input holds exactly one item with nothing after it. Anything else is refused, so two
 * items are equal exactly when their encodings are equal.
 *
 * The package has no runtime dependency, and the core does not export its RLP coder, so the plugin
 * decodes with this one.
 */

/** An RLP item, with the bytes that encode it. */
export type RlpItem =
  | { kind: "bytes"; value: Uint8Array; encoded: Uint8Array }
  | { kind: "list"; items: RlpItem[]; encoded: Uint8Array };

/**
 * How many lists may nest inside the outer one. A transaction nests 3 deep: the access list, an
 * entry, its storage keys.
 */
export const MAX_DEPTH = 8;

/** A header: whether the item is a list, where its payload starts and how long it is. */
interface Header {
  list: boolean;
  start: number;
  length: number;
}

/** Reads the header at `offset`, or `undefined` when it is not canonical or runs past the end. */
function readHeader(bytes: Uint8Array, offset: number): Header | undefined {
  const prefix = bytes[offset];
  if (prefix === undefined) {
    return undefined;
  }
  if (prefix < 0x80) {
    return { list: false, start: offset, length: 1 };
  }
  const list = prefix >= 0xc0;
  const short = prefix - (list ? 0xc0 : 0x80);
  if (short <= 55) {
    // One byte below 0x80 is its own encoding, never 0x81 and the byte.
    const only = bytes[offset + 1];
    if (!list && short === 1 && only !== undefined && only < 0x80) {
      return undefined;
    }
    return { list, start: offset + 1, length: short };
  }
  // The long form: the next `short - 55` bytes give the length, big-endian.
  const lengthBytes = short - 55;
  let length = 0;
  for (let index = 1; index <= lengthBytes; index++) {
    const byte = bytes[offset + index];
    if (byte === undefined || (index === 1 && byte === 0)) {
      return undefined;
    }
    // At most 8 bytes: a length past 2^53 loses precision but still runs past the end.
    length = length * 256 + byte;
  }
  if (length <= 55) {
    return undefined;
  }
  return { list, start: offset + 1 + lengthBytes, length };
}

/** Reads the item at `offset` of `bytes`, which ends where its parent ends. */
function readItem(
  bytes: Uint8Array,
  offset: number,
  depth: number,
): { item: RlpItem; end: number } | undefined {
  const header = readHeader(bytes, offset);
  if (header === undefined) {
    return undefined;
  }
  const end = header.start + header.length;
  if (end > bytes.length) {
    return undefined;
  }
  const encoded = bytes.subarray(offset, end);
  if (!header.list) {
    return { item: { kind: "bytes", value: bytes.subarray(header.start, end), encoded }, end };
  }
  if (depth > MAX_DEPTH) {
    return undefined;
  }
  const items: RlpItem[] = [];
  const payload = bytes.subarray(0, end);
  let cursor = header.start;
  while (cursor < end) {
    const child = readItem(payload, cursor, depth + 1);
    if (child === undefined) {
      return undefined;
    }
    items.push(child.item);
    cursor = child.end;
  }
  return { item: { kind: "list", items, encoded }, end };
}

/**
 * Decodes one canonical RLP item that fills the input.
 *
 * @param bytes - The encoding.
 * @returns The item, or `undefined` when the input is not exactly one canonical item.
 */
export function decodeRlp(bytes: Uint8Array): RlpItem | undefined {
  const read = readItem(bytes, 0, 0);
  return read?.end === bytes.length ? read.item : undefined;
}

/**
 * Reads an RLP byte string as a canonical unsigned integer: big-endian, without a leading zero
 * byte, and zero as the empty string.
 *
 * @param item - The item.
 * @param maxBytes - The most bytes the integer may have.
 * @returns The integer, or `undefined` when the item is a list, too long or not canonical.
 */
export function rlpInteger(item: RlpItem | undefined, maxBytes: number): bigint | undefined {
  if (item?.kind !== "bytes" || item.value.length > maxBytes || item.value[0] === 0) {
    return undefined;
  }
  let value = 0n;
  for (const byte of item.value) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}
