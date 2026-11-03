import { createRequire } from "node:module";

import {
  catalogError,
  checkProviderVersion,
  confirm,
  internalError,
  processTerminal,
  type Terminal,
} from "hardhat-kms/provider-utils";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { formatEther, hexToBigInt, isHex } from "viem";

import { serviceFor } from "../chains.ts";
import { ERRORS } from "../error-catalog.ts";
import {
  proposeSafeTransaction,
  type SafeProposal,
  type SafeTransactionReview,
} from "../propose.ts";
import { chooseProposer } from "../proposer.ts";
import { TransactionServiceClient } from "../tx-service.ts";
import { callData, describeCall } from "./inputs.ts";

/** The npm name this package checks its version under; it must equal the manifest name. */
export const PACKAGE_NAME = "@hardhat-kms/safe";

/** The label the Safe app shows next to a transaction this task proposed. */
const ORIGIN = "hardhat-kms";

/** The arguments of `kms safe propose`. */
export interface ProposeArguments {
  safe: string;
  to: string;
  value: bigint;
  data: string | undefined;
  function: string | undefined;
  args: string | undefined;
  key: string | undefined;
  from: string | undefined;
  nonce: string | undefined;
  delegatecall: boolean;
  yes: boolean;
}

/** This package's version, read through its own `package.json` export. */
function ownVersion(): string {
  const manifest: unknown = createRequire(import.meta.url)(`${PACKAGE_NAME}/package.json`);
  const version: unknown =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "version")
      : undefined;
  if (typeof version !== "string" || version === "") {
    throw internalError(ERRORS.noPackageVersion, { packageName: PACKAGE_NAME });
  }
  return version;
}

/** Writes a line of the task's result to standard output, where scripts read it. */
function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Writes a line for the person running the task to standard error. */
function note(line: string): void {
  process.stderr.write(`[hardhat-kms] ${line}\n`);
}

/**
 * What the task shows before the key signs.
 *
 * @param review - What is about to be signed.
 * @param signer - What signs, such as `key owner` or `Ledger`.
 * @param call - The function and its arguments, when `--function` encoded the call.
 * @returns The lines.
 */
function reviewLines(
  review: SafeTransactionReview,
  signer: string,
  call: string | undefined,
): string[] {
  const tx = review.transaction;
  const lines = [
    `Safe:       ${review.safe} (Safe ${review.version}, chain ${review.chainId})`,
    `Threshold:  ${review.threshold} of ${review.owners.length}`,
    `Owners:     ${review.owners.join(", ")}`,
    `Signer:     ${review.sender} (${signer})`,
    `To:         ${tx.to}`,
    `Value:      ${tx.value} wei (${formatEther(tx.value)} of the native token)`,
    `Data:       ${tx.data === "0x" ? "none" : `${(tx.data.length - 2) / 2} bytes, selector ${tx.data.slice(0, 10)}`}`,
    ...(call === undefined ? [] : [`Function:   ${call}`]),
    `Operation:  ${tx.operation === 1 ? "DELEGATECALL: the target's code runs with the Safe's storage and funds" : "call"}`,
    `Nonce:      ${tx.nonce} (the Safe's nonce is ${review.safeNonce})`,
    `SafeTx:     ${review.safeTxHash}`,
    `Domain hash:  ${review.domainHash}`,
    `Message hash: ${review.messageHash}`,
  ];
  if (review.threshold === 1n) {
    lines.push(
      "The Safe's threshold is 1: this signature alone lets anyone execute the transaction once the service publishes it.",
    );
  }
  return lines;
}

/**
 * `kms safe propose`, with the terminal it asks at when the Safe's threshold is 1.
 *
 * @param args - The task's arguments.
 * @param hre - The Hardhat runtime.
 * @param terminal - Where to ask; tests pass one.
 * @returns The proposal.
 */
export async function proposeTask(
  args: ProposeArguments,
  hre: HardhatRuntimeEnvironment,
  terminal: Terminal,
): Promise<SafeProposal> {
  checkProviderVersion(PACKAGE_NAME, ownVersion(), { operation: "kms safe propose" });
  let nonce: bigint | undefined;
  if (args.nonce !== undefined) {
    if (!/^\d{1,78}$/.test(args.nonce)) {
      throw catalogError(ERRORS.badNumber, { field: "--nonce" });
    }
    nonce = BigInt(args.nonce);
  }
  const data = callData(args.data, args.function, args.args);
  const call = args.function === undefined ? undefined : describeCall(args.function, args.args);

  const connection = await hre.network.create();
  try {
    const { networkConfig, provider } = connection;
    const chainIdAnswer: unknown = await provider.request({ method: "eth_chainId" });
    if (!isHex(chainIdAnswer, { strict: true }) || chainIdAnswer === "0x") {
      throw catalogError(ERRORS.chainUnreadable, {});
    }
    const chainId = hexToBigInt(chainIdAnswer);
    const { kmsSafe } = hre.config;
    const target = serviceFor(chainId, kmsSafe.services);
    if (target === undefined) {
      throw catalogError(ERRORS.unknownChain, { chainId });
    }
    if (networkConfig.chainId !== undefined && BigInt(networkConfig.chainId) !== chainId) {
      throw catalogError(ERRORS.chainMismatch, {
        actual: chainId,
        expected: BigInt(networkConfig.chainId),
      });
    }
    // The API key is Safe's: it goes to Safe's hosted service only, never to a self-hosted one.
    let apiKey: string | undefined;
    if (target.hosted) {
      if (kmsSafe.apiKey === undefined) {
        throw catalogError(ERRORS.apiKeyMissing, {});
      }
      apiKey = await kmsSafe.apiKey.get();
    }
    const service = new TransactionServiceClient({
      url: target.url,
      apiKey,
      timeoutMs: kmsSafe.timeoutMs,
    });

    const proposer = await chooseProposer(hre, connection, args.from, args.key);

    const proposal = await proposeSafeTransaction({
      provider,
      sender: proposer.address,
      safe: args.safe,
      call: { to: args.to, value: args.value, data, operation: args.delegatecall ? 1 : 0 },
      service,
      nonce,
      allowDelegateCall: args.delegatecall,
      // The chain the service was chosen for: the signing refuses a node that changed since.
      expectedChainId: chainId,
      origin: ORIGIN,
      approve: async (review) => {
        const lines = reviewLines(review, proposer.label, call);
        if (review.threshold !== 1n || args.yes) {
          for (const line of lines) {
            note(line);
          }
          if (review.threshold === 1n) {
            note("--yes: proposing without asking.");
          }
          return true;
        }
        if (!terminal.interactive) {
          throw catalogError(ERRORS.noTerminal, { safe: review.safe });
        }
        return await hre.interruptions.uninterrupted(async () => await confirm(terminal, lines));
      },
    });

    out(`Proposed SafeTx ${proposal.safeTxHash}`);
    out(`Safe ${proposal.safe} on chain ${proposal.chainId}, nonce ${proposal.transaction.nonce}`);
    out(
      `Threshold ${proposal.threshold} of ${proposal.owners.length}: ${proposal.owners.join(", ")}`,
    );
    out(`Signed by ${proposal.sender}`);
    if (proposal.link !== undefined) {
      out(proposal.link);
    }
    return proposal;
  } finally {
    await connection.close();
  }
}

/**
 * `kms safe propose <safe> <to>`: signs a Safe transaction with an owner the network signs for, and
 * proposes it to the Safe Transaction Service.
 *
 * @param args - The task's arguments.
 * @param hre - The Hardhat runtime.
 * @returns The proposal.
 */
const action: NewTaskActionFunction<ProposeArguments> = async (args, hre) =>
  await proposeTask(args, hre, processTerminal());

export default action;
