// A JSON-RPC proxy between the anvil fork and the Sepolia RPC. Anvil reads the chain's state through
// it, so it sees every request the fork makes upstream. Anvil never sends a transaction to its fork
// URL; the proxy is the second line of defence if that ever changes. It forwards only the read
// methods anvil's fork backend uses, refuses everything else, and records what it saw. The fork run
// then checks that nothing was refused.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * The methods forwarded upstream: the reads anvil's fork backend
 * (`crates/anvil/src/eth/backend/fork.rs` in Foundry) can issue. None takes a signed transaction.
 * Methods that do, such as `eth_sendRawTransaction`, `eth_callBundle`, `mev_simBundle` or
 * `trace_rawTransaction`, are not listed and so are refused.
 */
const READ_METHODS = new Set([
  "anvil_nodeInfo",
  "debug_codeByHash",
  "debug_traceBlockByHash",
  "debug_traceBlockByNumber",
  "debug_traceTransaction",
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_createAccessList",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getAccount",
  "eth_getAccountInfo",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockReceipts",
  "eth_getCode",
  "eth_getLogs",
  "eth_getProof",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getUncleByBlockHashAndIndex",
  "eth_getUncleByBlockNumberAndIndex",
  "eth_simulateV1",
  "net_version",
  "trace_block",
  "trace_replayBlockTransactions",
  "trace_transaction",
]);
/** The keys a request may have. Any other key, in any case, could be read as one of these. */
const REQUEST_KEYS = new Set(["jsonrpc", "id", "method", "params"]);
/** 65 bytes of hex or more: a signature, a raw transaction or an authorization list. */
const SIGNED_DATA = /[0-9a-f]{130,}/i;
/** A request body larger than this is refused; anvil's reads are far smaller. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Whether the proxy forwards a method.
 *
 * @param method - The method name, case-sensitive as JSON-RPC servers treat it.
 * @returns True only for the reads in the allow-list.
 */
export function isForwardedMethod(method: string): boolean {
  return READ_METHODS.has(method);
}

/** One forwarded call. */
export interface ForwardedCall {
  method: string;
  params: unknown;
}

/** A running proxy. */
export interface RecordingProxy {
  /** The URL to give anvil as `--fork-url`. */
  url: string;
  /** Every method received, forwarded or not, with how many times. */
  methods: () => ReadonlyMap<string, number>;
  /** The calls forwarded upstream, in order. */
  forwarded: () => readonly ForwardedCall[];
  /** Why each refused request was refused, in order. */
  refused: () => readonly string[];
  /** Stops the proxy. */
  close: () => Promise<void>;
}

/** A request rebuilt from the parsed body, with only the four JSON-RPC keys. */
interface Call {
  jsonrpc: "2.0";
  id: unknown;
  method: string;
  params?: unknown;
}

/**
 * Parses a body into requests. Each request is rebuilt from its parsed fields, so what is forwarded
 * is exactly what was checked: a duplicate `method` key collapses to the one checked, and a key such
 * as `Method`, which a case-insensitive decoder like Go's `encoding/json` would read as `method`,
 * makes the body invalid.
 *
 * @param text - The request body.
 * @returns The requests and whether the body was a batch, or undefined if it is not JSON-RPC.
 */
export function parseRequests(text: string): { calls: Call[]; batch: boolean } | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  const batch = Array.isArray(body);
  const items: unknown[] = Array.isArray(body) ? body : [body];
  if (items.length === 0) {
    return undefined;
  }
  const calls: Call[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return undefined;
    }
    if (Object.keys(item).some((key) => !REQUEST_KEYS.has(key))) {
      return undefined;
    }
    const method: unknown = Reflect.get(item, "method");
    const id: unknown = Reflect.get(item, "id");
    const params: unknown = Reflect.get(item, "params");
    if (typeof method !== "string") {
      return undefined;
    }
    // Anvil sends `"params": null` for methods without parameters.
    if (params !== undefined && typeof params !== "object") {
      return undefined;
    }
    calls.push(
      params === undefined
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params },
    );
  }
  return { calls, batch };
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function refusal(calls: Call[], batch: boolean, reason: string): unknown {
  const errors = calls.map((call) => ({
    jsonrpc: "2.0",
    id: call.id ?? null,
    error: { code: -32_601, message: `refused by the live suite's proxy: ${reason}` },
  }));
  return batch ? errors : errors[0];
}

function reply(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

/**
 * Starts a proxy on 127.0.0.1 at a free port.
 *
 * @param upstream - The RPC URL that reads go to.
 * @returns The running proxy.
 */
export async function startRecordingProxy(upstream: string): Promise<RecordingProxy> {
  const counts = new Map<string, number>();
  const forwarded: ForwardedCall[] = [];
  const refused: string[] = [];

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const text = await readBody(request);
    const parsed = text === undefined ? undefined : parseRequests(text);
    if (parsed === undefined) {
      refused.push("not JSON-RPC");
      reply(response, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_600, message: "refused by the live suite's proxy: not JSON-RPC" },
      });
      return;
    }
    const { calls, batch } = parsed;
    for (const call of calls) {
      counts.set(call.method, (counts.get(call.method) ?? 0) + 1);
    }
    // A batch with one refused call in it is refused whole: nothing of it is forwarded.
    const disallowed = calls.filter((call) => !isForwardedMethod(call.method));
    if (disallowed.length > 0) {
      const reason = `not on the read allow-list: ${disallowed.map((call) => call.method).join(", ")}`;
      refused.push(reason);
      reply(response, 200, refusal(calls, batch, reason));
      return;
    }
    // The body sent upstream is rebuilt from what was checked, never the text received.
    const outgoing = JSON.stringify(batch ? calls : calls[0]);
    if (SIGNED_DATA.test(outgoing)) {
      const reason = `65 bytes of hex or more in ${calls.map((call) => call.method).join(", ")}`;
      refused.push(reason);
      reply(response, 200, refusal(calls, batch, reason));
      return;
    }
    forwarded.push(...calls.map((call) => ({ method: call.method, params: call.params })));
    const upstreamResponse = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: outgoing,
    });
    response.writeHead(upstreamResponse.status, { "content-type": "application/json" });
    response.end(await upstreamResponse.text());
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      // The upstream's error can name its URL; the fork only needs to know the read failed.
      if (!response.headersSent) {
        response.writeHead(502);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("the proxy has no TCP address");
  }
  const { port } = address;

  return {
    url: `http://127.0.0.1:${port}`,
    methods: () => new Map(counts),
    forwarded: () => [...forwarded],
    refused: () => [...refused],
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}
