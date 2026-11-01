// An authorizationList without `to`, or an empty one, through the network hook's handlers with a
// fake node (#586): refused before the fill's node requests and before any signature.
// eth_sendTransaction has read the chain id for its send lock by then; eth_signTransaction has not.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authorization } from "micro-eth-signer";

import { COW, setUp, TO } from "../../helpers/send-harness.ts";
import { COW_ACCOUNT } from "../../helpers/vectors.ts";

const signed = authorization.sign(
  { chainId: 31337n, address: TO, nonce: 1n },
  `0x${COW_ACCOUNT.secretKey}`,
);
const AUTHORIZATION = {
  chainId: "0x7a69",
  address: signed.address,
  nonce: "0x1",
  yParity: `0x${signed.yParity.toString(16)}`,
  r: `0x${signed.r.toString(16).padStart(64, "0")}`,
  s: `0x${signed.s.toString(16).padStart(64, "0")}`,
};

const CASES: [string, Record<string, unknown>, string][] = [
  [
    "without to",
    { from: COW, authorizationList: [AUTHORIZATION] },
    "an EIP-7702 transaction (authorizationList) needs `to`: it cannot create a contract. Nothing was signed or sent",
  ],
  [
    "with to: null",
    { from: COW, to: null, authorizationList: [AUTHORIZATION] },
    "an EIP-7702 transaction (authorizationList) needs `to`: it cannot create a contract. Nothing was signed or sent",
  ],
  [
    "with an empty list",
    { from: COW, to: TO, authorizationList: [] },
    "the authorizationList of an EIP-7702 transaction is empty: it needs at least one authorization. Nothing was signed or sent",
  ],
];

describe("an EIP-7702 request that cannot be one (#586)", () => {
  for (const [name, tx, message] of CASES) {
    it(`refuses eth_sendTransaction ${name} after the chain id only, and signs nothing`, async () => {
      const { node, state, open, send } = await setUp();
      const connection = await open();
      node.methods.length = 0;
      await assert.rejects(send(connection, tx), { message: `eth_sendTransaction: ${message}` });
      assert.deepEqual(node.methods, ["eth_chainId"]);
      assert.deepEqual(node.raw, []);
      assert.equal(state.signatures, 0);
    });

    it(`refuses eth_signTransaction ${name} before any node request, and signs nothing`, async () => {
      const { node, state, open, request } = await setUp();
      const connection = await open();
      node.methods.length = 0;
      await assert.rejects(request(connection, "eth_signTransaction", tx), {
        message: `eth_signTransaction: ${message}`,
      });
      assert.deepEqual(node.methods, []);
      assert.equal(state.signatures, 0);
    });
  }
});
