import { createRequire } from "node:module";

import {
  catalogError,
  checkProviderVersion,
  confirm,
  internalError,
  kmsKeyAddress,
  processTerminal,
  type Terminal,
} from "hardhat-kms/provider-utils";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { NetworkConnection } from "hardhat/types/network";
import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { formatEther, getAddress, hexToBigInt, isAddress, isHex, type Address } from "viem";

import { serviceFor } from "../chains.ts";
import { ERRORS } from "../error-catalog.ts";
import {
  proposeSafeTransaction,
  type SafeProposal,
  type SafeTransactionReview,
} from "../propose.ts";
import { parseAddress } from "../safe-tx.ts";
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
  ];
  if (review.threshold === 1n) {
    lines.push(
      "The Safe's threshold is 1: this signature alone lets anyone execute the transaction once the service publishes it.",
    );
  }
  return lines;
}

/** The account that signs, and how the review names it. */
interface Proposer {
  address: Address;
  /** Such as `key owner`, `Ledger` or `local account`. */
  label: string;
}

/**
 * The name of the KMS key that signs when neither `--from` nor `--key` is given: the network's
 * only KMS account.
 *
 * @param network - The network's name.
 * @param names - The names of the network's KMS accounts.
 * @returns The key's name.
 */
function onlyKey(network: string, names: readonly string[]): string {
  const [only, ...others] = names;
  if (only === undefined) {
    throw catalogError(ERRORS.noKmsAccount, { network });
  }
  if (others.length > 0) {
    throw catalogError(ERRORS.severalKmsAccounts, {
      network,
      count: names.length,
      names: names.join(", "),
    });
  }
  return only;
}

/**
 * The connection's `eth_accounts`, checksummed.
 *
 * @param connection - The connection.
 * @returns The addresses; an answer that is not a list of addresses gives none.
 */
async function connectionAccounts(connection: NetworkConnection): Promise<Address[]> {
  const accounts: unknown = await connection.provider.request({ method: "eth_accounts" });
  return Array.isArray(accounts) ? addresses(accounts) : [];
}

/**
 * The addresses in a list, checksummed; anything else in it is dropped.
 *
 * @param list - Such as an `eth_accounts` answer.
 * @returns The addresses.
 */
function addresses(list: readonly unknown[]): Address[] {
  return list.flatMap((item: unknown) =>
    typeof item === "string" && isAddress(item, { strict: false }) ? [getAddress(item)] : [],
  );
}

/**
 * The network's `ledgerAccounts`, which `@nomicfoundation/hardhat-ledger` adds to the network
 * config and whose signing requests it answers in this process, with the device. Read without a
 * dependency on that plugin: absent, or not a list of addresses, it is empty.
 *
 * @param connection - The connection.
 * @returns The Ledger addresses, checksummed.
 */
function ledgerAccounts(connection: NetworkConnection): Address[] {
  const configured: unknown = Reflect.get(connection.networkConfig, "ledgerAccounts");
  return Array.isArray(configured) ? addresses(configured) : [];
}

/**
 * The owner that signs, chosen before anything is read from the Safe.
 *
 * - `--key` names a KMS key, and the connection must list its address.
 * - `--from` names an address the connection must list in `eth_accounts`. On an `http` network
 *   whose `accounts` is `"remote"`, Hardhat forwards a signing request for an address it does not
 *   hold to the node, which signs with its own key; there `--from` must be a KMS account or a
 *   Ledger address of the network. Elsewhere Hardhat answers `eth_accounts` itself, with the keys
 *   in the network's `accounts` (or the simulated network's), the Ledger addresses and the KMS
 *   accounts, and signs for each in this process.
 * - Both: they must name the same address.
 * - Neither: the network's only KMS account.
 *
 * @param hre - The Hardhat runtime.
 * @param connection - The connection.
 * @param from - `--from`.
 * @param key - `--key`.
 * @returns The proposer.
 */
async function chooseProposer(
  hre: HardhatRuntimeEnvironment,
  connection: NetworkConnection,
  from: string | undefined,
  key: string | undefined,
): Promise<Proposer> {
  const { networkConfig, networkName } = connection;
  const fromAddress = from === undefined ? undefined : parseAddress(from, "--from");
  const kmsNames = networkConfig.kmsAccounts.map((account) => account.name);

  if (fromAddress === undefined || key !== undefined) {
    const name = key ?? onlyKey(networkName, kmsNames);
    const address = getAddress(await kmsKeyAddress(hre, name));
    if (fromAddress !== undefined && fromAddress !== address) {
      throw catalogError(ERRORS.fromAndKey, { from: fromAddress, key: name, address });
    }
    if (!(await connectionAccounts(connection)).includes(address)) {
      throw catalogError(ERRORS.notOnNetwork, { address, key: name, network: networkName });
    }
    return { address, label: `key ${name}` };
  }

  if (!(await connectionAccounts(connection)).includes(fromAddress)) {
    throw catalogError(ERRORS.notAnAccount, { address: fromAddress, network: networkName });
  }
  if (ledgerAccounts(connection).includes(fromAddress)) {
    return { address: fromAddress, label: "Ledger" };
  }
  if (networkConfig.type === "http" && networkConfig.accounts === "remote") {
    // The node's own accounts and the KMS accounts look alike in eth_accounts: only a KMS key of
    // the network may sign here. Its address comes from the KMS, not from the node.
    for (const name of kmsNames) {
      if (getAddress(await kmsKeyAddress(hre, name)) === fromAddress) {
        return { address: fromAddress, label: `key ${name}` };
      }
    }
    throw catalogError(ERRORS.nodeAccount, { address: fromAddress, network: networkName });
  }
  return { address: fromAddress, label: "--from" };
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
