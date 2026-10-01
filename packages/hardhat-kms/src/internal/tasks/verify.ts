import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { errorResult, successfulResult } from "hardhat/utils/result";

import { sameAddress, toChecksumAddress } from "../crypto/address.ts";
import { personalMessageDigest, typedDataDigest } from "../crypto/digests.ts";
import {
  type ParsedRpcSignature,
  parseRpcSignature,
  recoverAddress,
  toRpcSignature,
} from "../crypto/signature.ts";
import { kmsError } from "../errors.ts";
import { readMessage, readTypedDataArgument } from "./inputs.ts";
import { printLine, printNote, withNamedSigner } from "./keys.ts";

/** The arguments of `kms verify`. */
interface VerifyArguments {
  message: string;
  signature: string;
  address: string | undefined;
  key: string | undefined;
  data: boolean;
  fromFile: boolean;
}

/** What `kms verify` returns when the signature is valid. */
interface VerifySuccess {
  /** The signer, EIP-55 checksummed. */
  address: string;
}

/** What `kms verify` returns when the signature is from another address. */
interface VerifyMismatch {
  /** The address the signature recovers to. */
  recovered: string;
  /** The address it was checked against. */
  expected: string;
}

/** The signer to compare with: an address from `--address`, or a key from `--key`. */
type ExpectedSigner = { address: string; checksummed: string } | { key: string };

const OPERATION = "kms verify";

/**
 * `kms verify <message> <signature>`: recovers the signer of an EIP-191 message, or of EIP-712
 * typed data with `--data`, and compares it with `--address` or with the address of `--key`.
 * Only `--key` contacts the KMS, and only for the key's identity.
 *
 * A match prints one line to standard output. A mismatch prints both addresses to standard error
 * and returns a failed result, which makes the Hardhat CLI exit with code 1.
 *
 * @param args - The task arguments.
 * @param hre - The Hardhat runtime.
 * @returns A successful result with the signer, or a failed result with both addresses.
 */
const kmsVerify: NewTaskActionFunction<VerifyArguments> = async (args, hre) => {
  // Check every input before the KMS is asked for anything.
  const signer = expectedSigner(args);
  if (args.fromFile && !args.data) {
    throw kmsError("--from-file requires --data", { operation: OPERATION });
  }
  const digest = args.data
    ? typedDataDigest(await readTypedDataArgument(args.message, args.fromFile, OPERATION))
    : personalMessageDigest(readMessage(args.message, OPERATION));
  let parsed: ParsedRpcSignature;
  let recovered: string;
  try {
    parsed = parseRpcSignature(args.signature);
    recovered = recoverAddress(digest, parsed.signature);
  } catch (error) {
    throw kmsError(`invalid signature: ${error instanceof Error ? error.message : String(error)}`, {
      operation: OPERATION,
    });
  }
  // --address is compared as given, case-insensitively, and shown checksummed.
  const expected = "key" in signer ? await keyAddress(hre, signer.key) : signer.address;
  const shown = "key" in signer ? expected : signer.checksummed;
  const what = args.data ? "typed data" : "message";
  if (!sameAddress(recovered, expected)) {
    process.stderr.write(
      `Invalid: the signature over this ${what} recovers to ${recovered}, not to the expected signer ${shown}.\n`,
    );
    return errorResult<VerifyMismatch>({ recovered, expected: shown });
  }
  if (parsed.highS) {
    printNote(
      `this signature is high-S; OpenZeppelin ECDSA.recover rejects it; the low-S form is ${toRpcSignature(parsed.signature)}`,
    );
  }
  printLine(`Valid: ${shown} signed this ${what}.`);
  return successfulResult<VerifySuccess>({ address: shown });
};

export default kmsVerify;

/**
 * Reads which signer to expect: exactly one of `--address` and `--key`. An `--address` must be a
 * valid address: all-lowercase, all-uppercase, or mixed-case with a correct EIP-55 checksum.
 */
function expectedSigner(args: VerifyArguments): ExpectedSigner {
  if (args.address !== undefined && args.key !== undefined) {
    throw kmsError("pass either --address or --key, not both", { operation: OPERATION });
  }
  if (args.key !== undefined) {
    return { key: args.key };
  }
  if (args.address === undefined) {
    throw kmsError("pass the expected signer with --address <address> or --key <key>", {
      operation: OPERATION,
    });
  }
  try {
    return { address: args.address, checksummed: toChecksumAddress(args.address) };
  } catch (error) {
    throw kmsError(`--address: ${error instanceof Error ? error.message : String(error)}`, {
      operation: OPERATION,
    });
  }
}

/**
 * The address of the key `--key` names, got as `kms address` gets it. A provider that can report
 * neither a public key nor an address leaves only the key's `address` pin: the signature is then
 * checked against the pin, with a note that the pin itself is unconfirmed.
 */
async function keyAddress(hre: HardhatRuntimeEnvironment, name: string): Promise<string> {
  const { address, confirmed } = await withNamedSigner(
    hre,
    name,
    async (kms) => await kms.confirmedAddress(),
  );
  if (!confirmed) {
    printNote(
      `${name}: the provider cannot report this key's address, so the signature is checked against the configured \`address\` pin, which is not confirmed yet.`,
    );
  }
  return address;
}
