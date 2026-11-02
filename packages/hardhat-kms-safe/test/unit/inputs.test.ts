import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeFunctionData, parseAbi } from "viem";

import { serviceFor, safeAppLink, SERVICE_CHAINS } from "../../src/internal/chains.ts";
import { callData, encodeCall } from "../../src/internal/tasks/inputs.ts";

const OWNER = "0x79613FD49472C3C7a32188e45ff00e7bdC8a897d";

describe("call data from the task's options", () => {
  it("passes --data through, or 0x", () => {
    assert.equal(callData(undefined, undefined, undefined), "0x");
    assert.equal(callData("0x1234", undefined, undefined), "0x1234");
  });

  it("encodes --function with --args, with integers as strings or numbers", () => {
    const abi = parseAbi(["function addOwnerWithThreshold(address owner, uint256 threshold)"]);
    const expected = encodeFunctionData({ abi, args: [OWNER, 2n] });
    assert.equal(
      encodeCall("addOwnerWithThreshold(address,uint256)", `["${OWNER}", "2"]`),
      expected,
    );
    assert.equal(
      encodeCall("function addOwnerWithThreshold(address,uint256)", `["${OWNER}", 2]`),
      expected,
    );
    assert.equal(callData(undefined, "pause()", undefined), "0x8456cb59");
    assert.equal(
      encodeCall(
        "setLimit(uint256)",
        '["115792089237316195423570985008687907853269984665640564039457584007913129639935"]',
      ),
      `0x27ea6f2b${"f".repeat(64)}`,
    );
  });

  it("refuses what it cannot encode", () => {
    assert.throws(() => callData("0x", "pause()", undefined), /either --data or --function/);
    assert.throws(() => callData(undefined, undefined, "[]"), /--args needs --function/);
    assert.throws(
      () => encodeCall("not a signature", "[]"),
      /--function is not a function signature/,
    );
    assert.throws(
      () => encodeCall("event Paused()", "[]"),
      /--function is not a function signature/,
    );
    assert.throws(() => encodeCall("pause()", "{"), /--args is not JSON/);
    assert.throws(() => encodeCall("pause()", "{}"), /--args is not a JSON array/);
    assert.throws(() => encodeCall("pause()", "[1]"), /pause takes 0 arguments and --args has 1/);
    assert.throws(() => encodeCall("set(uint256)", '["x"]'), /argument 1 is not an integer/);
    assert.throws(
      () => encodeCall("set(address)", '["0x12"]'),
      /an argument does not fit its parameter's type/,
    );
  });
});

describe("Transaction Service chains", () => {
  it("serves Sepolia, Base Sepolia and mainnet from Safe's gateway, and not Avalanche Fuji", () => {
    assert.deepEqual(serviceFor(11155111n, {}), {
      url: "https://api.safe.global/tx-service/sep",
      hosted: true,
    });
    assert.equal(serviceFor(84532n, {})?.url, "https://api.safe.global/tx-service/basesep");
    assert.equal(serviceFor(1n, {})?.url, "https://api.safe.global/tx-service/eth");
    assert.equal(serviceFor(43113n, {}), undefined);
    assert.equal(SERVICE_CHAINS.has(43113n), false);
  });

  it("prefers a configured service, keyed by decimal chain id", () => {
    assert.deepEqual(serviceFor(11155111n, { "11155111": "https://own.test" }), {
      url: "https://own.test",
      hosted: false,
    });
    assert.deepEqual(serviceFor(43113n, { "43113": "https://fuji.test" }), {
      url: "https://fuji.test",
      hosted: false,
    });
    assert.equal(serviceFor(43113n, { toString: "https://x.test" }), undefined);
  });

  it("links the Safe app's page of a queued transaction", () => {
    const hash = `0x${"ab".repeat(32)}` as const;
    assert.equal(
      safeAppLink(11155111n, OWNER, hash),
      `https://app.safe.global/transactions/tx?safe=sep:${OWNER}&id=multisig_${OWNER}_${hash}`,
    );
    assert.equal(safeAppLink(31337n, OWNER, hash), undefined);
  });
});
