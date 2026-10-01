import { kmsError } from "../errors.ts";

/** Shows a rejected value in an error, cut to a length that cannot flood the output. */
function shown(value: unknown): string {
  const text =
    typeof value === "string" || typeof value === "number" || typeof value === "bigint"
      ? String(value)
      : typeof value;
  return text.length > 66 ? `${text.slice(0, 63)}...` : text;
}

/**
 * Reads a chain id from typed data: a non-negative integer number, a bigint, a `0x` hex string or
 * a decimal string. Values that cannot be read exactly are refused, rather than skipped, so a
 * malformed `chainId` cannot slip past the check.
 *
 * @param value - The value, for example `domain.chainId`.
 * @param what - What the value is, for error messages.
 * @param operation - The operation, for error messages.
 * @returns The chain id, or `undefined` if the value is absent.
 */
export function parseChainId(value: unknown, what: string, operation: string): bigint | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "bigint" && value >= 0n) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
    return BigInt(value);
  }
  throw kmsError(
    `${what} is not a chain id: expected a non-negative integer, got ${shown(value)}`,
    { operation },
  );
}

/**
 * The chain id of one network connection, read with `eth_chainId` once and kept. A failed read
 * is not kept, so the next request retries. When the network config sets `chainId`, the node
 * must report the same one.
 */
export class ConnectionChain {
  readonly #read: () => Promise<unknown>;
  readonly #configured: number | undefined;
  #chainId: Promise<bigint> | undefined;

  /**
   * @param read - Sends `eth_chainId` on the connection.
   * @param configured - The `chainId` from the network config, if any.
   */
  public constructor(read: () => Promise<unknown>, configured: number | undefined) {
    this.#read = read;
    this.#configured = configured;
  }

  /**
   * Returns the connection's chain id.
   *
   * @returns The chain id.
   */
  public async chainId(): Promise<bigint> {
    this.#chainId ??= this.#load().catch((error: unknown) => {
      this.#chainId = undefined;
      throw error;
    });
    return await this.#chainId;
  }

  async #load(): Promise<bigint> {
    const response = await this.#read();
    // The JSON-RPC spec makes eth_chainId a hex quantity.
    if (typeof response !== "string" || !/^0x[0-9a-fA-F]+$/.test(response)) {
      throw kmsError(`the node answered eth_chainId with ${shown(response)}, not a hex quantity`, {
        operation: "eth_chainId",
      });
    }
    const chainId = BigInt(response);
    if (this.#configured !== undefined && BigInt(this.#configured) !== chainId) {
      throw kmsError(
        `the network config sets chainId ${this.#configured}, but the node reports ${chainId}`,
        { operation: "eth_chainId" },
      );
    }
    return chainId;
  }
}
