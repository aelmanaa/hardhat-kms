// What `kms sign-auth` shows about an EIP-7702 authorization before it signs, and the checks that
// refuse an authorization that cannot apply (#563). Everything here is pure: the task reads the
// node and passes the answers in, so each rule is tested on its own.
import { keccak_256 } from "@noble/hashes/sha3.js";

import { sameAddress, toChecksumAddress } from "../crypto/address.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError } from "../errors.ts";
import { ZERO_ADDRESS } from "../signer/delegates.ts";

/** The ERC-1967 implementation slot: `keccak256("eip1967.proxy.implementation") - 1`. */
export const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** The code an EIP-7702 delegation leaves on an account: `0xef0100 || address`. */
const DELEGATION_PREFIX = "0xef0100";
const DELEGATION_LENGTH = DELEGATION_PREFIX.length + 40;
/**
 * The highest address refused as a precompile. Ethereum's precompiles are 0x01 to 0x11 (Prague)
 * and 0x100 (P256VERIFY, EIP-7951, which rollups ship as RIP-7212), and Arbitrum's are 0x64 to
 * 0xff. No contract can be deployed this low, so the range refuses no real delegate.
 */
const PRECOMPILE_LIMIT = 0x1ffn;

/** What the `--network` node answered, read before the question. */
export interface NodeState {
  /** The network's name, shown so the person knows whose answers these are. */
  network: string;
  /** The account's `eth_getTransactionCount` at `latest`. */
  latest: bigint;
  /** The account's `eth_getTransactionCount` at `pending`. */
  pending: bigint;
  /** The account's `eth_getCode`, `0x` hex. */
  accountCode: string;
  /** The delegate's `eth_getCode`, `0x` hex; `undefined` for the zero address, which is not read. */
  delegateCode: string | undefined;
  /** The delegate's ERC-1967 implementation slot; `undefined` for the zero address. */
  implementationSlot: bigint | undefined;
}

/** Where the authorization's nonce came from. */
type NonceSource = "option" | "node" | "self-broadcast";

/** Everything the question shows. */
export interface AuthorizationReview {
  /** The key's name. */
  keyName: string;
  /** The authority: the key's checksummed address. */
  account: string;
  /** The checksummed delegate. */
  delegate: string;
  /** The delegate's label from the key's `allowedDelegates`, when an entry has one. */
  label: string | undefined;
  chainId: bigint;
  /** The `--network` name; `undefined` with `--chain`. */
  network: string | undefined;
  nonce: bigint;
  nonceSource: NonceSource;
  /** The node's answers; `undefined` with `--chain`, where nothing is read. */
  node: NodeState | undefined;
}

/**
 * Whether an address is a precompile, or in the low range where chains place them. A delegation
 * to a precompile makes every call to the account succeed and do nothing (EIP-7702, Precompiles).
 *
 * @param address - A `0x` address.
 * @returns `true` for 0x01 to 0x1ff; the zero address is a revocation, not a precompile.
 */
export function isPrecompile(address: string): boolean {
  const value = BigInt(address);
  return value !== 0n && value <= PRECOMPILE_LIMIT;
}

/**
 * The address an account's code delegates to, when the code is an EIP-7702 delegation.
 *
 * @param code - `eth_getCode`, `0x` hex.
 * @returns The checksummed delegate, or `undefined` when the code is not exactly `0xef0100 || X`.
 */
export function delegationTarget(code: string): string | undefined {
  const lower = code.toLowerCase();
  if (lower.length !== DELEGATION_LENGTH || !lower.startsWith(DELEGATION_PREFIX)) {
    return undefined;
  }
  return toChecksumAddress(`0x${lower.slice(DELEGATION_PREFIX.length)}`);
}

/**
 * Throws for an authorization that cannot apply, before any sign request:
 *
 * - a nonce below the account's `latest` nonce, which it can never reach again;
 * - a delegate whose own code is a delegation: clients follow one hop only, so every call to the
 *   account would fail (EIP-7702, Loops);
 * - an account whose code is neither empty nor a delegation: nodes skip the tuple (EIP-7702,
 *   Behavior).
 *
 * Nothing is checked without a node.
 *
 * @param review - The authorization and the node's answers.
 * @param operation - The operation, for error messages.
 */
export function refuseUnworkable(review: AuthorizationReview, operation: string): void {
  const { node } = review;
  if (node === undefined) {
    return;
  }
  if (review.nonce < node.latest) {
    throw catalogError(
      ERRORS.authNonceStale,
      { nonce: review.nonce, latest: node.latest, network: node.network },
      { operation },
    );
  }
  if (node.delegateCode?.toLowerCase().startsWith(DELEGATION_PREFIX) === true) {
    throw catalogError(
      ERRORS.authDelegateDelegated,
      { delegate: review.delegate, network: node.network },
      { operation },
    );
  }
  if (node.accountCode !== "0x" && delegationTarget(node.accountCode) === undefined) {
    throw catalogError(
      ERRORS.authAccountHasCode,
      { account: review.account, size: codeSize(node.accountCode), network: node.network },
      { operation },
    );
  }
}

/**
 * The warnings for an authorization that can apply but may not do what the person expects. Each
 * is one line, of fixed wording around checksummed addresses and numbers.
 *
 * @param review - The authorization and the node's answers.
 * @returns The warnings, empty without a node.
 */
export function authorizationWarnings(review: AuthorizationReview): string[] {
  const { node } = review;
  if (node === undefined) {
    return [];
  }
  const warnings: string[] = [];
  const next = review.nonceSource === "self-broadcast" ? node.pending + 1n : node.pending;
  if (review.nonce > next) {
    warnings.push(
      `nonce ${review.nonce} is ahead of the account's next nonce ${next}: the signature stays valid until the account reaches it, and anyone who holds it can submit it then`,
    );
  }
  const revoke = sameAddress(review.delegate, ZERO_ADDRESS);
  const current = delegationTarget(node.accountCode);
  if (!revoke && current !== undefined && !sameAddress(current, review.delegate)) {
    warnings.push(
      `the account is delegated to ${current} now: storage it wrote stays, and the new delegate reads and writes the same slots`,
    );
  }
  if (node.implementationSlot !== undefined && node.implementationSlot !== 0n) {
    warnings.push(
      `the delegate's ERC-1967 implementation slot points to ${slotAddress(node.implementationSlot)}: it looks like a proxy, so its code can change after you sign`,
    );
  }
  if (node.delegateCode === "0x") {
    warnings.push(
      `the delegate has no code on network ${node.network}: check that it is the address for this chain`,
    );
  }
  return warnings;
}

/**
 * The lines the question shows, or the task prints when it does not ask. Node data appears only as
 * numbers, hashes and checksummed addresses, so a crafted answer cannot push the delegate off the
 * screen.
 *
 * @param review - The authorization and the node's answers.
 * @param warnings - From {@link authorizationWarnings}.
 * @returns The lines, without newlines.
 */
export function summaryLines(review: AuthorizationReview, warnings: readonly string[]): string[] {
  const { node } = review;
  const revoke = sameAddress(review.delegate, ZERO_ADDRESS);
  const lines = [
    "[hardhat-kms] EIP-7702 authorization",
    row(
      "action",
      revoke
        ? "REVOKE delegation (account becomes a plain EOA again)"
        : "DELEGATE the account to the code at the delegate",
    ),
    row("account", `${review.account} (key ${review.keyName})`),
    row(
      "delegate",
      revoke
        ? `${review.delegate} (zero address)`
        : review.label === undefined
          ? review.delegate
          : `${review.label} ${review.delegate}`,
    ),
    row("chain", chainText(review)),
    row("nonce", nonceText(review)),
  ];
  if (!revoke) {
    lines.push(row("delegate", `code ${delegateCodeText(node)}`));
  }
  lines.push(
    row("account", accountCodeText(node)),
    row(
      "node",
      node === undefined
        ? "none: with --chain, nothing is read from a node"
        : `network ${node.network}; its answers are not verified`,
    ),
    ...warnings.map((warning) => row("warning", warning)),
    revoke
      ? "This clears the account's delegation until another authorization sets one."
      : "This delegates the account until another authorization replaces it.",
    "It is not undone if the transaction that carries it reverts.",
    "Anyone who holds the signature can submit it.",
  );
  return lines;
}

function row(name: string, value: string): string {
  return `  ${name.padEnd(11)} ${value}`;
}

function chainText(review: AuthorizationReview): string {
  if (review.chainId === 0n) {
    return `ALL CHAINS (chain id 0): valid on every chain where the account's nonce is ${review.nonce}`;
  }
  return review.network === undefined
    ? `${review.chainId} (from --chain)`
    : `${review.network}, ${review.chainId}`;
}

function nonceText(review: AuthorizationReview): string {
  const { node } = review;
  const sponsor =
    review.nonceSource === "self-broadcast"
      ? "yes"
      : review.nonceSource === "node"
        ? "no"
        : "not known (--nonce)";
  if (node === undefined) {
    return `${review.nonce}; account nonce not checked; self-sponsored: ${sponsor}`;
  }
  const pending = node.pending === node.latest ? "" : ` (${node.pending} pending)`;
  return `${review.nonce}; account nonce now ${node.latest}${pending}; self-sponsored: ${sponsor}`;
}

function delegateCodeText(node: NodeState | undefined): string {
  const code = node?.delegateCode;
  if (code === undefined) {
    return "not checked";
  }
  if (code === "0x") {
    return "none";
  }
  const hash = Buffer.from(keccak_256(Buffer.from(code.slice(2), "hex"))).toString("hex");
  return `${codeSize(code).toLocaleString("en-US")} bytes, keccak 0x${hash}`;
}

function accountCodeText(node: NodeState | undefined): string {
  if (node === undefined) {
    return "delegation not checked";
  }
  const current = delegationTarget(node.accountCode);
  return current === undefined ? "now not delegated" : `now delegated to ${current}`;
}

function codeSize(code: string): number {
  return (code.length - 2) / 2;
}

/** The address in the low 20 bytes of a storage word, as ERC-1967 stores it. */
function slotAddress(value: bigint): string {
  const low = value & ((1n << 160n) - 1n);
  return toChecksumAddress(`0x${low.toString(16).padStart(40, "0")}`);
}
