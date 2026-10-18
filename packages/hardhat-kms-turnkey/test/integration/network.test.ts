// The adapter with the real `fetch` against the stub over HTTP: what node's fetch does with a
// redirect, a closed port, and an abort while a request waits for its answer.
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { after, before, describe, it } from "node:test";

import type { SignatureOutput, SignContext } from "hardhat-kms/types";

import { createTurnkeyKeyAdapter } from "../../src/internal/adapter.ts";
import {
  ACCOUNT_SECRET_KEY,
  API_PUBLIC_KEY,
  ORGANIZATION,
  signContext,
  turnkeyKey,
} from "../helpers/keys.ts";
import { SIGN_PATH, TurnkeyStub } from "../helpers/turnkey-stub.ts";

const DIGEST = new Uint8Array(32).fill(7);

let stub: TurnkeyStub;
let baseUrl: string;

before(async () => {
  stub = new TurnkeyStub({
    organizationId: ORGANIZATION,
    apiPublicKey: API_PUBLIC_KEY,
    secretKey: ACCOUNT_SECRET_KEY,
  });
  baseUrl = await stub.listen();
});

after(async () => {
  await stub.close();
});

/** Signs a digest with an adapter whose Turnkey API is at `url`. */
async function signAt(url: string, ctx: SignContext = signContext()): Promise<SignatureOutput> {
  const adapter = await createTurnkeyKeyAdapter(turnkeyKey(), { transport: { baseUrl: url } });
  const signature = await adapter.signDigest?.({ digest: DIGEST }, ctx);
  assert.ok(signature);
  return signature;
}

/** A TCP server on 127.0.0.1 that accepts connections and never answers. */
async function silentServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("the adapter over HTTP", () => {
  it("signs with the stub", async () => {
    stub.requests.length = 0;
    const signature = await signAt(baseUrl);
    assert.ok("r" in signature);
    assert.equal(stub.requests[0]?.stamped, true);
  });

  for (const status of [302, 307, 308]) {
    it(`refuses a ${status} and sends nothing to its location`, async () => {
      stub.requests.length = 0;
      stub.answer({ status, text: "", headers: { location: `${baseUrl}/collect` } });
      await assert.rejects(signAt(baseUrl), new RegExp(`Turnkey answered ${status}, a redirect`));
      assert.deepEqual(
        stub.requests.map((request) => request.path),
        [SIGN_PATH],
      );
    });
  }

  it("reports a closed port as unreachable, with the error's code, after 4 attempts", async () => {
    const silent = await silentServer();
    const { url } = silent;
    await silent.close();
    await assert.rejects(
      signAt(url),
      /Turnkey could not be reached after 4 attempts \(ECONNREFUSED\)/,
    );
  });

  it("stops at once when the signal aborts while Turnkey has not answered", async () => {
    const silent = await silentServer();
    try {
      const ctx = signContext();
      const reason = new Error("no answer in time");
      const signing = signAt(silent.url, ctx);
      setTimeout(() => ctx.controller.abort(reason), 50);
      const started = Date.now();
      await assert.rejects(signing, (error) => error === reason);
      assert.ok(Date.now() - started < 1000);
    } finally {
      await silent.close();
    }
  });
});
