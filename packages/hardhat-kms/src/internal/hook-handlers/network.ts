import type { HookContext, NetworkHooks } from "hardhat/types/hooks";
import type { NetworkConnection } from "hardhat/types/network";

import { kmsDebug } from "../debug.ts";
import { ConnectionChain } from "../rpc/chain-id.ts";
import { ConnectionAccounts, dispatch, type NetworkKeys } from "../rpc/dispatcher.ts";
import { ConnectionSends } from "../rpc/send-guard.ts";
import { createTransactionFiller, type TransactionFiller } from "../rpc/transaction-filler.ts";
import { SignerCache } from "../signer/key-cache.ts";
import { systemTimers, type Timers } from "../signer/timeout.ts";
import { warn } from "../warnings.ts";
import { commandLineKeys } from "./hre.ts";

const log = kmsDebug("rpc");

/**
 * The KMS keys of a connection: the network's `kmsAccounts`, then, on the selected network, the
 * keys chosen with `--kms` (decision 0008). Only http and `edr-simulated` networks have keys.
 *
 * @param context - The Hardhat runtime.
 * @param connection - The network connection.
 * @returns The keys.
 */
function connectionKeys(context: HookContext, connection: NetworkConnection<string>): NetworkKeys {
  const network = connection.networkConfig;
  if (network.type !== "http" && network.type !== "edr-simulated") {
    return { name: connection.networkName, config: [], commandLine: [] };
  }
  // The selected network is the --network value, or "default" when none is given.
  const selected = context.globalOptions.network ?? "default";
  const commandLine = connection.networkName === selected ? commandLineKeys(context) : [];
  return { name: connection.networkName, config: network.kmsAccounts, commandLine };
}

/**
 * Gives each KMS account of a simulated network `kms.simulatedBalance` wei, so it can pay for
 * transactions in tests. Addresses come from pins or key lookups, as for `eth_accounts`.
 *
 * @param connection - The new connection, to an `edr-simulated` network.
 * @param accounts - The connection's KMS accounts.
 * @param balance - The balance in wei.
 */
async function fund(
  connection: NetworkConnection<string>,
  accounts: ConnectionAccounts,
  balance: bigint,
): Promise<void> {
  const addresses = await accounts.addresses();
  for (const address of addresses) {
    await connection.provider.request({
      method: "hardhat_setBalance",
      params: [address, `0x${balance.toString(16)}`],
    });
  }
  log("funded %d KMS accounts with %s wei", addresses.length, balance);
}

/**
 * The sender Hardhat gives a transaction without `from`: the network's `from`, as its
 * `FixedSenderHandler` does, else the first account of `eth_accounts`, as its
 * `AutomaticSenderHandler` does. `eth_accounts` goes through the hook chain, so the plugin's own
 * order applies: the network's accounts, then the KMS addresses.
 *
 * @param connection - The network connection.
 * @returns The sender, or `undefined` when there is none.
 */
async function defaultSender(connection: NetworkConnection<string>): Promise<unknown> {
  const { from } = connection.networkConfig;
  if (from !== undefined) {
    return from;
  }
  const accounts: unknown = await connection.provider.request({ method: "eth_accounts" });
  return Array.isArray(accounts) ? accounts[0] : undefined;
}

const hasKeys = (keys: NetworkKeys): boolean =>
  keys.config.length > 0 || keys.commandLine.length > 0;

/**
 * Builds the network hook handlers of one runtime: the signer cache and the per-connection
 * accounts live in this closure.
 *
 * @param timers - Timer functions for the idle close and the retry entries, for tests.
 * @returns The handlers.
 */
export function createNetworkHandlers(timers: Timers = systemTimers): Partial<NetworkHooks> {
  const cache = new SignerCache(timers);
  const accountsByConnection = new WeakMap<object, ConnectionAccounts>();
  // Connections counted as open. Hardhat lets a connection be closed twice; it is counted once.
  const counted = new WeakSet<object>();
  let warnedAboutDefault = false;

  const accountsOf = (
    context: HookContext,
    connection: NetworkConnection<string>,
  ): ConnectionAccounts => {
    let accounts = accountsByConnection.get(connection);
    if (accounts === undefined) {
      accounts = new ConnectionAccounts(context, cache, connectionKeys(context, connection));
      accountsByConnection.set(connection, accounts);
    }
    return accounts;
  };

  const chains = new WeakMap<object, ConnectionChain>();
  const chainOf = (connection: NetworkConnection<string>): ConnectionChain => {
    let chain = chains.get(connection);
    if (chain === undefined) {
      // eth_chainId goes through the hook chain again, which passes it on.
      chain = new ConnectionChain(async () => {
        const chainId: unknown = await connection.provider.request({ method: "eth_chainId" });
        return chainId;
      }, connection.networkConfig.chainId);
      chains.set(connection, chain);
    }
    return chain;
  };

  // One filler per connection, created on its first transaction: it caches what Hardhat's
  // handlers cache per connection.
  const fillers = new WeakMap<object, TransactionFiller>();
  const fillerOf = (connection: NetworkConnection<string>): TransactionFiller => {
    let filler = fillers.get(connection);
    if (filler === undefined) {
      filler = createTransactionFiller(connection, chainOf(connection));
      fillers.set(connection, filler);
    }
    return filler;
  };

  // One send state per connection: its nonce high-water marks and retry entries. On a simulated
  // network the node's pending count is authoritative, so the high-water mark is off.
  const sendsByConnection = new WeakMap<object, ConnectionSends>();
  const sendsOf = (connection: NetworkConnection<string>): ConnectionSends => {
    let sends = sendsByConnection.get(connection);
    if (sends === undefined) {
      sends = new ConnectionSends({
        highWater: connection.networkConfig.type !== "edr-simulated",
        timers,
      });
      sendsByConnection.set(connection, sends);
    }
    return sends;
  };

  return {
    newConnection: async (context, next) => {
      const connection = await next(context);
      const keys = connectionKeys(context, connection);
      if (hasKeys(keys)) {
        counted.add(connection);
        cache.connectionOpened();
        // Another plugin may already have sent a request on this connection.
        accountsOf(context, connection);
        log(
          "connection to %s: %d KMS accounts, %d from --kms",
          connection.networkName,
          keys.config.length + keys.commandLine.length,
          keys.commandLine.length,
        );
        if (connection.networkName === "default" && !warnedAboutDefault) {
          warnedAboutDefault = true;
          warn(
            "the `default` network has KMS keys (from `kmsAccounts` or `--kms` without `--network`). Tasks and tests use it when no --network is given, so they would call KMS. Put KMS keys on a named network, and pass --network with --kms.",
          );
        }
        const balance = context.config.kms.simulatedBalance;
        if (connection.networkConfig.type === "edr-simulated" && balance !== undefined) {
          try {
            await fund(connection, accountsOf(context, connection), balance);
          } catch (error) {
            // The connection is not handed out, so close it; that also releases its count.
            await connection.close().catch(() => undefined);
            throw error;
          }
        }
      }
      return connection;
    },
    closeConnection: async (context, connection, next) => {
      if (counted.delete(connection)) {
        cache.connectionClosed();
      }
      fillers.delete(connection);
      sendsByConnection.get(connection)?.close();
      sendsByConnection.delete(connection);
      await next(context, connection);
    },
    onRequest: async (context, connection, request, next) =>
      await dispatch(
        accountsOf(context, connection),
        request,
        async (nextRequest) => await next(context, connection, nextRequest),
        {
          chain: chainOf(connection),
          allowCrossChainTypedData: context.config.kms.allowCrossChainTypedData,
        },
        {
          filler: () => fillerOf(connection),
          defaultSender: async () => await defaultSender(connection),
          chainId: async () => await chainOf(connection).chainId(),
          sends: () => sendsOf(connection),
        },
      ),
  };
}

/**
 * Loaded by Hardhat once per runtime.
 *
 * @returns The handlers.
 */
export default async (): Promise<Partial<NetworkHooks>> =>
  await Promise.resolve(createNetworkHandlers());
