// The debug lines of library accounts, under DEBUG=hardhat:kms:account.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ADDRESS, CHAIN_ID, setup } from "../../helpers/library-account.ts";

// A logger reads DEBUG when it is created, and account.ts creates its logger when it loads, so
// DEBUG is set before it is imported. Each test file runs in its own process.
process.env.DEBUG = "hardhat:kms:account";
process.env.DEBUG_COLORS = "no";
const { createKmsNetworkConnection } = await import("../../../src/internal/viem/account.ts");

const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

let written: string[] = [];
let restore: (() => void) | undefined;

/** The account's debug lines written so far, without the namespace and the time since the last. */
function lines(): string[] {
  return written
    .join("")
    .split("\n")
    .flatMap((line) => {
      const match = /hardhat:kms:account (.*?)(?: \+\d+\w+)?$/.exec(line);
      return match?.[1] === undefined ? [] : [match[1]];
    });
}

describe("library account debug lines", () => {
  beforeEach(() => {
    written = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    restore = () => {
      process.stderr.write = original;
    };
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("logs the account, each transaction and each authorization", async () => {
    const { connection } = setup();
    const account = await createKmsNetworkConnection(connection).getAccount(ADDRESS);
    await account.signTransaction({
      type: "eip1559",
      chainId: CHAIN_ID,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      to: TO,
    });
    await account.signAuthorization({ address: TO, chainId: CHAIN_ID, nonce: 0 });
    assert.deepEqual(lines(), [
      `${ADDRESS}: account for network local`,
      `${ADDRESS}: signing a eip1559 transaction for chain 31337`,
      `${ADDRESS}: signing an authorization for chain 31337`,
    ]);
  });
});
