import type { HookContext, NetworkHooks } from "hardhat/types/hooks";
import type { NetworkConnection } from "hardhat/types/network";

import type { KmsKeyConfig } from "../../types.ts";
import { kmsDebug } from "../debug.ts";
import { ConnectionChain } from "../rpc/chain-id.ts";
import { ConnectionAccounts, dispatch } from "../rpc/dispatcher.ts";
import { SignerCache } from "../signer/key-cache.ts";
import { systemTimers, type Timers } from "../signer/timeout.ts";

const log = kmsDebug("rpc");

/**
 * The KMS keys of a connection: the network's `kmsAccounts`. Only http and `edr-simulated`
 * networks have them.
 *
 * @param connection - The network connection.
 * @returns The keys, in order.
 */
function connectionKeys(connection: NetworkConnection<string>): readonly KmsKeyConfig[] {
  const config = connection.networkConfig;
  return config.type === "http" || config.type === "edr-simulated" ? config.kmsAccounts : [];
}

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
      accounts = new ConnectionAccounts(context, cache, connectionKeys(connection));
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
      const keys = connectionKeys(connection);
      if (keys.length > 0) {
        counted.add(connection);
        cache.connectionOpened();
        // Another plugin may already have sent a request on this connection.
        accountsOf(context, connection);
        log("connection to %s: %d KMS accounts", connection.networkName, keys.length);
        if (connection.networkName === "default" && !warnedAboutDefault) {
          warnedAboutDefault = true;
          // oxlint-disable-next-line eslint/no-console -- a warning for the user, as Hardhat plugins print them
          console.warn(
            "hardhat-kms: `kmsAccounts` is set on the `default` network, which tasks and tests use when no --network is given, so they would call KMS. Put KMS keys on a named network instead.",
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
