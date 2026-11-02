// Conformance with Safe's own client, @safe-global/api-kit 5.0.4 (a devDependency only): for the
// same SafeTx, the client sends the same method, path, headers and body bytes as api-kit's
// proposeTransaction, and asks for the queued transactions as its getPendingTransactions does.
// api-kit sends with node-fetch 2 to a recording server on 127.0.0.1; nothing leaves the machine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import apiKit from "@safe-global/api-kit";
import type { Address, Hex } from "viem";

import { SERVICE_CHAINS } from "../../src/internal/chains.ts";
import { safeTransaction, safeTxHash } from "../../src/internal/safe-tx.ts";
import { proposalBody, TransactionServiceClient } from "../../src/internal/tx-service.ts";

const KEY = "conformance-key-not-a-secret";
const SAFE: Address = "0x2B0b9cBDA3D7b0F760187c52A8FFB18C48E5d96A";
const SENDER: Address = "0x79613FD49472C3C7a32188e45ff00e7bdC8a897d";
const SIGNATURE: Hex = `0x${"22".repeat(64)}1c`;

interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * api-kit's class. Its declarations are typed as CommonJS, so TypeScript sees the default import as
 * the module object, while Node.js loads the ESM build, whose default export is the class itself.
 */
type SafeApiKitClass = typeof apiKit.default;
function isKitClass(value: unknown): value is SafeApiKitClass {
  return typeof value === "function";
}
const SafeApiKit = [apiKit, Reflect.get(apiKit, "default")].find(isKitClass);

let server: Server;
let root: string;
const recorded: Recorded[] = [];

describe("conformance with @safe-global/api-kit 5.0.4", () => {
  before(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        recorded.push({
          method: request.method ?? "",
          url: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        if (request.method === "POST") {
          response.writeHead(201);
          response.end();
        } else {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ count: 0, results: [] }));
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    root = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  const cases = [
    { name: "a transfer", call: { to: SENDER, value: 1234567890123456789n }, nonce: 0n },
    {
      name: "a contract call",
      call: { to: SAFE, data: "0xa9059cbb" + "00".repeat(64) },
      nonce: 41n,
    },
    {
      name: "a delegatecall",
      call: { to: SENDER, data: "0x8d80ff0a", operation: 1 as const },
      nonce: 9007199254740991n,
    },
  ];
  for (const testCase of cases) {
    it(`sends the same proposal request for ${testCase.name}`, async () => {
      const tx = safeTransaction(testCase.call, testCase.nonce);
      const hash = safeTxHash(11155111n, SAFE, tx);
      recorded.length = 0;

      await new TransactionServiceClient({ url: root, apiKey: KEY }).propose(
        SAFE,
        proposalBody(tx, hash, SENDER, SIGNATURE, "hardhat-kms"),
      );
      // What protocol-kit's createTransaction hands api-kit, in its key order
      // (standardizeSafeTransactionData in protocol-kit 8.0.11).
      assert.ok(SafeApiKit !== undefined);
      const kit = new SafeApiKit({ chainId: 11155111n, txServiceUrl: `${root}/api`, apiKey: KEY });
      await kit.proposeTransaction({
        safeAddress: SAFE,
        safeTransactionData: {
          to: tx.to,
          value: tx.value.toString(),
          data: tx.data,
          operation: tx.operation,
          baseGas: "0",
          gasPrice: "0",
          gasToken: "0x0000000000000000000000000000000000000000",
          refundReceiver: "0x0000000000000000000000000000000000000000",
          nonce: Number(tx.nonce),
          safeTxGas: "0",
        },
        safeTxHash: hash,
        senderAddress: SENDER,
        senderSignature: SIGNATURE,
        origin: "hardhat-kms",
      });

      const [ours, theirs] = recorded;
      assert.ok(ours !== undefined && theirs !== undefined);
      assert.equal(ours.method, theirs.method);
      assert.equal(ours.url, theirs.url);
      assert.equal(ours.body, theirs.body, "the body bytes differ");
      for (const header of ["accept", "content-type", "authorization"]) {
        assert.equal(ours.headers[header], theirs.headers[header], header);
      }
      assert.equal(ours.headers.authorization, `Bearer ${KEY}`);
    });
  }

  it("asks for the queued transactions as getPendingTransactions does", async () => {
    recorded.length = 0;
    await new TransactionServiceClient({ url: root, apiKey: KEY }).highestQueuedNonce(SAFE, 7n);
    assert.ok(SafeApiKit !== undefined);
    const kit = new SafeApiKit({ chainId: 11155111n, txServiceUrl: `${root}/api`, apiKey: KEY });
    await kit.getPendingTransactions(SAFE, { currentNonce: 7, ordering: "-nonce", limit: 1 });
    const [ours, theirs] = recorded;
    assert.ok(ours !== undefined && theirs !== undefined);
    assert.equal(ours.method, "GET");
    assert.equal(ours.url, theirs.url);
    assert.equal(ours.headers.authorization, theirs.headers.authorization);
  });

  it("lists the chains api-kit lists, with the same short names", () => {
    const entry = fileURLToPath(import.meta.resolve("@safe-global/api-kit"));
    const source = readFileSync(entry, "utf8");
    const theirs = new Map<bigint, string>();
    for (const match of source.matchAll(/\{ chainId: (\d+)n, shortName: "([^"]+)" \}/g)) {
      theirs.set(BigInt(match[1] ?? ""), match[2] ?? "");
    }
    assert.ok(theirs.size > 40, `found ${theirs.size} chains in api-kit`);
    assert.deepEqual(
      [...SERVICE_CHAINS].toSorted((a, b) => (a[0] < b[0] ? -1 : 1)),
      [...theirs].toSorted((a, b) => (a[0] < b[0] ? -1 : 1)),
    );
  });
});
