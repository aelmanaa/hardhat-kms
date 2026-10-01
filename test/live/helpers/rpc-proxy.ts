// A JSON-RPC proxy between the anvil fork and the Sepolia RPC. Anvil reads the chain's state through
// it, so it sees every request the fork makes upstream. It records each method, forwards reads, and
// refuses any method that would broadcast a transaction, without forwarding it. The fork run then
// checks that nothing was refused: no transaction signed on the fork reached Sepolia.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** Methods that hand a transaction or bundle to the network. */
const SEND = /^(eth_send|eth_submit|mev_send)/i;
/** A request body larger than this is refused; anvil's reads are far smaller. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Whether a JSON-RPC method would broadcast something.
 *
 * @param method - The method name.
 * @returns True for `eth_sendRawTransaction`, `eth_sendTransaction` and the other send methods.
 */
export function isSendMethod(method: string): boolean {
  return SEND.test(method);
}

/** A running proxy. */
export interface RecordingProxy {
  /** The URL to give anvil as `--fork-url`. */
  url: string;
  /** Every method received, forwarded or not, with how many times. */
  methods: () => ReadonlyMap<string, number>;
  /** The methods refused, in order. `<unparsable>` stands for a body that was not JSON-RPC. */
  refused: () => readonly string[];
  /** Stops the proxy. */
  close: () => Promise<void>;
}

/** The method names of a parsed body, or undefined if it is not a request or a batch of them. */
function methodsOf(body: unknown): string[] | undefined {
  const calls: unknown[] = Array.isArray(body) ? body : [body];
  if (calls.length === 0) {
    return undefined;
  }
  const names: string[] = [];
  for (const call of calls) {
    if (typeof call !== "object" || call === null) {
      return undefined;
    }
    const method: unknown = Reflect.get(call, "method");
    if (typeof method !== "string") {
      return undefined;
    }
    names.push(method);
  }
  return names;
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

/** A JSON-RPC error for one refused call, with the call's id. */
function refusedCall(call: unknown, method: string): unknown {
  const id: unknown = typeof call === "object" && call !== null ? Reflect.get(call, "id") : null;
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32_601, message: `refused by the live suite's proxy: ${method}` },
  };
}

function refusal(body: unknown, methods: string[]): unknown {
  return Array.isArray(body)
    ? body.map((call: unknown, index) => refusedCall(call, methods[index] ?? "<unknown>"))
    : refusedCall(body, methods[0] ?? "<unknown>");
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
  const refused: string[] = [];

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const text = await readBody(request);
    let body: unknown;
    try {
      body = text === undefined ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    const methods = methodsOf(body);
    if (text === undefined || methods === undefined) {
      refused.push("<unparsable>");
      reply(response, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_600, message: "refused by the live suite's proxy: not JSON-RPC" },
      });
      return;
    }
    for (const method of methods) {
      counts.set(method, (counts.get(method) ?? 0) + 1);
    }
    // A batch with one send in it is refused whole: nothing of it is forwarded.
    const sends = methods.filter((method) => isSendMethod(method));
    if (sends.length > 0) {
      refused.push(...sends);
      reply(response, 200, refusal(body, methods));
      return;
    }
    const upstreamResponse = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
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
