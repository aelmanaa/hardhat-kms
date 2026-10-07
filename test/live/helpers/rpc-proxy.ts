// A JSON-RPC proxy between the anvil fork and the Sepolia RPC. Anvil reads the chain's state through
// it, so it sees every request the fork makes upstream. Anvil never sends a transaction to its fork
// URL; the proxy is the second line of defence if that ever changes. It forwards only the read
// methods anvil's fork backend uses, refuses everything else, and records what it saw. The fork run
// then checks that nothing was refused. It also records what the upstream answered to each
// `eth_feeHistory` and which forwards failed, as status codes and shapes only, so a failed fork run
// can say whether a fee read went wrong upstream.
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

/** What the upstream answered to one forwarded `eth_feeHistory`: no value from the answer. */
export interface FeeHistoryReply {
  /** The upstream's HTTP status. */
  status: number;
  /** The JSON-RPC error code, or the result's shape: array lengths and value types. */
  outcome: string;
}

/** A value's kind: an array's length, or its JSON type. Never the value. */
function kindOf(value: unknown): string {
  if (Array.isArray(value)) {
    return `array of ${value.length}`;
  }
  if (value === undefined) {
    return "missing";
  }
  return value === null ? "null" : typeof value;
}

/**
 * Describes one JSON-RPC answer to `eth_feeHistory` without any value from it, so nothing the
 * upstream sent (a message that names its URL, for one) reaches the test output.
 *
 * @param answer - The parsed answer for the call, or undefined if there was none.
 * @returns The error code, or the result's shape.
 */
export function describeFeeHistoryAnswer(answer: unknown): string {
  if (typeof answer !== "object" || answer === null) {
    return "no answer for the call";
  }
  const error: unknown = Reflect.get(answer, "error");
  if (error !== undefined) {
    const code: unknown =
      typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    return typeof code === "number" ? `error code ${code}` : "error without a numeric code";
  }
  const result: unknown = Reflect.get(answer, "result");
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return `result ${kindOf(result)}`;
  }
  const reward: unknown = Reflect.get(result, "reward");
  const firstReward: unknown = Array.isArray(reward) ? reward[0] : undefined;
  const oldest: unknown = Reflect.get(result, "oldestBlock");
  return [
    `baseFeePerGas ${kindOf(Reflect.get(result, "baseFeePerGas"))}`,
    `reward ${kindOf(reward)}`,
    `reward[0] ${kindOf(firstReward)}`,
    `oldestBlock ${typeof oldest === "string" && /^0x[0-9a-f]{1,16}$/i.test(oldest) ? "quantity" : kindOf(oldest)}`,
  ].join(", ");
}

/**
 * Names a failed upstream fetch by the error's name and, when it has one, its cause's code (such
 * as `ECONNRESET`), never its message, which can name the upstream URL.
 */
function failureOf(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code: unknown =
    typeof cause === "object" && cause !== null ? Reflect.get(cause, "code") : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(code)
    ? `${name} (${code})`
    : name;
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
  /** What the upstream answered to each forwarded `eth_feeHistory`, in order. */
  feeHistoryReplies: () => readonly FeeHistoryReply[];
  /** Each forward whose upstream fetch failed: its methods and the error's name. */
  upstreamFailures: () => readonly string[];
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
  const feeHistoryReplies: FeeHistoryReply[] = [];
  const upstreamFailures: string[] = [];

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
    let status: number;
    let answerText: string;
    try {
      const upstreamResponse = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: outgoing,
      });
      status = upstreamResponse.status;
      answerText = await upstreamResponse.text();
    } catch (error) {
      upstreamFailures.push(`${calls.map((call) => call.method).join(", ")}: ${failureOf(error)}`);
      throw error;
    }
    recordFeeHistory(calls, status, answerText);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(answerText);
  };

  /** Records the upstream's answer to each `eth_feeHistory` among the forwarded calls. */
  const recordFeeHistory = (calls: Call[], status: number, text: string): void => {
    const feeCalls = calls.filter((call) => call.method === "eth_feeHistory");
    if (feeCalls.length === 0) {
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      feeHistoryReplies.push(
        ...feeCalls.map(() => ({ status, outcome: "a body that is not JSON" })),
      );
      return;
    }
    const answers: unknown[] = Array.isArray(body) ? body : [body];
    for (const call of feeCalls) {
      const answer = answers.find(
        (item) => typeof item === "object" && item !== null && Reflect.get(item, "id") === call.id,
      );
      feeHistoryReplies.push({ status, outcome: describeFeeHistoryAnswer(answer) });
    }
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
    feeHistoryReplies: () => [...feeHistoryReplies],
    upstreamFailures: () => [...upstreamFailures],
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
