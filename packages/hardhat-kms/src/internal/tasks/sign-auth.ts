import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { NetworkConnection } from "hardhat/types/network";
import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { addressFromPublicKey, sameAddress, toChecksumAddress } from "../crypto/address.ts";
import { authorizationDigest } from "../crypto/digests.ts";
import { recoverPublicKey, toLowS } from "../crypto/signature.ts";
import { kmsError } from "../errors.ts";
import { ConnectionChain, parseChainId } from "../rpc/chain-id.ts";
import { findTaskKey, printLine, printNote, withTaskSigners } from "./keys.ts";

/** The arguments of `kms sign-auth`. */
interface SignAuthArguments {
  key: string;
  delegate: string;
  chain: string | undefined;
  nonce: string | undefined;
  selfBroadcast: boolean;
  force: boolean;
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
/** EIP-7702 encodes the chain id as a 256-bit integer. */
const CHAIN_ID_LIMIT = 2n ** 256n;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

/** What the command line asks for, checked before any KMS call. */
interface AuthorizationInputs {
  delegate: string;
  chain: bigint | undefined;
  nonce: bigint | undefined;
  /** The `--network` name, when one was given. */
  network: string | undefined;
}

/**
 * `kms sign-auth <key> <delegate>`: signs an EIP-7702 authorization that delegates the key's
 * account to `delegate`, and prints it as the JSON tuple `eth_sendTransaction` takes in its
 * `authorizationList`. The tuple must recover to the key before it is printed.
 *
 * @param args - The task arguments.
 * @param hre - The Hardhat runtime.
 * @returns The signed authorization.
 */
const kmsSignAuth: NewTaskActionFunction<SignAuthArguments> = async (args, hre) => {
  const key = findTaskKey(hre, args.key);
  const inputs = readInputs(args, hre);
  // The connection opens only for what neither the command line nor the config gives. Opening it
  // runs the network hook, which can call the KMS, for example to fund a simulated network.
  const configured = configuredChain(hre, inputs.network);
  let connection: Promise<NetworkConnection> | undefined;
  const connect = async (): Promise<NetworkConnection> =>
    await (connection ??= hre.network.create());
  try {
    // A --network run without --nonce connects anyway, so the node's chain is checked against
    // the config's then; with --nonce, the config's chainId is enough.
    const chainId =
      inputs.chain ??
      (configured !== undefined && inputs.nonce !== undefined
        ? BigInt(configured)
        : await networkChain(await connect(), configured));
    if (chainId === 0n && !args.force) {
      throw kmsError(
        "an authorization for chain 0 is valid on every chain where the account's nonce matches. Pass --force to sign it anyway",
        { operation: OPERATION },
      );
    }
    const chainSource =
      inputs.network === undefined ? "from --chain" : `from --network ${inputs.network}`;
    const { authorization, nonce: signedNonce } = await withTaskSigners(hre, async (signerFor) => {
      const signer = await signerFor(key);
      const authority = await signer.getAddress();
      const nonce =
        inputs.nonce ?? (await authorityNonce(await connect(), authority, args.selfBroadcast));
      if (nonce >= NONCE_LIMIT) {
        throw kmsError(`the nonce ${nonce} is too large: EIP-7702 needs one below 2^64 - 1`, {
          operation: OPERATION,
        });
      }
      // What is about to be signed, before the KMS call, which may wait for an approval.
      printNote(
        `authority ${authority}, chain ${chainId} (${chainSource}), nonce ${nonce}, delegate ${inputs.delegate}`,
      );
      if (
        connection !== undefined &&
        inputs.network !== undefined &&
        !sameAddress(inputs.delegate, ZERO_ADDRESS)
      ) {
        await warnIfNoCode(await connection, inputs.delegate, inputs.network);
      }
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
      if (!recoversTo(signed, authority)) {
        throw kmsError("the authorization does not recover to the key's address", {
          operation: OPERATION,
        });
      }
      if (args.selfBroadcast) {
        printNote(
          `the authorization uses nonce ${nonce}: send it in a transaction from this key with nonce ${nonce - 1n}`,
        );
      }
      return { authorization: signed, nonce };
    });
    if (chainId === 0n) {
      printNote(
        `this authorization is for chain 0: it is replayable on every chain where this account's nonce is ${signedNonce}`,
      );
    }
    if (sameAddress(authorization.address, ZERO_ADDRESS)) {
      printNote("the delegate is the zero address: this authorization clears the delegation");
    }
    printLine(JSON.stringify(authorization));
    return authorization;
  } finally {
    // A connection that failed to open has nothing to close, and its error is already thrown.
    const opened = await connection?.catch(() => undefined);
    await opened?.close();
  }
};

export default kmsSignAuth;

function readInputs(args: SignAuthArguments, hre: HardhatRuntimeEnvironment): AuthorizationInputs {
  const network = hre.globalOptions.network;
  if (args.chain !== undefined && network !== undefined) {
    // Hardhat does not say whether --network came from the command line or HARDHAT_NETWORK.
    throw kmsError(
      "pass --chain or --network, not both. --network can also come from the HARDHAT_NETWORK environment variable",
      { operation: OPERATION },
    );
  }
  if (args.chain === undefined && network === undefined) {
    throw kmsError("pass --chain, or --network to sign for that network's chain", {
      operation: OPERATION,
    });
  }
  if (args.nonce !== undefined && args.selfBroadcast) {
    // As in cast: --self-broadcast only changes the nonce the task reads.
    throw kmsError("--nonce cannot be combined with --self-broadcast", { operation: OPERATION });
  }
  if (args.nonce === undefined && network === undefined) {
    throw kmsError("pass --nonce, or --network to read the key's pending nonce", {
      operation: OPERATION,
    });
  }
  const chain = parseChainId(args.chain, "--chain", OPERATION);
  if (chain !== undefined && chain >= CHAIN_ID_LIMIT) {
    throw kmsError("--chain does not fit in 256 bits", { operation: OPERATION });
  }
  return {
    delegate: checksummed(args.delegate),
    chain,
    nonce: parseNonce(args.nonce),
    network,
  };
}

function checksummed(delegate: string): string {
  try {
    return toChecksumAddress(delegate);
  } catch {
    // toChecksumAddress throws only InvalidAddressError.
    throw kmsError(
      `the delegate ${delegate.slice(0, 64)} is not an address: expected 0x and 40 hex digits, with a valid EIP-55 checksum if it is mixed-case`,
      { operation: OPERATION },
    );
  }
}

function parseNonce(value: string | undefined): bigint | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
    throw kmsError(
      `--nonce is not a nonce: expected a non-negative integer, got ${value.slice(0, 64)}`,
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
 * The authority's pending nonce from the `--network` node, plus one with `--self-broadcast`: the
 * transaction that carries the authorization is then from the same account and uses that nonce
 * first.
 */
async function authorityNonce(
  connection: NetworkConnection,
  authority: string,
  selfBroadcast: boolean,
): Promise<bigint> {
  const response: unknown = await connection.provider.request({
    method: "eth_getTransactionCount",
    params: [authority, "pending"],
  });
  if (typeof response !== "string" || !HEX_QUANTITY.test(response)) {
    throw kmsError("the node answered eth_getTransactionCount with something other than a nonce", {
      operation: OPERATION,
    });
  }
  const pending = BigInt(response);
  return selfBroadcast ? pending + 1n : pending;
}

/**
 * Warns when the delegate has no code on the `--network` node, which usually means an address
 * copied from another chain. The authorization is still signed: the code may be deployed later.
 */
async function warnIfNoCode(
  connection: NetworkConnection,
  delegate: string,
  network: string,
): Promise<void> {
  const code: unknown = await connection.provider.request({
    method: "eth_getCode",
    params: [delegate, "latest"],
  });
  if (code === "0x") {
    printNote(
      `the delegate ${delegate} has no code on network ${network}: check that it is the address for this chain`,
    );
  }
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
