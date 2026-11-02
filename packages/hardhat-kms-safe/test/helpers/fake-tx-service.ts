// A fake Safe Transaction Service on 127.0.0.1 that validates proposals as the real one does, from
// safe-transaction-service 1b78e0b835ddee80afca64d14fcea2c74d725d95: history/serializers.py:207-325
// (SafeMultisigTransactionSerializer.validate) and history/views_v2.py:471-498 (201 with an empty
// body, 422 {"nonFieldErrors": [...]}). It reads the Safe from the chain (VERSION, owners and nonce
// at latest), as the service does.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  getAddress,
  hashMessage,
  hashTypedData,
  isAddress,
  isHex,
  parseAbi,
  recoverAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

const ABI = parseAbi([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function nonce() view returns (uint256)",
]);

const SAFE_TX = [
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "data", type: "bytes" },
  { name: "operation", type: "uint8" },
  { name: "safeTxGas", type: "uint256" },
  { name: "baseGas", type: "uint256" },
  { name: "gasPrice", type: "uint256" },
  { name: "gasToken", type: "address" },
  { name: "refundReceiver", type: "address" },
  { name: "nonce", type: "uint256" },
] as const;

/** A proposal the fake stored. */
export interface StoredProposal {
  safe: Address;
  safeTxHash: Hex;
  nonce: bigint;
  proposer: Address;
  confirmations: { owner: Address; signature: Hex }[];
  body: unknown;
}

/** A request the fake received. */
export interface RecordedRequest {
  method: string;
  path: string;
  /** Whether it carried `Authorization: Bearer <the expected key>`. */
  authorized: boolean;
  /** Whether it carried any `Authorization` header. */
  hasAuthorization: boolean;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A canned answer that replaces the fake's own for the next request. */
export interface CannedAnswer {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** Wait this long before answering. */
  delayMs?: number;
}

export interface FakeService {
  url: string;
  proposals: StoredProposal[];
  requests: RecordedRequest[];
  /** Answers to give, in order, before the fake's own logic applies again. */
  canned: CannedAnswer[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The value when it is an EIP-55 checksummed address, as safe-eth-py's field requires. */
function checksummed(value: unknown): Address | undefined {
  return typeof value === "string" &&
    isAddress(value, { strict: false }) &&
    getAddress(value) === value
    ? value
    : undefined;
}

function field(body: object, name: string): unknown {
  return Reflect.get(body, name);
}

function integer(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : undefined;
}

/**
 * Starts the fake.
 *
 * @param chain - A client of the chain the Safes are on.
 * @param apiKey - When set, a request without `Authorization: Bearer <apiKey>` gets 401.
 */
export async function startFakeService(chain: PublicClient, apiKey?: string): Promise<FakeService> {
  const proposals: StoredProposal[] = [];
  const requests: RecordedRequest[] = [];
  const canned: CannedAnswer[] = [];

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const send = (status: number, body?: unknown): void => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(body === undefined ? "" : JSON.stringify(body));
    };
    const reject = (message: string): void => {
      send(422, { nonFieldErrors: [message] });
    };
    const path = request.url ?? "";
    const text = await readBody(request);
    const authorization = request.headers.authorization;
    const authorized = apiKey === undefined || authorization === `Bearer ${apiKey}`;
    requests.push({
      method: request.method ?? "",
      path,
      authorized,
      hasAuthorization: authorization !== undefined,
      headers: { ...request.headers },
      body: text,
    });
    const answer = canned.shift();
    if (answer !== undefined) {
      if (answer.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
      }
      response.writeHead(answer.status, answer.headers ?? { "Content-Type": "application/json" });
      response.end(answer.body ?? "");
      return;
    }
    if (!authorized) {
      send(401, { detail: "Invalid API key." });
      return;
    }
    const multisig = /^\/api\/v2\/safes\/(0x[0-9a-fA-F]{40})\/multisig-transactions\/(\?.*)?$/.exec(
      path,
    );
    const pathSafe = multisig?.[1];
    if (multisig === null || pathSafe === undefined) {
      send(404, { detail: "Not found." });
      return;
    }
    if (request.method === "GET") {
      const safe = getAddress(pathSafe);
      const params = new URLSearchParams(multisig[2]?.slice(1) ?? "");
      const gte = BigInt(params.get("nonce__gte") ?? "0");
      const results = proposals
        .filter((p) => p.safe === safe && p.nonce >= gte)
        .toSorted((a, b) => (a.nonce < b.nonce ? 1 : a.nonce > b.nonce ? -1 : 0))
        .map((p) => ({ safe: p.safe, nonce: p.nonce.toString(), safeTxHash: p.safeTxHash }));
      send(200, { count: results.length, results });
      return;
    }
    const safe = checksummed(pathSafe);
    if (request.method !== "POST" || safe === undefined) {
      send(422, { code: 1, message: "Checksum address validation failed", arguments: [pathSafe] });
      return;
    }
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) {
      reject("body");
      return;
    }
    const to = checksummed(field(raw, "to"));
    const gasToken = checksummed(field(raw, "gasToken"));
    const refundReceiver = checksummed(field(raw, "refundReceiver"));
    const sender = checksummed(field(raw, "sender"));
    if (
      to === undefined ||
      gasToken === undefined ||
      refundReceiver === undefined ||
      sender === undefined
    ) {
      send(422, { sender: ["An address is not checksumed"] });
      return;
    }
    const operation = Number(field(raw, "operation"));
    if (operation !== 0 && operation !== 1) {
      reject("Operation CREATE not supported. Please use Gnosis Safe CreateLib");
      return;
    }
    const data = field(raw, "data") ?? "0x";
    const value = integer(field(raw, "value"));
    const safeTxGas = integer(field(raw, "safeTxGas"));
    const baseGas = integer(field(raw, "baseGas"));
    const gasPrice = integer(field(raw, "gasPrice"));
    const nonce = integer(field(raw, "nonce"));
    if (
      !isHex(data) ||
      value === undefined ||
      safeTxGas === undefined ||
      baseGas === undefined ||
      gasPrice === undefined ||
      nonce === undefined
    ) {
      send(422, { data: ["A number or the data is not valid"] });
      return;
    }
    const version = await chain.readContract({ address: safe, abi: ABI, functionName: "VERSION" });
    const chainId = BigInt(await chain.getChainId());
    const withChain = !["1.0.0", "1.1.1", "1.2.0"].includes(version);
    const message = {
      to,
      value,
      data,
      operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      nonce,
    };
    const safeTxHash = hashTypedData({
      types: { SafeTx: SAFE_TX },
      primaryType: "SafeTx",
      domain: withChain ? { chainId, verifyingContract: safe } : { verifyingContract: safe },
      message,
    });
    const claimed = field(raw, "contractTransactionHash");
    if (claimed !== safeTxHash) {
      reject(
        `Contract-transaction-hash=${safeTxHash} does not match provided contract-tx-hash=${String(claimed)}`,
      );
      return;
    }
    // The real service checks only nonces it indexed as executed; the chain's nonce stands in.
    const executed = await chain.readContract({ address: safe, abi: ABI, functionName: "nonce" });
    if (nonce < executed) {
      reject(`Tx with nonce=${nonce} for safe=${safe} already executed in tx-hash=0x`);
      return;
    }
    const owners = await chain.readContract({ address: safe, abi: ABI, functionName: "getOwners" });
    if (!owners.includes(sender)) {
      reject(
        `Sender=${sender} is not an owner or delegate. Current owners=[${owners.join(", ")}]. Delegates={}`,
      );
      return;
    }
    const signature = field(raw, "signature");
    const confirmations: StoredProposal["confirmations"] = [];
    if (signature !== null && signature !== undefined) {
      if (!isHex(signature) || (signature.length - 2) % 130 !== 0 || signature.length < 132) {
        send(422, { signature: ["Ensure this field has at least 65 hexadecimal chars"] });
        return;
      }
      for (let i = 2; i < signature.length; i += 130) {
        const part: Hex = `0x${signature.slice(i, i + 130)}`;
        const v = Number.parseInt(part.slice(130), 16);
        let owner: Address;
        if (v === 27 || v === 28) {
          owner = await recoverAddress({ hash: safeTxHash, signature: part });
        } else if (v === 31 || v === 32) {
          owner = await recoverAddress({
            hash: hashMessage({ raw: safeTxHash }),
            signature: `0x${part.slice(2, 130)}${(v - 4).toString(16)}`,
          });
        } else {
          reject(`Signature=${part} for owner=? is not valid`);
          return;
        }
        if (!owners.includes(owner)) {
          reject(
            `Signer=${owner} is not an owner or delegate. Current owners=[${owners.join(", ")}]. Delegates={}`,
          );
          return;
        }
        confirmations.push({ owner, signature: part });
      }
      if (!confirmations.some((c) => c.owner === sender)) {
        reject(`Signature does not match sender=${sender}`);
        return;
      }
    }
    if (!proposals.some((p) => p.safeTxHash === safeTxHash)) {
      proposals.push({ safe, safeTxHash, nonce, proposer: sender, confirmations, body: raw });
    }
    send(201);
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ detail: error instanceof Error ? error.message : "error" }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    proposals,
    requests,
    canned,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
