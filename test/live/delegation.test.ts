// The live tests' cleanup of a delegation an earlier run left on a test account (#685), against a
// fake client. Runs offline, in `pnpm test`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Address, Hash, Hex, SignedAuthorization } from "viem";

import {
  type ClearRequest,
  clearLeftoverDelegation,
  type DelegationReads,
} from "./helpers/delegation.ts";

const ACCOUNT: Address = "0x728743B36DE6236f6d03409563a7E2c39a00EE17";
const DELEGATED: Hex = "0xef0100e8a52f3c8e91db910f2cfa278cded7033d6b6271";
const HASH: Hash = `0x${"ab".repeat(32)}`;

/** A client whose account has `code` until the clearing transaction is mined. */
function fakeClient(options: {
  code: Hex | undefined;
  codeAfter?: Hex | undefined;
  status?: "success" | "reverted";
  pending?: number;
}): { client: DelegationReads; codeReads: (bigint | undefined)[] } {
  const codeReads: (bigint | undefined)[] = [];
  const client: DelegationReads = {
    getCode: async ({ blockNumber }) => {
      codeReads.push(blockNumber);
      return await Promise.resolve(blockNumber === undefined ? options.code : options.codeAfter);
    },
    getTransactionCount: async () => await Promise.resolve(options.pending ?? 260),
    waitForTransactionReceipt: async () =>
      await Promise.resolve({ status: options.status ?? "success", blockNumber: 12_072_700n }),
  };
  return { client, codeReads };
}

/** Records what would be signed and sent. */
function recorder(): {
  authorize: (nonce: number) => Promise<SignedAuthorization>;
  send: (request: ClearRequest) => Promise<Hash>;
  nonces: number[];
  sent: ClearRequest[];
} {
  const nonces: number[] = [];
  const sent: ClearRequest[] = [];
  return {
    nonces,
    sent,
    authorize: async (nonce) => {
      nonces.push(nonce);
      return await Promise.resolve({
        address: "0x0000000000000000000000000000000000000000",
        chainId: 11_155_111,
        nonce,
        r: "0x01",
        s: "0x02",
        yParity: 0,
      });
    },
    send: async (request) => {
      sent.push(request);
      return await Promise.resolve(HASH);
    },
  };
}

describe("clearing a delegation an earlier live run left (#685)", () => {
  it("sends nothing when the account has no code", async () => {
    for (const code of [undefined, "0x" as const]) {
      const { client } = fakeClient({ code });
      const record = recorder();
      const block = await clearLeftoverDelegation({
        account: ACCOUNT,
        publicClient: client,
        ...record,
        timeoutMs: 1000,
      });
      assert.equal(block, undefined);
      assert.deepEqual(record.sent, []);
    }
  });

  it("sends the account's authorization of the zero address to itself, then checks the code at the receipt's block", async () => {
    const { client, codeReads } = fakeClient({ code: DELEGATED, codeAfter: "0x", pending: 260 });
    const record = recorder();
    const block = await clearLeftoverDelegation({
      account: ACCOUNT,
      publicClient: client,
      ...record,
      timeoutMs: 1000,
    });
    assert.equal(block, 12_072_700n);
    // The sender is the authority: its authorization takes the nonce after the transaction's.
    assert.deepEqual(record.nonces, [261]);
    assert.equal(record.sent.length, 1);
    assert.equal(record.sent[0]?.to, ACCOUNT);
    assert.equal(record.sent[0]?.nonce, 260);
    assert.equal(record.sent[0]?.authorizationList[0]?.nonce, 261);
    assert.deepEqual(codeReads, [undefined, 12_072_700n]);
  });

  it("refuses code that is not a delegation, and sends nothing", async () => {
    const { client } = fakeClient({ code: "0x6080604052" });
    const record = recorder();
    await assert.rejects(
      clearLeftoverDelegation({
        account: ACCOUNT,
        publicClient: client,
        ...record,
        timeoutMs: 1000,
      }),
      /not an EIP-7702 delegation/,
    );
    assert.deepEqual(record.sent, []);
  });

  it("fails when the clearing transaction reverts or leaves code", async () => {
    const reverted = fakeClient({ code: DELEGATED, codeAfter: "0x", status: "reverted" });
    await assert.rejects(
      clearLeftoverDelegation({
        account: ACCOUNT,
        publicClient: reverted.client,
        ...recorder(),
        timeoutMs: 1000,
      }),
      /reverted/,
    );
    const stayed = fakeClient({ code: DELEGATED, codeAfter: DELEGATED });
    await assert.rejects(
      clearLeftoverDelegation({
        account: ACCOUNT,
        publicClient: stayed.client,
        ...recorder(),
        timeoutMs: 1000,
      }),
      /still has code/,
    );
  });
});
