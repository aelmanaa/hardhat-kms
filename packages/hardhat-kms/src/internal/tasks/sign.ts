import { readFile } from "node:fs/promises";

import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { addressFromPublicKey, sameAddress } from "../crypto/address.ts";
import { personalMessageDigest, type TypedData, typedDataDigest } from "../crypto/digests.ts";
import { recoverPublicKey, toRpcSignature } from "../crypto/signature.ts";
import { errorName, kmsError } from "../errors.ts";
import { ConnectionChain, parseChainId } from "../rpc/chain-id.ts";
import { checkTypedDataChain, type ExpectedChain, readTypedData } from "../rpc/typed-data.ts";
import type { KmsSigner } from "../signer/kms-signer.ts";
import { findTaskKey, printLine, printNote, withTaskSigners } from "./keys.ts";

/** The arguments of `kms sign`. */
interface SignArguments {
  key: string;
  message: string;
  data: boolean;
  fromFile: boolean;
  noHash: boolean;
  chain: string | undefined;
  allowCrossChain: boolean;
}

const OPERATION = "kms sign";
const DIGEST_LENGTH = 32;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

/** What the task signs, with the digest its signature must recover against. */
type Payload =
  | { kind: "message"; message: Uint8Array }
  | { kind: "typedData"; typedData: TypedData }
  | { kind: "digest"; digest: Uint8Array };

/**
 * `kms sign <key> <message>`: signs an EIP-191 message, EIP-712 typed data (`--data`) or a raw
 * 32-byte digest (`--no-hash`) and prints the 65-byte signature `r || s || v`, `v` being 27 or 28.
 * Every signature must recover to the key before it is printed.
 *
 * @param args - The task arguments.
 * @param hre - The Hardhat runtime.
 * @returns The signature as `0x`-prefixed hex.
 */
const kmsSign: NewTaskActionFunction<SignArguments> = async (args, hre) => {
  const key = findTaskKey(hre, args.key);
  const payload = await readPayload(args, hre);
  const signature = await withTaskSigners(hre, async (signerFor) => {
    const signer = await signerFor(key);
    const signed = await sign(signer, payload);
    // Decision 0004: nothing is printed unless it recovers to the key. This catches a substituted
    // or wrong signer output; the digest comes from the same code the signer uses, so it is not
    // an independent check of the digest.
    if (!recoversTo(signed, digestOf(payload), await signer.getAddress())) {
      throw kmsError("the signature does not recover to the key's address", {
        operation: OPERATION,
      });
    }
    return signed;
  });
  printLine(signature);
  return signature;
};

export default kmsSign;

async function readPayload(args: SignArguments, hre: HardhatRuntimeEnvironment): Promise<Payload> {
  if (args.fromFile && !args.data) {
    throw kmsError("--from-file requires --data", { operation: OPERATION });
  }
  if (args.noHash && args.data) {
    throw kmsError("--no-hash cannot be combined with --data", { operation: OPERATION });
  }
  if (!args.data && (args.chain !== undefined || args.allowCrossChain)) {
    throw kmsError("--chain and --allow-cross-chain apply only to --data", {
      operation: OPERATION,
    });
  }
  if (args.data) {
    if (args.chain !== undefined && hre.globalOptions.network !== undefined) {
      throw kmsError("pass --chain or --network, not both", { operation: OPERATION });
    }
    const chain = parseChainId(args.chain, "--chain", OPERATION);
    const text = args.fromFile ? await readTypedDataFile(args.message) : args.message;
    const typedData = readTypedData(text, OPERATION);
    if (typedData.domain.chainId === undefined) {
      printNote("this typed data has no chain id: the signature is valid on every chain");
    }
    await checkTypedDataChain(typedData, {
      operation: OPERATION,
      allowCrossChain: args.allowCrossChain || hre.config.kms.allowCrossChainTypedData,
      expectedChain: async (domainChain) => await expectedChain(chain, hre, domainChain),
      allowHint: "Pass --allow-cross-chain to sign it for another chain",
    });
    return { kind: "typedData", typedData };
  }
  if (args.noHash) {
    // Decision 0003: a raw digest can be any transaction or permit, so the user must see this.
    printNote(
      "--no-hash signs the 32 bytes as they are, with no EIP-191 prefix. Sign only a digest you computed yourself: it can authorize a transaction or a permit.",
    );
    const digest = decodeHex(args.message, "the --no-hash digest");
    if (digest.length !== DIGEST_LENGTH) {
      throw kmsError(`--no-hash needs a ${DIGEST_LENGTH}-byte digest, got ${digest.length} bytes`, {
        operation: OPERATION,
      });
    }
    return { kind: "digest", digest };
  }
  // As cast does: a 0x value is hex bytes, anything else is UTF-8 text.
  const message = args.message.startsWith("0x")
    ? decodeHex(args.message, "the message")
    : new TextEncoder().encode(args.message);
  return { kind: "message", message };
}

/**
 * The chain typed data must be for: `--chain`, else the `--network` config's `chainId`, else the
 * chain the network's node reports. Without `--chain` or `--network`, typed data that names a
 * chain is refused.
 */
async function expectedChain(
  chainId: bigint | undefined,
  hre: HardhatRuntimeEnvironment,
  domainChain: bigint,
): Promise<ExpectedChain> {
  if (chainId !== undefined) {
    return { chainId, name: "--chain" };
  }
  const network = hre.globalOptions.network;
  if (network === undefined) {
    throw kmsError(
      `the typed data is for chain ${domainChain}, and there is no chain to compare it with. Pass --network or --chain, or --allow-cross-chain to sign it for any chain`,
      { operation: OPERATION },
    );
  }
  const configured = hre.config.networks[network]?.chainId;
  if (configured !== undefined) {
    return { chainId: BigInt(configured), name: `network ${network}` };
  }
  // Only a network without a configured chainId needs a connection. Creating one runs the
  // network hook, which may call the KMS, for example to fund a simulated network's accounts.
  const connection = await hre.network.create();
  try {
    const chain = new ConnectionChain(async () => {
      const response: unknown = await connection.provider.request({ method: "eth_chainId" });
      return response;
    }, connection.networkConfig.chainId);
    return { chainId: await chain.chainId(), name: `network ${network}` };
  } finally {
    await connection.close();
  }
}

async function readTypedDataFile(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw kmsError(`cannot read the typed data file ${file} (${errorName(error)})`, {
      operation: OPERATION,
    });
  }
}

function decodeHex(value: string, what: string): Uint8Array {
  if (!HEX_BYTES.test(value)) {
    throw kmsError(`${what} is not 0x-prefixed hex with an even number of digits`, {
      operation: OPERATION,
    });
  }
  return new Uint8Array(Buffer.from(value.slice(2), "hex"));
}

async function sign(signer: KmsSigner, payload: Payload): Promise<string> {
  if (payload.kind === "typedData") {
    return await signer.signTypedData(payload.typedData);
  }
  if (payload.kind === "message") {
    return await signer.signPersonalMessage(payload.message);
  }
  return toRpcSignature(await signer.signDigest(payload.digest));
}

function digestOf(payload: Payload): Uint8Array {
  if (payload.kind === "typedData") {
    return typedDataDigest(payload.typedData);
  }
  if (payload.kind === "message") {
    return personalMessageDigest(payload.message);
  }
  return payload.digest;
}

/** Whether a `0x` `r || s || v` signature over `digest` recovers to `address`. */
function recoversTo(signature: string, digest: Uint8Array, address: string): boolean {
  const bytes = Buffer.from(signature.slice(2), "hex");
  const v = bytes[64];
  if (bytes.length !== 65 || (v !== 27 && v !== 28)) {
    return false;
  }
  const r = BigInt(`0x${bytes.subarray(0, 32).toString("hex")}`);
  const s = BigInt(`0x${bytes.subarray(32, 64).toString("hex")}`);
  const publicKey = recoverPublicKey(digest, r, s, v === 27 ? 0 : 1);
  return publicKey !== undefined && sameAddress(addressFromPublicKey(publicKey), address);
}
