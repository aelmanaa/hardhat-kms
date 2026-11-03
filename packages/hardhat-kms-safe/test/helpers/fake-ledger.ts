// A stand-in for @nomicfoundation/hardhat-ledger 3.1.0, with a fixed test key in place of the
// device. It does what that plugin does on a connection: it adds `ledgerAccounts` to the
// network's resolved config, appends those addresses to the node's `eth_accounts`, and answers
// `eth_signTypedData_v4` for them in this process (with v 27 or 28, as the plugin's `#toRpcSig`
// does), forwarding every other request. Each signing request it answers is kept, so tests can
// check its shape.
import type { HardhatConfig } from "hardhat/types/config";
import type { NetworkHooks } from "hardhat/types/hooks";
import type { HardhatPlugin } from "hardhat/types/plugins";
import type { JsonRpcResponse } from "hardhat/types/providers";
import { getAddress, isHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { SAFE_TX_TYPES } from "../../src/internal/safe-tx.ts";

/** The fake device's key: a fixed test value, never a real key. */
export const LEDGER_SECRET: Hex = `0x${"33".repeat(32)}`;

/** The Ledger address the fake device signs for. */
export const LEDGER_ADDRESS: Address = privateKeyToAccount(LEDGER_SECRET).address;

/** A key that is not the Ledger's, for a device that answers with another signer. */
const WRONG_SECRET: Hex = `0x${"44".repeat(32)}`;

/** A fake Ledger plugin and what it saw. */
export interface FakeLedger {
  plugin: HardhatPlugin;
  /** The params of each `eth_signTypedData_v4` request it answered. */
  requests: unknown[][];
  /** When set, the device signs with another key than the Ledger address's. */
  wrongKey: boolean;
}

function params(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Signs the SafeTx a request carries, as the device would after the person approved it. */
async function deviceSign(secret: Hex, data: string): Promise<Hex> {
  const parsed: unknown = JSON.parse(data);
  const domain = field(parsed, "domain");
  const message = field(parsed, "message");
  const bytes = text(field(message, "data"));
  return await privateKeyToAccount(secret).signTypedData({
    types: { SafeTx: SAFE_TX_TYPES.SafeTx },
    primaryType: "SafeTx",
    domain: {
      chainId: BigInt(text(field(domain, "chainId"))),
      verifyingContract: getAddress(text(field(domain, "verifyingContract"))),
    },
    message: {
      to: getAddress(text(field(message, "to"))),
      value: BigInt(text(field(message, "value"))),
      data: isHex(bytes) ? bytes : "0x",
      operation: Number(field(message, "operation")),
      safeTxGas: BigInt(text(field(message, "safeTxGas"))),
      baseGas: BigInt(text(field(message, "baseGas"))),
      gasPrice: BigInt(text(field(message, "gasPrice"))),
      gasToken: getAddress(text(field(message, "gasToken"))),
      refundReceiver: getAddress(text(field(message, "refundReceiver"))),
      nonce: BigInt(text(field(message, "nonce"))),
    },
  });
}

/**
 * Creates the fake plugin.
 *
 * @param networks - The networks that list the Ledger address in `ledgerAccounts`.
 * @returns The plugin and its records.
 */
export function fakeLedger(networks: readonly string[]): FakeLedger {
  const ledger: FakeLedger = { plugin: { id: "test-fake-ledger" }, requests: [], wrongKey: false };
  const ledgerAccounts = [LEDGER_ADDRESS.toLowerCase()];
  const network: Partial<NetworkHooks> = {
    onRequest: async (context, connection, request, next) => {
      const accounts: unknown = Reflect.get(connection.networkConfig, "ledgerAccounts");
      if (!Array.isArray(accounts) || accounts.length === 0) {
        return await next(context, connection, request);
      }
      if (request.method === "eth_accounts") {
        const response = await next(context, connection, request);
        const own: unknown = "result" in response ? response.result : [];
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: [...(Array.isArray(own) ? own : []), ...ledgerAccounts],
        };
      }
      const [address, data] = params(request.params);
      if (
        request.method === "eth_signTypedData_v4" &&
        typeof address === "string" &&
        getAddress(address) === LEDGER_ADDRESS &&
        typeof data === "string"
      ) {
        ledger.requests.push(params(request.params));
        const signature = await deviceSign(ledger.wrongKey ? WRONG_SECRET : LEDGER_SECRET, data);
        const response: JsonRpcResponse = { jsonrpc: "2.0", id: request.id, result: signature };
        return response;
      }
      return await next(context, connection, request);
    },
  };
  ledger.plugin = {
    id: "test-fake-ledger",
    hookHandlers: {
      config: async () => ({
        default: async () => ({
          resolveUserConfig: async (userConfig, resolve, next): Promise<HardhatConfig> => {
            const config = await next(userConfig, resolve);
            for (const name of networks) {
              const resolved = config.networks[name];
              if (resolved !== undefined) {
                config.networks[name] = Object.assign({}, resolved, { ledgerAccounts });
              }
            }
            return config;
          },
        }),
      }),
      network: async () => ({ default: async () => network }),
    },
  };
  return ledger;
}
