// A key's `allowedDelegates` (#562): which contracts the key may delegate its account to with an
// EIP-7702 authorization, per chain. `kms sign-auth`, the library account's `signAuthorization` and
// the self-authorizations of a transaction all check here, before any KMS call.
import { keccak_256 } from "@noble/hashes/sha3.js";

import type { KmsAllowedDelegate, KmsKeyCommonConfig } from "../../types.ts";
import { sameAddress } from "../crypto/address.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError } from "../errors.ts";

/** The zero address: an authorization to it clears the account's delegation. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * What a key's `allowedDelegates` says about one delegate on one chain:
 *
 * - `unrestricted`: the key has no `allowedDelegates`;
 * - `revoke`: the delegate is the zero address, which always passes;
 * - `listed`: an entry allows it. `codeHashes` holds the pinned code hashes the delegate's code
 *   must match one of, and is empty when an entry without `codeHash` matched. `label` is the first
 *   matching entry's label, for messages;
 * - `unlisted`: no entry names the delegate, for any chain;
 * - `wrong-chain`: entries name the delegate, but none for this chain.
 */
export type DelegateMatch =
  | { kind: "unrestricted" }
  | { kind: "revoke" }
  | { kind: "listed"; label: string | undefined; codeHashes: readonly string[] }
  | { kind: "unlisted" }
  | { kind: "wrong-chain" };

/**
 * Whether an entry allows its delegate on a chain. A chain-0 authorization is valid on every chain,
 * so only an entry for every chain allows it; an entry that lists chain ids never does.
 */
function allowsChain(entry: KmsAllowedDelegate, chainId: bigint): boolean {
  if (entry.chains === "all") {
    return true;
  }
  return chainId !== 0n && entry.chains.some((chain) => BigInt(chain) === chainId);
}

/**
 * Matches a delegate against a key's `allowedDelegates`.
 *
 * @param allowed - The key's resolved `allowedDelegates`, or `undefined` when it has none.
 * @param delegate - The delegate address.
 * @param chainId - The authorization's chain id, or `undefined` to match the address only, for any
 * chain.
 * @returns What the list says.
 */
export function matchDelegate(
  allowed: readonly KmsAllowedDelegate[] | undefined,
  delegate: string,
  chainId: bigint | undefined,
): DelegateMatch {
  if (allowed === undefined) {
    return { kind: "unrestricted" };
  }
  if (sameAddress(delegate, ZERO_ADDRESS)) {
    return { kind: "revoke" };
  }
  const named = allowed.filter((entry) => sameAddress(entry.address, delegate));
  if (named.length === 0) {
    return { kind: "unlisted" };
  }
  const matching =
    chainId === undefined ? named : named.filter((entry) => allowsChain(entry, chainId));
  const [first] = matching;
  if (first === undefined) {
    return { kind: "wrong-chain" };
  }
  // One entry without a pin is enough; otherwise the code must match one of the pins.
  const unpinned = matching.find((entry) => entry.codeHash === undefined);
  if (unpinned !== undefined) {
    return { kind: "listed", label: unpinned.label, codeHashes: [] };
  }
  // Stryker disable next-line ArrayDeclaration: every matching entry has a codeHash here, so the fallback is never used
  const codeHashes = matching.flatMap((entry) => entry.codeHash ?? []);
  return { kind: "listed", label: first.label, codeHashes };
}

/** The node the delegate's code is read from, when the caller has one. */
export interface DelegateNode {
  /** The node's chain id. */
  chainId(): Promise<bigint>;
  /** `eth_getCode` for an address, at `latest`. */
  getCode(address: string): Promise<unknown>;
}

/** What {@link checkDelegate} needs besides the delegate and its chain. */
export interface DelegateCheck {
  /** The signing key: its name and its `allowedDelegates`. */
  key: Pick<KmsKeyCommonConfig, "name" | "allowedDelegates">;
  /** The node to read a pinned delegate's code from; `undefined` when there is none. */
  node: DelegateNode | undefined;
  /** Prints a note for the user, such as the chain a chain-0 authorization's code was read on. */
  note: (message: string) => void;
  /** The operation, for error messages. */
  operation: string;
  /**
   * Builds the error for a delegate that no entry allows on the chain. By default the
   * `core.delegate.not-allowed` errors; a transaction's self-authorization names its index.
   */
  refuse?: ((chainId: bigint) => Error) | undefined;
}

/** `0x` hex of whole bytes, as `eth_getCode` answers. */
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;

/**
 * Checks a delegate against the key's `allowedDelegates` and, when its entries pin a code hash,
 * reads the delegate's code and compares its hash. Throws when the list does not allow it. No flag
 * overrides it, and nothing here calls the KMS.
 *
 * For a chain-0 authorization the code is read on the node's chain only, and a note says so: the
 * same address can hold other code on another chain.
 *
 * @param check - The key, the node and how to report.
 * @param delegate - The checksummed delegate address.
 * @param chainId - The authorization's chain id.
 * @returns What the list says, for messages: `unrestricted`, `revoke` or `listed`.
 */
export async function checkDelegate(
  check: DelegateCheck,
  delegate: string,
  chainId: bigint,
): Promise<DelegateMatch> {
  const { key, operation } = check;
  const match = matchDelegate(key.allowedDelegates, delegate, chainId);
  if (match.kind === "unlisted" || match.kind === "wrong-chain") {
    if (check.refuse !== undefined) {
      throw check.refuse(chainId);
    }
    throw chainId === 0n
      ? catalogError(
          ERRORS.delegateNotAllowedChainZero,
          { keyName: key.name, delegate },
          { operation },
        )
      : catalogError(
          ERRORS.delegateNotAllowed,
          { keyName: key.name, delegate, chain: chainId },
          { operation },
        );
  }
  if (match.kind !== "listed" || match.codeHashes.length === 0) {
    return match;
  }
  const { node } = check;
  if (node === undefined) {
    throw catalogError(
      ERRORS.delegateCodeNoNetwork,
      { keyName: key.name, delegate },
      { operation },
    );
  }
  const codeChain = await node.chainId();
  const code = await node.getCode(delegate);
  if (typeof code !== "string" || !HEX_DATA.test(code)) {
    throw catalogError(ERRORS.delegateCodeUnreadable, { delegate }, { operation });
  }
  if (code === "0x") {
    throw catalogError(
      ERRORS.delegateNoCode,
      { delegate, chain: codeChain, keyName: key.name },
      { operation },
    );
  }
  const actual = `0x${Buffer.from(keccak_256(Buffer.from(code.slice(2), "hex"))).toString("hex")}`;
  if (!match.codeHashes.includes(actual)) {
    throw catalogError(
      ERRORS.delegateCodeMismatch,
      { delegate, chain: codeChain, actual, keyName: key.name },
      { operation },
    );
  }
  if (chainId === 0n) {
    check.note(
      `the authorization is for chain 0, valid on every chain: the code hash of ${delegate} was checked on chain ${codeChain} only`,
    );
  }
  return match;
}
