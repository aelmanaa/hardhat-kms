import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { crc32cMatches, int64Value, networkErrorCode, statusOf } from "../../src/internal/wire.ts";

const withCode = (code: unknown) => Object.assign(new Error("x"), { code });
const withCause = (cause: unknown) => Object.assign(new Error("x"), { cause });

describe("Google Cloud KMS wire formats", () => {
  it("reads Int64Value checksums in every form the SDK uses", () => {
    // protobufjs's Long prints itself in decimal.
    const long = { toString: () => "4294967295" };
    assert.equal(int64Value({ value: 123 }), 123);
    assert.equal(int64Value({ value: "4294967295" }), 4_294_967_295);
    assert.equal(int64Value({ value: 7n }), 7);
    assert.equal(int64Value({ value: long }), 4_294_967_295);
    for (const bad of [
      undefined,
      null,
      "123",
      {},
      { value: null },
      { value: -1 },
      { value: "1e3" },
      { value: "" },
      { value: 1.5 },
      { value: "99999999999999999" },
      { value: {} },
      { value: { toString: () => 5 } },
    ]) {
      assert.equal(int64Value(bad), undefined, JSON.stringify(bad));
    }
  });

  it("matches CRC32C only when the checksum is present and right", () => {
    const bytes = new TextEncoder().encode("123456789");
    assert.ok(crc32cMatches(bytes, { value: "3808858755" }));
    assert.ok(!crc32cMatches(bytes, { value: "3808858754" }));
    assert.ok(!crc32cMatches(bytes, undefined));
    assert.ok(!crc32cMatches(bytes, null));
  });

  it("names gRPC statuses from the SDK's numeric codes", () => {
    assert.equal(statusOf(withCode(9)), "FAILED_PRECONDITION");
    assert.equal(statusOf(withCode(16)), "UNAUTHENTICATED");
    assert.equal(statusOf(withCode(17)), undefined);
    assert.equal(statusOf(withCode("9")), undefined);
    assert.equal(statusOf(withCode(1.5)), undefined);
    assert.equal(statusOf(new Error("x")), undefined);
    assert.equal(statusOf({ code: 9 }), undefined);
  });

  it("reads the network error code under an SDK error, and nothing else", () => {
    assert.equal(networkErrorCode(withCause({ code: "ECONNREFUSED" })), "ECONNREFUSED");
    assert.equal(networkErrorCode(withCause({ code: "ENOTFOUND" })), "ENOTFOUND");
    for (const bad of [
      withCause({ code: "connect ECONNREFUSED 10.0.0.1:443" }),
      withCause({ code: 111 }),
      withCause("ECONNREFUSED"),
      withCause(undefined),
      new Error("x"),
      { cause: { code: "ECONNREFUSED" } },
    ]) {
      assert.equal(networkErrorCode(bad), undefined);
    }
  });
});
