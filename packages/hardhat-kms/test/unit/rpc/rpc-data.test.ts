// The plugin's own decoding of a field that hardhat-zod-utils' `rpcData` validated (#614).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rpcDataBytes } from "../../../src/internal/rpc/rpc-data.ts";

describe("rpcDataBytes", () => {
  it("reads 0x as no bytes, whatever the schema's copy of hardhat-utils made of it", () => {
    // hardhat-utils before 5.1.1 reads "0x" as one zero byte.
    assert.deepEqual(rpcDataBytes("0x", new Uint8Array([0])), new Uint8Array());
    assert.deepEqual(rpcDataBytes("0x", new Uint8Array()), new Uint8Array());
  });

  it("decodes each byte of a string, ignoring the parsed value", () => {
    assert.deepEqual(rpcDataBytes("0x00", new Uint8Array([9])), new Uint8Array([0]));
    assert.deepEqual(rpcDataBytes("0x12aB", new Uint8Array()), new Uint8Array([0x12, 0xab]));
  });

  it("keeps the parsed bytes of a value that is not a string, such as a Buffer", () => {
    const parsed = new Uint8Array([1, 2]);
    assert.equal(rpcDataBytes(Buffer.from([1, 2]), parsed), parsed);
  });
});
