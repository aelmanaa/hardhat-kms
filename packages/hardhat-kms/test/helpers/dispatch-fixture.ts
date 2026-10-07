// The dispatcher on its own: a runtime with fake KMS adapters, a fake node that answers both the
// requests the dispatcher passes on and the ones it makes itself, and a send state the test can
// read. Unlike send-harness.ts, it calls dispatch() directly, so a test controls every answer.
import assert from "node:assert/strict";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { HardhatUserConfig } from "hardhat/types/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { JsonRpcRequest, JsonRpcResponse } from "hardhat/types/providers";

import hardhatKms from "../../src/index.ts";
import { ConnectionChain } from "../../src/internal/rpc/chain-id.ts";
import {
  ConnectionAccounts,
  type ConnectionTransactions,
  dispatch,
} from "../../src/internal/rpc/dispatcher.ts";
import { ConnectionSends } from "../../src/internal/rpc/send-guard.ts";
import { HardhatTransactionFiller } from "../../src/internal/rpc/transaction-filler.ts";
import { SignerCache } from "../../src/internal/signer/key-cache.ts";
import type { KmsKeyConfig, KmsKeyUserConfig } from "../../src/types.ts";
import { type FakeAdapter, fakeAdapter } from "./fake-adapter.ts";
import { type FakeTimers, fakeTimers } from "./fake-timers.ts";
import { vaultKey } from "./vault-key.ts";
import { COW_ACCOUNT, HARDHAT_ACCOUNT_0 } from "./vectors.ts";

export const COW: string = COW_ACCOUNT.address;
export const ZERO: string = HARDHAT_ACCOUNT_0.address;
/** An address that is no KMS account. */
export const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const CHAIN_ID = 31337n;

/** The secret keys of the fake adapters, by key name. */
const SECRETS: Record<string, string> = {
  cow: COW_ACCOUNT.secretKey,
  zero: HARDHAT_ACCOUNT_0.secretKey,
};

/** What the fake node answers for one method: a result, or an error it throws. */
export type Answer = (request: JsonRpcRequest) => unknown;

/** An answer that is a JSON-RPC error response rather than a result. */
export class ErrorAnswer {
  public readonly error: { code: number; message: string; data?: unknown };

  public constructor(code: number, message: string, data?: unknown) {
    this.error = data === undefined ? { code, message } : { code, message, data };
  }
}

/** What {@link dispatchFixture} takes. */
export interface FixtureOptions {
  /** The runtime's `kms.keys`; cow and zero by default. */
  keys?: Record<string, KmsKeyUserConfig>;
  /** The networks; `remote`, with cow and zero, by default. */
  networks?: HardhatUserConfig["networks"];
  /** The network the connection is to. */
  network?: string;
  /** A network whose `kmsAccounts` act as the keys chosen with `--kms`. */
  commandLineFrom?: string;
  /** Called before each signature, by key name. */
  beforeSign?: (name: string) => Promise<void>;
  /** Makes each adapter's identity call fail this many times. */
  failLookups?: number;
  /**
   * The node's chain id. The send locks are process-global and keyed by chain id and address, so
   * a test with a chain id of its own cannot meet the locks and holds of another test.
   */
  chainId?: bigint;
}

/** What {@link dispatchFixture} gives a test. */
export interface DispatchFixture {
  hre: HardhatRuntimeEnvironment;
  /** The node's chain id. */
  chainId: bigint;
  accounts: ConnectionAccounts;
  sends: ConnectionSends;
  timers: FakeTimers;
  /** The adapters created so far. */
  adapters: FakeAdapter[];
  /** The node's answers by method; a test replaces or adds entries. */
  answers: Map<string, Answer>;
  /** The requests passed on to the rest of the chain, in order. */
  forwarded: JsonRpcRequest[];
  /** The requests the dispatcher made itself (reads, lookups, fills), in order. */
  reads: { method: string; params: unknown[] }[];
  /** The sender Hardhat would give a transaction without `from`. */
  defaultSender: unknown;
  /** Whether the chain id read fails. */
  chainIdFails: boolean;
  /** The connection's send requests and state, as the network hook builds them. */
  transactions: ConnectionTransactions;
  /** Handles one request with dispatch(). */
  request: (method: string, params?: object | unknown[]) => Promise<JsonRpcResponse>;
}

/** The key configs of a network, as Hardhat resolved them. */
export function networkKeys(hre: HardhatRuntimeEnvironment, name: string): readonly KmsKeyConfig[] {
  const network = hre.config.networks[name];
  assert.ok(network !== undefined && network.type === "http", name);
  return network.kmsAccounts;
}

/**
 * A runtime, a connection's accounts and a fake node, wired to dispatch() as the network hook
 * wires them, with a fixed gas and gas price so a fill only reads the chain id and the nonce.
 *
 * @param options - What differs from the defaults.
 * @returns The fixture.
 */
export async function dispatchFixture(options: FixtureOptions = {}): Promise<DispatchFixture> {
  const keys =
    options.keys ?? Object.fromEntries(Object.keys(SECRETS).map((name) => [name, vaultKey(name)]));
  const networks = options.networks ?? {
    remote: { type: "http", url: "http://127.0.0.1:1", kmsAccounts: ["cow", "zero"] },
  };
  const hre = await createHardhatRuntimeEnvironment({
    plugins: [hardhatKms],
    kms: { keys },
    networks,
  });
  const adapters: FakeAdapter[] = [];
  let failures = options.failLookups ?? 0;
  hre.hooks.registerHandlers("kms", {
    createKeyAdapter: async (_context, key) => {
      const secret = SECRETS[key.name];
      assert.ok(secret !== undefined, key.name);
      const adapter = fakeAdapter({
        secretKey: new Uint8Array(Buffer.from(secret, "hex")),
        beforeSign: async () => {
          await options.beforeSign?.(key.name);
        },
      });
      adapters.push(adapter);
      const getPublicKey = adapter.getPublicKey?.bind(adapter);
      assert.ok(getPublicKey !== undefined);
      return await Promise.resolve({
        ...adapter,
        getPublicKey: async (context) => {
          if (failures > 0) {
            failures--;
            throw new Error("the KMS did not answer");
          }
          return await getPublicKey(context);
        },
      });
    },
  });

  const name = options.network ?? "remote";
  const timers = fakeTimers();
  const accounts = new ConnectionAccounts(hre, new SignerCache(timers, async () => {}), {
    name,
    config: networkKeys(hre, name),
    commandLine:
      options.commandLineFrom === undefined ? [] : networkKeys(hre, options.commandLineFrom),
  });
  const sends = new ConnectionSends({ highWater: true, timers });

  const chainId = options.chainId ?? CHAIN_ID;
  const answers = new Map<string, Answer>([
    ["eth_chainId", () => `0x${chainId.toString(16)}`],
    ["eth_getTransactionCount", () => "0x0"],
    ["eth_getTransactionByHash", () => null],
    ["eth_accounts", () => []],
  ]);
  const forwarded: JsonRpcRequest[] = [];
  const reads: { method: string; params: unknown[] }[] = [];
  const answer = async (request: JsonRpcRequest): Promise<unknown> => {
    const handler = answers.get(request.method);
    if (handler === undefined) {
      throw new Error(`the fake node does not answer ${request.method}`);
    }
    return await Promise.resolve(handler(request));
  };
  const read = async (method: string, params: unknown[] = []): Promise<unknown> => {
    reads.push({ method, params });
    const result = await answer({ jsonrpc: "2.0", id: 0, method, params });
    if (result instanceof ErrorAnswer) {
      throw new Error(result.error.message);
    }
    return result;
  };

  const fixture: DispatchFixture = {
    hre,
    chainId,
    accounts,
    sends,
    timers,
    adapters,
    answers,
    forwarded,
    reads,
    defaultSender: undefined,
    chainIdFails: false,
    transactions: {
      filler: () => filler,
      defaultSender: async () => await Promise.resolve(fixture.defaultSender),
      chainId: async () => await chain.chainId(),
      sends: () => sends,
      request: read,
    },
    request: async (method, params = []) =>
      await dispatch(
        accounts,
        { jsonrpc: "2.0", id: 7, method, params },
        async (next) => {
          forwarded.push(next);
          const result = await answer(next);
          return result instanceof ErrorAnswer
            ? { jsonrpc: "2.0", id: next.id, error: result.error }
            : { jsonrpc: "2.0", id: next.id, result };
        },
        { chain, allowCrossChainTypedData: false },
        fixture.transactions,
      ),
  };
  const chain = new ConnectionChain(async () => {
    if (fixture.chainIdFails) {
      throw new Error("no chain id");
    }
    return await read("eth_chainId");
  }, undefined);
  const filler = new HardhatTransactionFiller(read, async () => await chain.chainId(), {
    gas: 21_000n,
    gasPrice: 1n,
    gasMultiplier: 1,
    fallbackGas: undefined,
    isBlockGasLimitEnforced: () => true,
  });
  return fixture;
}

/** The result of a successful response. */
export function resultOf(response: JsonRpcResponse): unknown {
  assert.ok("result" in response, JSON.stringify(response));
  return response.result;
}
