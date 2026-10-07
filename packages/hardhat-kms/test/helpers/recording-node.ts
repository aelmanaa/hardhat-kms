import assert from "node:assert/strict";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import type { JsonRpcServer } from "hardhat/types/network";

/** A simulated node behind a JSON-RPC server that records raw transactions. */
export interface RecordingNode {
  server: JsonRpcServer;
  url: string;
  /** The raw transactions the node received. */
  raw: string[];
  /** Every method the node received, in order. */
  methods: string[];
  /** Every request the node received, in order. */
  requests: { method: string; params: unknown }[];
  /** The node's `eth_accounts` answer; empty, like a remote node's, unless a test changes it. */
  accounts: unknown;
  /** Methods the node answers with an error: its message, or its message and code (-32000 by default). */
  faults: Map<string, string | { message: string; code: number }>;
  /**
   * What the node does after it has recorded a raw transaction: answer with an error that has
   * this message (and code, -32000 by default), or wait this many milliseconds before it answers
   * with the hash. Unset, it answers with the hash at once.
   */
  afterAccept: { error: string; code?: number } | { delayMs: number } | undefined;
}

/**
 * Starts a simulated node behind a JSON-RPC server. It records raw transactions instead of
 * running them, so the chain state stays the same between sends, and fails the methods listed in
 * `faults`. Like a remote node, it has no accounts: `eth_accounts` returns an empty list.
 *
 * @param config - The simulated network's hardfork and block gas limit.
 * @returns The node.
 */
export async function startRecordingNode(
  config: { hardfork?: string; blockGasLimit?: bigint } = {},
): Promise<RecordingNode> {
  const raw: string[] = [];
  const methods: string[] = [];
  const requests: { method: string; params: unknown }[] = [];
  const faults = new Map<string, string | { message: string; code: number }>();
  const hre = await createHardhatRuntimeEnvironment({
    networks: { node: { type: "edr-simulated", chainId: 31337, ...config } },
  });
  // Set once the server listens, before any request can arrive.
  let node: RecordingNode | undefined;
  hre.hooks.registerHandlers("network", {
    onRequest: async (context, connection, request, next) => {
      methods.push(request.method);
      requests.push({ method: request.method, params: structuredClone(request.params) });
      const fault = faults.get(request.method);
      if (fault !== undefined) {
        const error = typeof fault === "string" ? { code: -32000, message: fault } : fault;
        return { jsonrpc: "2.0", id: request.id, error };
      }
      if (request.method === "eth_accounts") {
        return { jsonrpc: "2.0", id: request.id, result: node?.accounts ?? [] };
      }
      if (request.method !== "eth_sendRawTransaction" || !Array.isArray(request.params)) {
        return await next(context, connection, request);
      }
      const [bytes]: unknown[] = request.params;
      assert.ok(typeof bytes === "string");
      raw.push(bytes);
      const hash = `0x${Buffer.from(keccak_256(Buffer.from(bytes.slice(2), "hex"))).toString("hex")}`;
      const after = node?.afterAccept;
      if (after !== undefined && "error" in after) {
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: after.code ?? -32000, message: after.error },
        };
      }
      if (after !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, after.delayMs));
      }
      return { jsonrpc: "2.0", id: request.id, result: hash };
    },
  });
  const server = await hre.network.createServer("node", "127.0.0.1", 0);
  const { address, port } = await server.listen();
  node = {
    server,
    url: `http://${address}:${port}`,
    raw,
    methods,
    requests,
    accounts: [],
    faults,
    afterAccept: undefined,
  };
  return node;
}
