import { catalogError, kmsKeyAddress } from "hardhat-kms/provider-utils";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { NetworkConnection } from "hardhat/types/network";
import { getAddress, isAddress, type Address } from "viem";

import { ERRORS } from "./error-catalog.ts";
import { parseAddress } from "./safe-tx.ts";

/** The account that signs, and how the review names it. */
export interface Proposer {
  address: Address;
  /** Such as `key owner`, `Ledger` or `local account`. */
  label: string;
}

/** The parts of a network config that decide where Hardhat signs. */
export interface NetworkSigningShape {
  type: unknown;
  accounts?: unknown;
}

/**
 * Whether Hardhat answers `eth_accounts` itself and signs for each of its addresses in this
 * process. True only for shapes Hardhat 3 handles locally: an `edr-simulated` network, and an
 * `http` network whose `accounts` is a list of keys (even an empty one), which
 * `LocalAccountsHandler` serves, or an HD config, which `HDWalletHandler` serves. Neither handler
 * returns the node's accounts, and neither forwards a signing request for an address it does not
 * hold. Any other shape, `accounts: "remote"` and anything this package does not recognise
 * included, is treated as one where the node may sign.
 *
 * @param config - The network's resolved config.
 * @returns Whether every `eth_accounts` address is signed for in this process.
 */
export function networkSignsInProcess(config: NetworkSigningShape): boolean {
  if (config.type === "edr-simulated") {
    return true;
  }
  if (config.type !== "http") {
    return false;
  }
  const { accounts } = config;
  if (Array.isArray(accounts)) {
    return true;
  }
  // The same fields Hardhat's own isHttpNetworkHdAccountsConfig checks.
  return (
    typeof accounts === "object" &&
    accounts !== null &&
    ["mnemonic", "count", "initialIndex", "passphrase", "path"].every((field) => field in accounts)
  );
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
 * The connection's `eth_accounts`, checksummed.
 *
 * @param connection - The connection.
 * @returns The addresses; an answer that is not a list gives none.
 */
async function connectionAccounts(connection: NetworkConnection): Promise<Address[]> {
  const accounts: unknown = await connection.provider.request({ method: "eth_accounts" });
  return Array.isArray(accounts) ? addresses(accounts) : [];
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

/** The names of the network's KMS accounts. */
function kmsNames(connection: NetworkConnection): string[] {
  return connection.networkConfig.kmsAccounts.map((account) => account.name);
}

/** The result of looking an address up among the network's KMS keys. */
interface KmsLookup {
  /** The key whose address it is. */
  name: string | undefined;
  /** The first lookup that failed, such as a KMS that cannot be reached. */
  failure: Error | undefined;
}

/**
 * Finds the KMS key of the network whose address is `address`. Each address comes from the KMS,
 * or from the key's `address` pin, never from the node. A key that cannot be read is skipped, so
 * an unreachable key does not stop another key, or a local account, from proposing.
 *
 * @param hre - The Hardhat runtime.
 * @param connection - The connection.
 * @param address - The address.
 * @returns The key's name, if any, and the first failure.
 */
async function findKmsKey(
  hre: HardhatRuntimeEnvironment,
  connection: NetworkConnection,
  address: Address,
): Promise<KmsLookup> {
  let failure: Error | undefined;
  for (const name of kmsNames(connection)) {
    try {
      if (getAddress(await kmsKeyAddress(hre, name)) === address) {
        return { name, failure };
      }
    } catch (error) {
      if (error instanceof Error) {
        failure ??= error;
      }
    }
  }
  return { name: undefined, failure };
}

/**
 * How `address` is signed for on the connection, or a refusal when the connection would not sign
 * for it in this process.
 *
 * @param hre - The Hardhat runtime.
 * @param connection - The connection.
 * @param address - The proposer.
 * @returns The proposer with its label.
 */
async function inProcessSigner(
  hre: HardhatRuntimeEnvironment,
  connection: NetworkConnection,
  address: Address,
): Promise<Proposer> {
  const { networkName } = connection;
  if (!(await connectionAccounts(connection)).includes(address)) {
    throw catalogError(ERRORS.notAnAccount, { address, network: networkName });
  }
  if (ledgerAccounts(connection).includes(address)) {
    return { address, label: "Ledger" };
  }
  const kms = await findKmsKey(hre, connection, address);
  if (kms.name !== undefined) {
    return { address, label: `key ${kms.name}` };
  }
  if (networkSignsInProcess(connection.networkConfig)) {
    return { address, label: "local account" };
  }
  // The node's own accounts and the KMS accounts look alike in eth_accounts. When no KMS key
  // matched because one could not be read, that error says more than the refusal.
  if (kms.failure !== undefined) {
    throw kms.failure;
  }
  throw catalogError(ERRORS.nodeAccount, { address, network: networkName });
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
 * The owner that `kms safe propose` signs with, chosen before anything is read from the Safe.
 *
 * - `--key` names a KMS key, and the connection must list its address.
 * - `--from` names an address the connection signs for in this process: see
 *   {@link assertProposerSignsInProcess}.
 * - Both: they must name the same address.
 * - Neither: the network's only KMS account.
 *
 * @param hre - The Hardhat runtime.
 * @param connection - The connection.
 * @param from - `--from`.
 * @param key - `--key`.
 * @returns The proposer.
 */
export async function chooseProposer(
  hre: HardhatRuntimeEnvironment,
  connection: NetworkConnection,
  from: string | undefined,
  key: string | undefined,
): Promise<Proposer> {
  const { networkName } = connection;
  const fromAddress = from === undefined ? undefined : parseAddress(from, "--from");
  if (fromAddress !== undefined && key === undefined) {
    return await inProcessSigner(hre, connection, fromAddress);
  }
  const name = key ?? onlyKey(networkName, kmsNames(connection));
  const address = getAddress(await kmsKeyAddress(hre, name));
  if (fromAddress !== undefined && fromAddress !== address) {
    throw catalogError(ERRORS.fromAndKey, { from: fromAddress, key: name, address });
  }
  if (!(await connectionAccounts(connection)).includes(address)) {
    throw catalogError(ERRORS.notOnNetwork, { address, key: name, network: networkName });
  }
  return { address, label: `key ${name}` };
}

/**
 * Checks that a Hardhat network connection signs for `address` in this process, the rule
 * `kms safe propose --from` applies, so that a script can apply it before
 * {@link proposeSafeTransaction}, which sends the signing request for its `sender` as it is.
 *
 * The address must be in the connection's `eth_accounts`. It is then accepted when it is a Ledger
 * address of the network's `ledgerAccounts`, the address of one of its `kmsAccounts`, or any
 * account of a network where Hardhat signs every listed account itself: `edr-simulated`, or `http`
 * with `accounts` set to a list of keys or an HD config. On an `http` network with
 * `accounts: "remote"`, the default, or a network config this package does not recognise, the
 * other listed accounts are the node's, which the node would sign for, and they are refused.
 * Nothing is signed.
 *
 * @param hre - The Hardhat runtime, which reads the KMS keys' addresses.
 * @param connection - A connection from `hre.network.create()`.
 * @param address - The proposer.
 * @throws `safe.key.sender` for an address that is not one, `safe.key.not-an-account` when the
 *   connection does not list it, `safe.key.node-account` when the node would sign for it, or the
 *   KMS's error when no key matched and one could not be read.
 */
export async function assertProposerSignsInProcess(
  hre: HardhatRuntimeEnvironment,
  connection: NetworkConnection,
  address: string,
): Promise<void> {
  if (!isAddress(address, { strict: false })) {
    throw catalogError(ERRORS.badSender, {});
  }
  await inProcessSigner(hre, connection, getAddress(address));
}
