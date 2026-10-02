// CRC-32C (Castagnoli, reflected polynomial 0x82F63B78), used by GCP Cloud KMS to protect
// digests and signatures in transit. Node's zlib only provides CRC-32 (a different polynomial).

const TABLE = (() => {
  const table = new Uint32Array(256);
  // Stryker disable next-line EqualityOperator: a Uint32Array drops the extra write to table[256]
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Computes the CRC-32C checksum of `bytes`.
 *
 * @param bytes - The data to checksum.
 * @returns The checksum as an unsigned 32-bit integer.
 */
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
