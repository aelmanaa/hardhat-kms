import { InvalidTypedDataError, parseTypedData, type TypedData } from "../crypto/digests.ts";
import { coreDebug } from "../debug.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError, catalogMessage, errorName } from "../errors.ts";
import { parseChainId } from "./chain-id.ts";

const log = coreDebug("rpc");

/**
 * Reads typed data from a request: a JSON string or an already parsed value. `eth_signTypedData_v4`
 * and `kms sign --data` both read it here.
 *
 * @param data - The typed data, as JSON text or a value.
 * @param operation - The operation, for error messages.
 * @returns A private, checked copy of the typed data.
 */
export function readTypedData(data: unknown, operation: string): TypedData {
  let typedData: unknown = data;
  if (typeof data === "string") {
    try {
      typedData = JSON.parse(data, refuseUnsafeIntegers);
    } catch (error) {
      if (error instanceof InvalidTypedDataError) {
        throw catalogError(ERRORS.typedDataInvalid, { reason: error.message }, { operation });
      }
      if (error instanceof SyntaxError) {
        throw catalogError(ERRORS.typedDataNotJson, {}, { operation });
      }
      // Not a syntax error: JSON.parse with a reviver recurses, so deep nesting overflows the
      // stack with a RangeError.
      throw catalogError(
        ERRORS.typedDataUnreadable,
        { errorName: errorName(error) },
        { operation },
      );
    }
  }
  try {
    return parseTypedData(typedData);
  } catch (error) {
    if (!(error instanceof InvalidTypedDataError)) {
      throw error;
    }
    // Our own message about the user's typed data: safe to show, and the user's to fix.
    throw catalogError(ERRORS.typedDataInvalid, { reason: error.message }, { operation });
  }
}

/**
 * A `JSON.parse` reviver that refuses integers JSON numbers cannot hold exactly. `JSON.parse`
 * rounds them silently, so a `uint256` amount or a large chain id would be signed with another
 * value than the one written.
 */
function refuseUnsafeIntegers(key: string, value: unknown): unknown {
  // Number.isInteger is false for anything but a number.
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    // The key, never the value: this runs before any shape check, so the file may be another
    // one given by mistake, and the number part of a secret.
    const where = key === "" ? "at the top level" : `at key ${JSON.stringify(key.slice(0, 40))}`;
    throw new InvalidTypedDataError(catalogMessage(ERRORS.typedDataUnsafeInteger, { where }));
  }
  return value;
}

/** The chain that typed data's `domain.chainId` must equal. */
export interface ExpectedChain {
  chainId: bigint;
  /** How errors name it, for example `this network` or `--chain`. */
  name: string;
}

/** What the typed-data chain check needs. */
export interface TypedDataChainPolicy {
  /** The operation, for error messages. */
  operation: string;
  /** Sign typed data for any chain. */
  allowCrossChain: boolean;
  /**
   * Returns the chain to compare with. Called only when the domain names a chain and cross-chain
   * signing is not allowed; it may throw when there is no chain to compare with.
   */
  expectedChain(domainChain: bigint): Promise<ExpectedChain>;
  /** The error for a mismatch, which ends with how to sign for another chain. */
  mismatch: typeof ERRORS.typedDataChainMismatchNetwork | typeof ERRORS.typedDataChainMismatchTask;
}

/**
 * Refuses typed data for another chain than the expected one, unless cross-chain signing is
 * allowed (decision 0011). Typed data without `domain.chainId` is signed, as MetaMask, Hardhat
 * and Foundry do: it is valid EIP-712, and off-chain and cross-chain schemes rely on it.
 *
 * @param typedData - The typed data, from {@link readTypedData}.
 * @param policy - The chain to compare with and whether to compare at all.
 */
export async function checkTypedDataChain(
  typedData: TypedData,
  policy: TypedDataChainPolicy,
): Promise<void> {
  const domainChain = parseChainId(typedData.domain.chainId, "domain.chainId", policy.operation);
  if (domainChain === undefined) {
    log("typed data without domain.chainId: the signature is valid on every chain");
    return;
  }
  if (policy.allowCrossChain) {
    return;
  }
  const expected = await policy.expectedChain(domainChain);
  if (domainChain !== expected.chainId) {
    throw catalogError(
      policy.mismatch,
      { domainChain, name: expected.name, chainId: expected.chainId },
      { operation: policy.operation },
    );
  }
}
