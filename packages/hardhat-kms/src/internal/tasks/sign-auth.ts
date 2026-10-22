import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { NetworkConnection } from "hardhat/types/network";
import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { addressFromPublicKey, sameAddress, toChecksumAddress } from "../crypto/address.ts";
import { authorizationDigest } from "../crypto/digests.ts";
import { recoverPublicKey, toLowS } from "../crypto/signature.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError } from "../errors.ts";
import { ConnectionChain, parseChainId } from "../rpc/chain-id.ts";
import { checkDelegate, matchDelegate, ZERO_ADDRESS } from "../signer/delegates.ts";
import {
  type AuthorizationReview,
  authorizationWarnings,
  ERC1967_IMPLEMENTATION_SLOT,
  isPrecompile,
  type NodeState,
  refuseUnworkable,
  summaryLines,
} from "./auth-review.ts";
import { confirm, processTerminal, type Terminal } from "./confirm.ts";
import { findTaskKey, printLine, printNote, refuseListBypass, withTaskSigners } from "./keys.ts";

/** The arguments of `kms sign-auth`. */
interface SignAuthArguments {
  key: string;
  delegate: string;
  chain: string | undefined;
  nonce: string | undefined;
  selfBroadcast: boolean;
  force: boolean;
  yes: boolean;
}

/**
 * A signed EIP-7702 authorization, in the form an `eth_sendTransaction` `authorizationList` entry
 * takes in Hardhat: every number a `0x` hex quantity, `r` and `s` 32 bytes each.
 */
interface SignedAuthorization {
  chainId: string;
  address: string;
  nonce: string;
  yParity: string;
  r: string;
  s: string;
}

const OPERATION = "kms sign-auth";
/** EIP-7702 refuses an authorization whose nonce is 2^64 - 1 or more. */
const NONCE_LIMIT = 2n ** 64n - 1n;
/** EIP-2681: an account's nonce is below 2^64. */
const ACCOUNT_NONCE_LIMIT = 2n ** 64n;
/** EIP-7702 encodes the chain id as a 256-bit integer. */
const CHAIN_ID_LIMIT = 2n ** 256n;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
/** `0x` hex of whole bytes, as `eth_getCode` answers. */
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
/** A storage word, as `eth_getStorageAt` answers; some nodes drop leading zeros. */
const HEX_WORD = /^0x[0-9a-fA-F]{0,64}$/;

/** What the command line asks for, checked before any KMS call. */
interface AuthorizationInputs {
  delegate: string;
  chain: bigint | undefined;
  nonce: bigint | undefined;
  /** The `--network` name, when one was given. */
  network: string | undefined;
}

/**
 * Builds the action of `kms sign-auth <key> <delegate>`, which signs an EIP-7702 authorization
 * that delegates the key's account to `delegate`, and prints it as the JSON tuple
 * `eth_sendTransaction` takes in its `authorizationList`. Before the KMS signs, the task shows
 * what the authorization does and, at a terminal, asks; it refuses an authorization that cannot
 * apply (decision 0023). The tuple must recover to the key before it is printed.
 *
 * @param terminal - Where to ask; tests pass another terminal.
 * @returns The task action, which returns the signed authorization.
 */
export function signAuthAction(
  terminal: () => Terminal = processTerminal,
): NewTaskActionFunction<SignAuthArguments> {
  return async (args, hre) => await kmsSignAuth(args, hre, terminal());
}

const kmsSignAuthAction: NewTaskActionFunction<SignAuthArguments> = signAuthAction();

export default kmsSignAuthAction;

async function kmsSignAuth(
  args: SignAuthArguments,
  hre: HardhatRuntimeEnvironment,
  terminal: Terminal,
): Promise<SignedAuthorization> {
  const key = findTaskKey(hre, args.key);
  const inputs = readInputs(args, hre);
  const revoke = sameAddress(inputs.delegate, ZERO_ADDRESS);
  // Without a terminal nobody can be asked, so the config must name the delegate and the run must
  // pass --yes. Decided before the connection opens, since its network hook can call the KMS. A
  // key without allowedDelegates, such as a --kms key, names none; the zero address always passes.
  if (!terminal.interactive) {
    if (!args.yes) {
      throw catalogError(ERRORS.authNoTerminal, {}, { operation: OPERATION });
    }
    if (key.allowedDelegates === undefined && !revoke) {
      throw catalogError(
        ERRORS.authNotListedNoTerminal,
        { name: key.name },
        { operation: OPERATION },
      );
    }
  }
  const configured = configuredChain(hre, inputs.network);
  // Chain 0 from --chain or the config is refused before the connection opens; a node that
  // reports chain 0 is refused below.
  const knownChain = inputs.chain ?? (configured === undefined ? undefined : BigInt(configured));
  if (knownChain === 0n && !args.force) {
    throw catalogError(ERRORS.authChainZero, {}, { operation: OPERATION });
  }
  // The allowlist first (#562). With --network the chain may need the connection, which can call
  // the KMS, so the delegate is matched before it opens: against the config's chainId when it
  // sets one, else against every chain.
  if (inputs.network !== undefined) {
    const early = matchDelegate(
      key.allowedDelegates,
      inputs.delegate,
      configured === undefined ? undefined : BigInt(configured),
    );
    if (configured !== undefined && (early.kind === "unlisted" || early.kind === "wrong-chain")) {
      // Throws the error for this chain; no node is needed to refuse.
      await checkDelegate(
        { key, node: undefined, note: printNote, operation: OPERATION },
        inputs.delegate,
        BigInt(configured),
      );
    }
    if (early.kind === "unlisted") {
      throw catalogError(
        ERRORS.delegateNotListedNetwork,
        { keyName: key.name, delegate: inputs.delegate, network: inputs.network },
        { operation: OPERATION },
      );
    }
  }
  // A --kms key has no list: refused when it is a config key that has one.
  if (!revoke) {
    await refuseListBypass(hre, key, OPERATION);
  }
  let connection: Promise<NetworkConnection> | undefined;
  const connect = async (): Promise<NetworkConnection> =>
    await (connection ??= hre.network.create());
  // One read per address: the code the pin check hashes is the code the question shows.
  const codes = new Map<string, Promise<string>>();
  const codeOf = async (address: string): Promise<string> => {
    let code = codes.get(address);
    if (code === undefined) {
      code = connect().then(async (opened) => await readCode(opened, address));
      codes.set(address, code);
    }
    return await code;
  };
  try {
    // With --network the task reads the node anyway, so the node's chain is always checked
    // against the config's.
    const chainId = inputs.chain ?? (await networkChain(await connect(), configured));
    if (chainId >= CHAIN_ID_LIMIT) {
      // Only a node can report one: --chain is bounded in readInputs.
      throw catalogError(ERRORS.authNodeChainTooLarge, {}, { operation: OPERATION });
    }
    // No flag overrides the list, not even --yes. A pinned code hash is read from the --network
    // node; with --chain there is none, so a pinned delegate is refused.
    const network = inputs.network;
    const allowed = await checkDelegate(
      {
        key,
        node:
          network === undefined
            ? undefined
            : {
                chainId: async () => chainId,
                getCode: codeOf,
              },
        note: printNote,
        operation: OPERATION,
      },
      inputs.delegate,
      chainId,
    );
    if (chainId === 0n && !args.force) {
      throw catalogError(ERRORS.authChainZero, {}, { operation: OPERATION });
    }
    // --yes skips the question only for a delegate the config names, or the zero address. A key
    // without allowedDelegates returns "unrestricted", which is not a listing.
    const configApproves = allowed.kind === "listed" || revoke;
    const { authorization, nonce: signedNonce } = await withTaskSigners(hre, async (signerFor) => {
      const signer = await signerFor(key);
      // A pinned key shows its pin, so a declined question makes no KMS call. Signing checks the
      // pin, and the tuple is checked against the signer's address below.
      const account = key.address ?? (await signer.getAddress());
      if (!revoke) {
        await refuseListBypass(hre, key, OPERATION, account);
      }
      const node =
        network === undefined
          ? undefined
          : await readNode(await connect(), network, account, inputs.delegate, revoke, codeOf);
      const nonce = chooseNonce(inputs.nonce, node, args.selfBroadcast);
      if (nonce >= NONCE_LIMIT) {
        throw catalogError(ERRORS.authNonceTooLarge, { nonce }, { operation: OPERATION });
      }
      const review: AuthorizationReview = {
        keyName: key.name,
        account,
        delegate: inputs.delegate,
        label: allowed.kind === "listed" ? allowed.label : undefined,
        chainId,
        network,
        nonce,
        nonceSource:
          inputs.nonce !== undefined ? "option" : args.selfBroadcast ? "self-broadcast" : "node",
        node,
      };
      refuseUnworkable(review, OPERATION);
      const lines = summaryLines(review, authorizationWarnings(review));
      await approve(hre, terminal, lines, args.yes, configApproves, key.name);
      const delegate = hexBytes(inputs.delegate);
      const signature = await signer.signDigest(
        authorizationDigest({ chainId, address: delegate, nonce }),
      );
      const signed: SignedAuthorization = {
        chainId: quantity(chainId),
        address: inputs.delegate,
        nonce: quantity(nonce),
        yParity: quantity(BigInt(signature.yParity)),
        r: word(signature.r),
        s: word(signature.s),
      };
      // Decision 0004: nothing is printed unless it recovers to the key. The check reads the
      // tuple as printed, so it also covers the step from signature to output.
      if (!recoversTo(signed, await signer.getAddress())) {
        throw catalogError(ERRORS.authNoRecovery, {}, { operation: OPERATION });
      }
      return { authorization: signed, nonce };
    });
    if (args.selfBroadcast) {
      printNote(
        `the authorization uses nonce ${signedNonce}: send it in a transaction from this key with nonce ${signedNonce - 1n}`,
      );
    }
    printLine(JSON.stringify(authorization));
    return authorization;
  } finally {
    // A connection that failed to open has nothing to close, and its error is already thrown.
    const opened = await connection?.catch(() => undefined);
    await opened?.close();
  }
}

/**
 * Shows the summary and, unless the config and `--yes` approve, asks at the terminal (decision
 * 0023). Without a terminal it signs only when both approve.
 */
async function approve(
  hre: HardhatRuntimeEnvironment,
  terminal: Terminal,
  lines: readonly string[],
  yes: boolean,
  configApproves: boolean,
  keyName: string,
): Promise<void> {
  // The caller refuses these before it connects; checked again here, next to the decision.
  if (!terminal.interactive && !yes) {
    throw catalogError(ERRORS.authNoTerminal, {}, { operation: OPERATION });
  }
  if (!terminal.interactive && !configApproves) {
    throw catalogError(ERRORS.authNotListedNoTerminal, { name: keyName }, { operation: OPERATION });
  }
  if (yes && configApproves) {
    process.stderr.write(lines.map((line) => `${line}\n`).join(""));
    return;
  }
  if (yes) {
    // Only a key without allowedDelegates gets here with --yes: the list refuses what it does not
    // name, and --yes skips the question for what it does.
    printNote(`--yes does not skip the question: key "${keyName}" has no allowedDelegates`);
  }
  const agreed = await hre.interruptions.uninterrupted(async () => await confirm(terminal, lines));
  if (!agreed) {
    throw catalogError(ERRORS.authDeclined, {}, { operation: OPERATION });
  }
}

function readInputs(args: SignAuthArguments, hre: HardhatRuntimeEnvironment): AuthorizationInputs {
  const network = hre.globalOptions.network;
  if (args.chain !== undefined && network !== undefined) {
    // Hardhat does not say whether --network came from the command line or HARDHAT_NETWORK.
    throw catalogError(ERRORS.authChainAndNetwork, {}, { operation: OPERATION });
  }
  if (args.chain === undefined && network === undefined) {
    throw catalogError(ERRORS.authNoChain, {}, { operation: OPERATION });
  }
  if (args.nonce !== undefined && args.selfBroadcast) {
    // As in cast: --self-broadcast only changes the nonce the task reads.
    throw catalogError(ERRORS.authNonceAndSelfBroadcast, {}, { operation: OPERATION });
  }
  if (args.nonce === undefined && network === undefined) {
    throw catalogError(ERRORS.authNoNonce, {}, { operation: OPERATION });
  }
  const chain = parseChainId(args.chain, "--chain", OPERATION);
  if (chain !== undefined && chain >= CHAIN_ID_LIMIT) {
    throw catalogError(ERRORS.authChainTooLarge, {}, { operation: OPERATION });
  }
  const delegate = checksummed(args.delegate);
  if (isPrecompile(delegate)) {
    throw catalogError(ERRORS.authDelegatePrecompile, { delegate }, { operation: OPERATION });
  }
  return { delegate, chain, nonce: parseNonce(args.nonce), network };
}

function checksummed(delegate: string): string {
  try {
    return toChecksumAddress(delegate);
  } catch {
    // toChecksumAddress throws only InvalidAddressError.
    throw catalogError(
      ERRORS.authDelegateInvalid,
      { delegate: delegate.slice(0, 64) },
      { operation: OPERATION },
    );
  }
}

function parseNonce(value: string | undefined): bigint | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
    throw catalogError(
      ERRORS.authNonceInvalid,
      { value: value.slice(0, 64) },
      { operation: OPERATION },
    );
  }
  return BigInt(value);
}

function configuredChain(
  hre: HardhatRuntimeEnvironment,
  network: string | undefined,
): number | undefined {
  return network === undefined ? undefined : hre.config.networks[network]?.chainId;
}

/** The node's `eth_chainId`, which must equal the config's `chainId` when it sets one. */
async function networkChain(
  connection: NetworkConnection,
  configured: number | undefined,
): Promise<bigint> {
  const chain = new ConnectionChain(async () => {
    const response: unknown = await connection.provider.request({ method: "eth_chainId" });
    return response;
  }, configured);
  return await chain.chainId();
}

/**
 * The nonce to sign: `--nonce`, else the account's pending nonce from the node, plus one with
 * `--self-broadcast`: the transaction that carries the authorization is then from the same account
 * and uses that nonce first.
 */
function chooseNonce(
  option: bigint | undefined,
  node: NodeState | undefined,
  selfBroadcast: boolean,
): bigint {
  if (option !== undefined) {
    return option;
  }
  if (node === undefined) {
    // readInputs refuses this first; kept so the nonce never defaults.
    throw catalogError(ERRORS.authNoNonce, {}, { operation: OPERATION });
  }
  return selfBroadcast ? node.pending + 1n : node.pending;
}

/**
 * Reads what the question shows from the `--network` node: the account's nonce at `latest` and
 * `pending`, the account's code, and, unless the delegate is the zero address, the delegate's code
 * and ERC-1967 implementation slot. Every answer is checked for its shape; none is trusted for its
 * content, since the node can lie.
 */
async function readNode(
  connection: NetworkConnection,
  network: string,
  account: string,
  delegate: string,
  revoke: boolean,
  codeOf: (address: string) => Promise<string>,
): Promise<NodeState> {
  const latest = await readCount(connection, account, "latest");
  const pending = await readCount(connection, account, "pending");
  const accountCode = await codeOf(account);
  if (revoke) {
    return {
      network,
      latest,
      pending,
      accountCode,
      delegateCode: undefined,
      implementationSlot: undefined,
    };
  }
  const delegateCode = await codeOf(delegate);
  const slot: unknown = await connection.provider.request({
    method: "eth_getStorageAt",
    params: [delegate, ERC1967_IMPLEMENTATION_SLOT, "latest"],
  });
  if (typeof slot !== "string" || !HEX_WORD.test(slot)) {
    throw catalogError(ERRORS.authNodeStorage, {}, { operation: OPERATION });
  }
  return {
    network,
    latest,
    pending,
    accountCode,
    delegateCode,
    implementationSlot: BigInt(slot === "0x" ? "0x0" : slot),
  };
}

/** The account's `eth_getTransactionCount` at a block tag. */
async function readCount(
  connection: NetworkConnection,
  account: string,
  tag: "latest" | "pending",
): Promise<bigint> {
  const response: unknown = await connection.provider.request({
    method: "eth_getTransactionCount",
    params: [account, tag],
  });
  // An account nonce stays below 2^64 (EIP-2681). A larger answer is refused, so a crafted one
  // cannot stretch the question's nonce line.
  if (
    typeof response !== "string" ||
    !HEX_QUANTITY.test(response) ||
    BigInt(response) >= ACCOUNT_NONCE_LIMIT
  ) {
    throw catalogError(ERRORS.authNodeNonce, {}, { operation: OPERATION });
  }
  return BigInt(response);
}

/** An address's code on the `--network` node, at `latest`, in lowercase `0x` hex. */
async function readCode(connection: NetworkConnection, address: string): Promise<string> {
  const code: unknown = await connection.provider.request({
    method: "eth_getCode",
    params: [address, "latest"],
  });
  if (typeof code !== "string" || !HEX_DATA.test(code)) {
    throw catalogError(ERRORS.authNodeCode, {}, { operation: OPERATION });
  }
  return code.toLowerCase();
}

/** Whether a signed authorization, read back from its printed fields, recovers to `address`. */
function recoversTo(authorization: SignedAuthorization, address: string): boolean {
  const yParity = BigInt(authorization.yParity);
  const r = BigInt(authorization.r);
  const s = BigInt(authorization.s);
  if ((yParity !== 0n && yParity !== 1n) || toLowS(s) !== s) {
    return false;
  }
  const digest = authorizationDigest({
    chainId: BigInt(authorization.chainId),
    address: hexBytes(authorization.address),
    nonce: BigInt(authorization.nonce),
  });
  const publicKey = recoverPublicKey(digest, r, s, yParity === 0n ? 0 : 1);
  return publicKey !== undefined && sameAddress(addressFromPublicKey(publicKey), address);
}

function quantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function hexBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.slice(2), "hex"));
}
