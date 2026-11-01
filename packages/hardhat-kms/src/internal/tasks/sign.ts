import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { NewTaskActionFunction } from "hardhat/types/tasks";

import type { KmsKeyConfig } from "../../types.ts";
import { addressFromPublicKey, sameAddress } from "../crypto/address.ts";
import { personalMessageDigest, type TypedData, typedDataDigest } from "../crypto/digests.ts";
import { recoverPublicKey, toRpcSignature } from "../crypto/signature.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError } from "../errors.ts";
import { commandLineKeys } from "../hook-handlers/hre.ts";
import { createConnectionChain, parseChainId } from "../rpc/chain-id.ts";
import { checkTypedDataChain, type ExpectedChain } from "../rpc/typed-data.ts";
import type { KmsSigner } from "../signer/kms-signer.ts";
import { confirm, processTerminal, type Terminal } from "./confirm.ts";
import { decodeHex, readMessage, readTypedDataArgument } from "./inputs.ts";
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
  yes: boolean;
}

const OPERATION = "kms sign";
const DIGEST_LENGTH = 32;

/** What the task signs, with the digest its signature must recover against. */
type Payload =
  | { kind: "message"; message: Uint8Array }
  | { kind: "typedData"; typedData: TypedData }
  | { kind: "digest"; digest: Uint8Array };

/** What a raw digest's question and note say about it (decision 0021). */
const RAW_DIGEST_WARNING =
  "Raw digest: the plugin cannot tell what it authorizes. It could be a transaction, a permit, or an EIP-7702 delegation of this account.";

/**
 * Builds the action of `kms sign <key> <message>`, which signs an EIP-191 message, EIP-712 typed
 * data (`--data`) or a raw 32-byte digest (`--no-hash`) and prints the 65-byte signature
 * `r || s || v`, `v` being 27 or 28. Every signature must recover to the key before it is printed.
 * A raw digest is signed only after a person agrees at a terminal, or with `--yes` for a key with
 * `allowRawDigests: true`.
 *
 * @param terminal - Where to ask about a raw digest; tests pass another terminal.
 * @returns The task action, which returns the signature as `0x`-prefixed hex.
 */
export function signAction(
  terminal: () => Terminal = processTerminal,
): NewTaskActionFunction<SignArguments> {
  return async (args, hre) => await kmsSign(args, hre, terminal);
}

const kmsSignAction: NewTaskActionFunction<SignArguments> = signAction();

export default kmsSignAction;

async function kmsSign(
  args: SignArguments,
  hre: HardhatRuntimeEnvironment,
  terminal: () => Terminal,
): Promise<string> {
  const key = findTaskKey(hre, args.key);
  const payload = await readPayload(args, hre);
  const signature = await withTaskSigners(hre, async (signerFor) => {
    const signer = await signerFor(key);
    if (payload.kind === "digest") {
      // Before any sign request. A key without an address pin reads its address first.
      await approveRawDigest(args, hre, key, payload.digest, signer, terminal());
    }
    const signed = await sign(signer, payload);
    // Decision 0004: nothing is printed unless it recovers to the key. This catches a substituted
    // or wrong signer output; the digest comes from the same code the signer uses, so it is not
    // an independent check of the digest.
    if (!recoversTo(signed, digestOf(payload), await signer.getAddress())) {
      throw catalogError(ERRORS.signNoRecovery, {}, { operation: OPERATION });
    }
    return signed;
  });
  printLine(signature);
  return signature;
}

async function readPayload(args: SignArguments, hre: HardhatRuntimeEnvironment): Promise<Payload> {
  if (args.fromFile && !args.data) {
    throw catalogError(ERRORS.fromFileNeedsData, {}, { operation: OPERATION });
  }
  if (args.noHash && args.data) {
    throw catalogError(ERRORS.noHashWithData, {}, { operation: OPERATION });
  }
  if (args.yes && !args.noHash) {
    throw catalogError(ERRORS.yesNeedsNoHash, {}, { operation: OPERATION });
  }
  if (!args.data && (args.chain !== undefined || args.allowCrossChain)) {
    throw catalogError(ERRORS.chainOptionsNeedData, {}, { operation: OPERATION });
  }
  if (args.data) {
    if (args.chain !== undefined && hre.globalOptions.network !== undefined) {
      throw catalogError(ERRORS.signChainAndNetwork, {}, { operation: OPERATION });
    }
    const chain = parseChainId(args.chain, "--chain", OPERATION);
    const typedData = await readTypedDataArgument(args.message, args.fromFile, OPERATION);
    if (typedData.domain.chainId === undefined) {
      printNote("this typed data has no chain id: the signature is valid on every chain");
    }
    await checkTypedDataChain(typedData, {
      operation: OPERATION,
      allowCrossChain: args.allowCrossChain || hre.config.kms.allowCrossChainTypedData,
      expectedChain: async (domainChain) => await expectedChain(chain, hre, domainChain),
      mismatch: ERRORS.typedDataChainMismatchTask,
    });
    return { kind: "typedData", typedData };
  }
  if (args.noHash) {
    const digest = decodeHex(args.message, "the --no-hash digest", OPERATION);
    if (digest.length !== DIGEST_LENGTH) {
      throw catalogError(
        ERRORS.noHashDigestLength,
        { expected: DIGEST_LENGTH, length: digest.length },
        { operation: OPERATION },
      );
    }
    return { kind: "digest", digest };
  }
  return { kind: "message", message: readMessage(args.message, OPERATION) };
}

/**
 * Decides whether a raw digest may be signed, before any sign request (decision 0021, which
 * amends 0003). A key with `allowRawDigests: true` signs with `--yes` and a note. Otherwise a
 * person must answer `y` or `yes` at a terminal; without a terminal the task refuses and names what
 * is missing. A key given with `--kms` has no config, so only a terminal can approve it.
 *
 * @param args - The task arguments.
 * @param hre - The Hardhat runtime.
 * @param key - The key that would sign.
 * @param digest - The digest, shown in the question.
 * @param signer - The key's signer, for the address of a key without an address pin.
 * @param terminal - Where to ask.
 */
async function approveRawDigest(
  args: SignArguments,
  hre: HardhatRuntimeEnvironment,
  key: KmsKeyConfig,
  digest: Uint8Array,
  signer: KmsSigner,
  terminal: Terminal,
): Promise<void> {
  const optedIn = key.allowRawDigests === true;
  if (optedIn && args.yes) {
    printNote(
      `--no-hash signs the 32 bytes as they are, with no EIP-191 prefix. ${RAW_DIGEST_WARNING}`,
    );
    return;
  }
  const name = key.name;
  if (!terminal.interactive) {
    if (commandLineKeys(hre).includes(key)) {
      throw catalogError(ERRORS.rawDigestCommandLineKey, { name }, { operation: OPERATION });
    }
    if (!optedIn) {
      throw args.yes
        ? catalogError(ERRORS.rawDigestNotAllowed, { name }, { operation: OPERATION })
        : catalogError(ERRORS.rawDigestNoTerminal, { name }, { operation: OPERATION });
    }
    throw catalogError(ERRORS.rawDigestNeedsYes, { name }, { operation: OPERATION });
  }
  if (args.yes) {
    printNote(`--yes does not skip the question: key "${name}" does not set allowRawDigests: true`);
  }
  const address = key.address ?? (await signer.getAddress());
  const agreed = await hre.interruptions.uninterrupted(
    async () =>
      await confirm(terminal, [
        "[hardhat-kms] Sign a raw digest with --no-hash?",
        `  key      ${name}`,
        `  account  ${address}`,
        `  digest   0x${Buffer.from(digest).toString("hex")}`,
        RAW_DIGEST_WARNING,
      ]),
  );
  if (!agreed) {
    throw catalogError(ERRORS.rawDigestDeclined, {}, { operation: OPERATION });
  }
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
    throw catalogError(ERRORS.signNoChainToCompare, { domainChain }, { operation: OPERATION });
  }
  const configured = hre.config.networks[network]?.chainId;
  if (configured !== undefined) {
    return { chainId: BigInt(configured), name: `network ${network}` };
  }
  // Only a network without a configured chainId needs a connection. Creating one runs the
  // network hook, which may call the KMS, for example to fund a simulated network's accounts.
  const connection = await hre.network.create();
  try {
    return {
      chainId: await createConnectionChain(connection).chainId(),
      name: `network ${network}`,
    };
  } finally {
    await connection.close();
  }
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
