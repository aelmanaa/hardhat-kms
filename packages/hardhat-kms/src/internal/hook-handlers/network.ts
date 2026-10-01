import type { HookContext, NetworkHooks } from "hardhat/types/hooks";
import type { NetworkConnection } from "hardhat/types/network";

import { kmsDebug } from "../debug.ts";
import { ConnectionChain } from "../rpc/chain-id.ts";
import { ConnectionAccounts, dispatch, type NetworkKeys } from "../rpc/dispatcher.ts";
import { SignerCache } from "../signer/key-cache.ts";
import { systemTimers, type Timers } from "../signer/timeout.ts";
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

const hasKeys = (keys: NetworkKeys): boolean =>
  keys.config.length > 0 || keys.commandLine.length > 0;

/**
 * Builds the network hook handlers of one runtime: the signer cache and the per-connection
 * accounts live in this closure.
 *
 * @param timers - Timer functions for the idle close, for tests.
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
          // oxlint-disable-next-line eslint/no-console -- a warning for the user, as Hardhat plugins print them
          console.warn(
            "hardhat-kms: the `default` network has KMS keys (from `kmsAccounts` or `--kms` without `--network`). Tasks and tests use it when no --network is given, so they would call KMS. Put KMS keys on a named network, and pass --network with --kms.",
          );
        }
      }
      return connection;
    },
    closeConnection: async (context, connection, next) => {
      if (counted.delete(connection)) {
        cache.connectionClosed();
      }
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
