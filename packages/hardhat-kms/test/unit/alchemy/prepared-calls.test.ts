// checkPreparedCalls against responses that the real `prepareCalls` of `@alchemy/wallet-apis` 5.3.0
// produced (test/fixtures/alchemy-prepared-calls.ts). Each refusal changes one field of an honest
// response, and recomputes the hash when the field is part of the user operation, so that only the
// check under test can fail. Messages are compared in full.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardhatPluginError } from "hardhat/plugins";
import { concat, encodeFunctionData, parseAbi, type Hex } from "viem";
import {
  entryPoint07Address,
  getUserOperationHash,
  type UserOperation,
} from "viem/account-abstraction";

import {
  checkPreparedCalls,
  type PreparedCallsExpectation,
} from "../../../src/internal/alchemy/prepared-calls.ts";
import {
  CHAIN_ID,
  DELEGATE,
  DELEGATED_CODE,
  FIRST_SEND,
  LATER_SEND,
  SENDER,
} from "../../fixtures/alchemy-prepared-calls.ts";

const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ZERO = "0x0000000000000000000000000000000000000000";
/** {@link OTHER} with the case of one letter changed, so its EIP-55 checksum is wrong. */
const BAD_CHECKSUM = "0x70997970c51812dc3A010C7d01b50e0d17dc79C8";
const ADDRESS_FORM = "an address: 0x and 40 hex digits, lowercase or with a valid EIP-55 checksum";
const ACCOUNT_ABI = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
  "function upgradeToAndCall(address newImplementation, bytes data)",
]);

const LATER: PreparedCallsExpectation = {
  calls: LATER_SEND.calls,
  sender: SENDER,
  chainId: CHAIN_ID,
  delegate: DELEGATE,
  accountCode: DELEGATED_CODE,
  sponsored: false,
};

const FIRST: PreparedCallsExpectation = {
  calls: FIRST_SEND.calls,
  sender: SENDER,
  chainId: CHAIN_ID,
  delegate: DELEGATE,
  accountCode: undefined,
  sponsored: true,
};

const [AUTHORIZATION, FIRST_OPERATION] = FIRST_SEND.prepared.data;

type Changes = Partial<UserOperation<"0.7">>;

/** The EntryPoint v0.7 hash of a user operation on Sepolia. */
function hashOf(operation: Omit<UserOperation<"0.7">, "signature">): Hex {
  return getUserOperationHash({
    chainId: CHAIN_ID,
    entryPointAddress: entryPoint07Address,
    entryPointVersion: "0.7",
    userOperation: { ...operation, signature: "0x" },
  });
}

/** The later send's response with changed user operation fields, and a matching hash. */
function later(changes: Changes = {}): object {
  const data = { ...LATER_SEND.prepared.data, ...changes };
  return {
    ...LATER_SEND.prepared,
    data,
    signatureRequest: { ...LATER_SEND.prepared.signatureRequest, data: { raw: hashOf(data) } },
  };
}

/** The first send's user operation with changed fields, and a matching hash. */
function firstOperation(changes: Changes = {}): object {
  const data = { ...FIRST_OPERATION.data, ...changes };
  return {
    ...FIRST_OPERATION,
    data,
    signatureRequest: { ...FIRST_OPERATION.signatureRequest, data: { raw: hashOf(data) } },
  };
}

/** The first send's response with a changed user operation or authorization. */
function first(changes: Changes = {}, authorization: object = AUTHORIZATION): object {
  return { type: "array", data: [authorization, firstOperation(changes)] };
}

/** callData for these calls, as Modular Account v2 `executeBatch`. */
function batch(calls: readonly { to: Hex; value: bigint; data: Hex }[]): Hex {
  return encodeFunctionData({
    abi: ACCOUNT_ABI,
    functionName: "executeBatch",
    args: [calls.map((call) => ({ target: call.to, value: call.value, data: call.data }))],
  });
}

const LATER_CALL = { to: LATER_SEND.calls[0].to, value: 0n, data: "0x" } as const;

function refuses(prepared: unknown, expected: PreparedCallsExpectation, message: string): void {
  assert.throws(
    () => {
      checkPreparedCalls(prepared, expected);
    },
    (error: unknown) => {
      assert.ok(error instanceof HardhatPluginError);
      assert.equal(error.message, message);
      return true;
    },
  );
}

const input = (field: string, expected: string): string =>
  `checkPreparedCalls: the expected ${field} is not valid. Expected ${expected}`;
const malformed = (field: string, part = "user operation"): string =>
  `the prepared ${part} has no valid ${field}`;
const withData = (field: string, value: unknown): object => ({
  ...LATER_SEND.prepared,
  data: { ...LATER_SEND.prepared.data, [field]: value },
});
const asks = (type: string): string =>
  `the user operation asks for a ${type} signature; only personal_sign over a raw 32-byte hash is accepted`;
const withRequest = (signatureRequest: unknown): object => ({
  ...LATER_SEND.prepared,
  signatureRequest,
});
const differ = (index: number, field: string): string =>
  `call ${String(index)} of the user operation has another ${field} than the call you requested`;

describe("checkPreparedCalls", () => {
  describe("accepts", () => {
    it("a later send that the SDK prepared, with no authorization", () => {
      checkPreparedCalls(LATER_SEND.prepared, LATER);
    });

    it("a first send that the SDK prepared, with an authorization and a paymaster", () => {
      checkPreparedCalls(FIRST_SEND.prepared, FIRST);
      checkPreparedCalls(FIRST_SEND.prepared, { ...FIRST, accountCode: "0x" });
    });

    it("an authorization to the delegate the account already has", () => {
      checkPreparedCalls(FIRST_SEND.prepared, { ...FIRST, accountCode: DELEGATED_CODE });
      checkPreparedCalls(FIRST_SEND.prepared, {
        ...FIRST,
        accountCode: `0xEF0100${DELEGATE.slice(2).toUpperCase()}`,
      });
    });

    it("the user operation before the authorization in the array", () => {
      checkPreparedCalls({ type: "array", data: [FIRST_OPERATION, AUTHORIZATION] }, FIRST);
    });

    it("an array with only the user operation, from an account already delegated", () => {
      checkPreparedCalls(
        { type: "array", data: [FIRST_OPERATION] },
        {
          ...FIRST,
          accountCode: DELEGATED_CODE,
        },
      );
    });

    it("a paymaster when no policy is set", () => {
      checkPreparedCalls(FIRST_SEND.prepared, { ...FIRST, sponsored: false });
    });

    it("one call encoded as execute", () => {
      const callData = encodeFunctionData({
        abi: ACCOUNT_ABI,
        functionName: "execute",
        args: [LATER_CALL.to, 0n, "0x"],
      });
      checkPreparedCalls(later({ callData }), LATER);
    });

    it("callData in uppercase hex", () => {
      const callData: Hex = `0x${LATER_SEND.prepared.data.callData.slice(2).toUpperCase()}`;
      checkPreparedCalls(later({ callData }), LATER);
    });

    it("callData behind the executeUserOp selector, in either case", () => {
      const callData = LATER_SEND.prepared.data.callData;
      checkPreparedCalls(later({ callData: concat(["0x8dd7712f", callData]) }), LATER);
      checkPreparedCalls(later({ callData: concat(["0x8DD7712F", callData]) }), LATER);
    });

    it("requested calls in other forms: any address case, explicit zero value and empty data", () => {
      const lower = LATER_CALL.to.toLowerCase();
      for (const call of [
        { to: lower },
        { to: lower, value: 0n, data: "0x" },
        { to: lower, value: undefined, data: undefined },
      ] as const) {
        checkPreparedCalls(LATER_SEND.prepared, { ...LATER, calls: [call] });
      }
      const [transfer, token] = FIRST_SEND.calls;
      checkPreparedCalls(FIRST_SEND.prepared, {
        ...FIRST,
        calls: [
          transfer,
          { to: token.to.toLowerCase(), data: `0x${token.data.slice(2).toUpperCase()}` },
        ],
      });
    });

    it("a hash and a sender in another letter case", () => {
      const lowerSender: Hex = `0x${SENDER.slice(2).toLowerCase()}`;
      const response = later({ sender: lowerSender });
      checkPreparedCalls(response, { ...LATER, sender: SENDER.toLowerCase() });
      checkPreparedCalls(LATER_SEND.prepared, { ...LATER, sender: SENDER.toLowerCase() });
      const upper = {
        ...LATER_SEND.prepared,
        signatureRequest: {
          ...LATER_SEND.prepared.signatureRequest,
          data: {
            raw: `0x${LATER_SEND.prepared.signatureRequest.data.raw.slice(2).toUpperCase()}`,
          },
        },
      };
      checkPreparedCalls(upper, LATER);
    });
  });

  describe("refuses what it was asked to check against", () => {
    const calls = "a non-empty array of { to, value?, data? }";

    it("calls that are missing, empty or malformed", () => {
      const withCalls = (value: unknown): PreparedCallsExpectation => {
        const expected = { ...LATER };
        Reflect.set(expected, "calls", value);
        return expected;
      };
      refuses(LATER_SEND.prepared, withCalls(undefined), input("calls", calls));
      refuses(LATER_SEND.prepared, withCalls([]), input("calls", calls));
      const address = ADDRESS_FORM;
      refuses(
        LATER_SEND.prepared,
        withCalls([null]),
        input("calls[0]", "an object { to, value?, data? }"),
      );
      refuses(
        LATER_SEND.prepared,
        withCalls([{ to: BAD_CHECKSUM }]),
        input("calls[0].to", address),
      );
      refuses(
        LATER_SEND.prepared,
        withCalls([LATER_CALL, { to: "0x1234" }]),
        input("calls[1].to", address),
      );
      refuses(LATER_SEND.prepared, withCalls([{ to: 5 }]), input("calls[0].to", address));
      const value = "a non-negative bigint";
      refuses(
        LATER_SEND.prepared,
        withCalls([{ to: OTHER, value: -1n }]),
        input("calls[0].value", value),
      );
      refuses(
        LATER_SEND.prepared,
        withCalls([{ to: OTHER, value: 1 }]),
        input("calls[0].value", value),
      );
      const data = "0x and an even number of hex digits";
      for (const bad of ["0x123", "1234", "0xzz", 12]) {
        refuses(
          LATER_SEND.prepared,
          withCalls([{ to: OTHER, data: bad }]),
          input("calls[0].data", data),
        );
      }
      checkPreparedCalls(later({ callData: batch([{ to: OTHER, value: 0n, data: "0x" }]) }), {
        ...LATER,
        calls: [{ to: OTHER, value: 0n }],
      });
    });

    it("a sender or a delegate that is not an address", () => {
      const address = ADDRESS_FORM;
      refuses(LATER_SEND.prepared, { ...LATER, sender: BAD_CHECKSUM }, input("sender", address));
      refuses(LATER_SEND.prepared, { ...LATER, sender: "0x1234" }, input("sender", address));
      const sender = { ...LATER };
      Reflect.set(sender, "sender", 1);
      refuses(LATER_SEND.prepared, sender, input("sender", address));
      refuses(LATER_SEND.prepared, { ...LATER, delegate: "owner" }, input("delegate", address));
      refuses(
        LATER_SEND.prepared,
        { ...LATER, delegate: ZERO },
        input("delegate", "a contract address, not the zero address"),
      );
    });

    it("a chain id that is not a positive integer", () => {
      for (const chainId of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
        refuses(LATER_SEND.prepared, { ...LATER, chainId }, input("chainId", "a positive integer"));
      }
      const asBigint = { ...LATER };
      Reflect.set(asBigint, "chainId", 11155111n);
      refuses(LATER_SEND.prepared, asBigint, input("chainId", "a positive integer"));
    });

    it("account code that is not hex", () => {
      const code = "the hex code that getCode returns, or undefined";
      for (const accountCode of ["0xef010", "ef0100", "0xgg", 1]) {
        const expected = { ...LATER };
        Reflect.set(expected, "accountCode", accountCode);
        refuses(LATER_SEND.prepared, expected, input("accountCode", code));
      }
    });

    it("sponsored that is not a boolean", () => {
      const expected = { ...LATER };
      Reflect.set(expected, "sponsored", "yes");
      refuses(LATER_SEND.prepared, expected, input("sponsored", "true or false"));
    });
  });

  describe("refuses a response of another kind", () => {
    const only =
      "; only a user-operation-v070, or an array of one user-operation-v070 and at most one authorization, is accepted";
    const typed = (type: string): string => `the prepared calls are ${type}${only}`;

    it("a single response of another type", () => {
      for (const type of [
        "paymaster-permit",
        "authorization",
        "user-operation-v060",
        "solana-transaction-v0",
      ]) {
        refuses({ ...LATER_SEND.prepared, type }, LATER, typed(type));
      }
      refuses({ ...LATER_SEND.prepared, type: "x y" }, LATER, typed("of an unknown type"));
      refuses({ ...LATER_SEND.prepared, type: 7 }, LATER, typed("of an unknown type"));
      refuses(null, LATER, typed("of an unknown type"));
      refuses([LATER_SEND.prepared], LATER, typed("of an unknown type"));
    });

    it("an array without exactly one user operation and at most one authorization", () => {
      refuses({ type: "array", data: {} }, LATER, typed("array"));
      refuses({ type: "array" }, LATER, typed("array"));
      refuses(
        { type: "array", data: [AUTHORIZATION] },
        FIRST,
        typed("an array of [authorization]"),
      );
      refuses(
        { type: "array", data: [FIRST_OPERATION, FIRST_OPERATION] },
        FIRST,
        typed("an array of [user-operation-v070, user-operation-v070]"),
      );
      refuses(
        { type: "array", data: [AUTHORIZATION, AUTHORIZATION, FIRST_OPERATION] },
        FIRST,
        typed("an array of [authorization, authorization, user-operation-v070]"),
      );
      refuses(
        { type: "array", data: [AUTHORIZATION, FIRST_OPERATION, null] },
        FIRST,
        typed("an array of [authorization, user-operation-v070, of an unknown type]"),
      );
      refuses(
        { type: "array", data: [{ ...FIRST_OPERATION, type: "user-operation-v060" }] },
        FIRST,
        typed("an array of [user-operation-v060]"),
      );
      refuses({ type: "array", data: [] }, FIRST, typed("an array of []"));
      refuses(
        { type: "array", data: [FIRST_OPERATION, { type: "other" }] },
        FIRST,
        typed("an array of [user-operation-v070, of an unknown type]"),
      );
      refuses(
        { type: "array", data: [FIRST_OPERATION, null] },
        FIRST,
        typed("an array of [user-operation-v070, of an unknown type]"),
      );
      refuses(
        { type: "user-operation-v060", data: [FIRST_OPERATION] },
        FIRST,
        typed("user-operation-v060"),
      );
    });
  });

  describe("refuses a malformed user operation", () => {
    it("with a chain id that is not a number", () => {
      refuses({ ...LATER_SEND.prepared, chainId: "0xaa36a7" }, LATER, malformed("chainId"));
      refuses({ ...LATER_SEND.prepared, chainId: 1.5 }, LATER, malformed("chainId"));
    });

    it("with no data, sender or callData", () => {
      refuses({ ...LATER_SEND.prepared, data: undefined }, LATER, malformed("data"));
      refuses(withData("sender", "0x1234"), LATER, malformed("sender"));
      refuses(withData("sender", 1), LATER, malformed("sender"));
      refuses(withData("callData", "34fcd5be"), LATER, malformed("callData"));
    });

    it("with a quantity that is not a bigint", () => {
      for (const field of [
        "nonce",
        "callGasLimit",
        "verificationGasLimit",
        "preVerificationGas",
        "maxFeePerGas",
        "maxPriorityFeePerGas",
      ]) {
        refuses(withData(field, "0x1"), LATER, malformed(field));
      }
    });

    it("with an optional field of the wrong type", () => {
      refuses(withData("factory", "0x12"), LATER, malformed("factory"));
      refuses(withData("factoryData", "12"), LATER, malformed("factoryData"));
      refuses(withData("paymaster", 1), LATER, malformed("paymaster"));
      refuses(withData("paymasterData", "zz"), LATER, malformed("paymasterData"));
      refuses(
        withData("paymasterVerificationGasLimit", 1),
        LATER,
        malformed("paymasterVerificationGasLimit"),
      );
      refuses(
        withData("paymasterPostOpGasLimit", "0x0"),
        LATER,
        malformed("paymasterPostOpGasLimit"),
      );
    });

    it("with an authorization that has no chain id or address", () => {
      refuses(
        first({}, { ...AUTHORIZATION, chainId: "0xaa36a7" }),
        FIRST,
        malformed("chainId", "authorization"),
      );
      refuses(
        first({}, { ...AUTHORIZATION, data: { ...AUTHORIZATION.data, address: "0x12" } }),
        FIRST,
        malformed("address", "authorization"),
      );
      refuses(
        first({}, { ...AUTHORIZATION, data: null }),
        FIRST,
        malformed("address", "authorization"),
      );
    });
  });

  describe("refuses a signature request other than personal_sign over a raw hash", () => {
    it("typed data", () => {
      refuses(
        withRequest({
          type: "eth_signTypedData_v4",
          data: { types: {}, primaryType: "X", message: {} },
          rawPayload: "0x00",
        }),
        LATER,
        asks("eth_signTypedData_v4"),
      );
    });

    it("a text message, or a raw value that is not hex", () => {
      refuses(
        withRequest({ type: "personal_sign", data: "hello", rawPayload: "0x00" }),
        LATER,
        asks("personal_sign"),
      );
      refuses(
        withRequest({ type: "personal_sign", data: { raw: 1 } }),
        LATER,
        asks("personal_sign"),
      );
      refuses(withRequest({ type: "personal_sign", data: null }), LATER, asks("personal_sign"));
    });

    it("no request, or one of an unknown type", () => {
      refuses(withRequest(undefined), LATER, asks("missing or unknown kind of"));
      refuses(
        withRequest({ type: "sign_everything", data: { raw: "0x00" } }),
        LATER,
        asks("missing or unknown kind of"),
      );
      refuses(withRequest({ type: 1 }), LATER, asks("missing or unknown kind of"));
      refuses(withRequest(null), LATER, asks("missing or unknown kind of"));
    });

    it("an authorization request in place of the user operation's", () => {
      refuses(withRequest({ type: "eip7702Auth", rawPayload: "0x00" }), LATER, asks("eip7702Auth"));
    });
  });

  describe("refuses a user operation that does not match the request", () => {
    it("on another chain", () => {
      refuses(
        { ...LATER_SEND.prepared, chainId: 1 },
        LATER,
        "the prepared user operation is for chain 1, not chain 11155111",
      );
    });

    it("from another sender", () => {
      refuses(
        later({ sender: OTHER }),
        LATER,
        `the user operation's sender is ${OTHER}, not ${SENDER}`,
      );
    });

    it("with a factory or factory data", () => {
      const message =
        "the user operation names a factory; an EIP-7702 account is never deployed by one";
      refuses(later({ factory: OTHER, factoryData: "0x" }), LATER, message);
      refuses(later({ factory: OTHER }), LATER, message);
      refuses(later({ factoryData: "0x1234" }), LATER, message);
    });

    it("whose hash is not the user operation's", () => {
      const message =
        "the hash in the signature request is not the EntryPoint v0.7 hash of the returned user operation on chain 11155111";
      const signatureRequest = LATER_SEND.prepared.signatureRequest;
      refuses(
        {
          ...LATER_SEND.prepared,
          signatureRequest: { ...signatureRequest, data: { raw: `0x${"00".repeat(32)}` } },
        },
        LATER,
        message,
      );
      // The hash of the same user operation on another chain.
      const otherChain = getUserOperationHash({
        chainId: 1,
        entryPointAddress: entryPoint07Address,
        entryPointVersion: "0.7",
        userOperation: { ...LATER_SEND.prepared.data, signature: "0x" },
      });
      refuses(
        {
          ...LATER_SEND.prepared,
          signatureRequest: { ...signatureRequest, data: { raw: otherChain } },
        },
        LATER,
        message,
      );
      // A changed field that the hash covers, with the old hash.
      refuses(
        { ...LATER_SEND.prepared, data: { ...LATER_SEND.prepared.data, nonce: 1n } },
        LATER,
        message,
      );
      const { paymasterData: _, ...noPaymasterData } = FIRST_OPERATION.data;
      refuses(
        { type: "array", data: [AUTHORIZATION, { ...FIRST_OPERATION, data: noPaymasterData }] },
        FIRST,
        message,
      );
      refuses(
        {
          type: "array",
          data: [
            AUTHORIZATION,
            { ...FIRST_OPERATION, data: { ...FIRST_OPERATION.data, paymasterPostOpGasLimit: 1n } },
          ],
        },
        FIRST,
        message,
      );
    });

    it("whose callData is not execute or executeBatch", () => {
      const message =
        "the user operation's callData is not a Modular Account v2 execute or executeBatch call";
      const upgrade = encodeFunctionData({
        abi: ACCOUNT_ABI,
        functionName: "upgradeToAndCall",
        args: [OTHER, "0x"],
      });
      refuses(later({ callData: upgrade }), LATER, message);
      refuses(later({ callData: concat(["0x8dd7712f", upgrade]) }), LATER, message);
      refuses(later({ callData: "0xdeadbeef" }), LATER, message);
      refuses(later({ callData: "0x" }), LATER, message);
      const truncated: Hex = `0x${LATER_SEND.prepared.data.callData.slice(2, 74)}`;
      refuses(later({ callData: truncated }), LATER, message);
    });

    it("whose callData has bytes beyond the standard encoding", () => {
      refuses(
        later({ callData: concat([LATER_SEND.prepared.data.callData, "0x00"]) }),
        LATER,
        "the user operation's callData is not the standard encoding of its executeBatch call",
      );
      const execute = encodeFunctionData({
        abi: ACCOUNT_ABI,
        functionName: "execute",
        args: [LATER_CALL.to, 0n, "0x"],
      });
      refuses(
        later({ callData: concat([execute, `0x${"00".repeat(32)}`]) }),
        LATER,
        "the user operation's callData is not the standard encoding of its execute call",
      );
    });

    it("with more or fewer calls", () => {
      const two = batch([LATER_CALL, LATER_CALL]);
      refuses(
        later({ callData: two }),
        LATER,
        "the user operation makes 2 calls, and you requested 1",
      );
      refuses(
        LATER_SEND.prepared,
        { ...LATER, calls: [LATER_CALL, LATER_CALL] },
        "the user operation makes 1 calls, and you requested 2",
      );
      refuses(
        later({ callData: batch([]) }),
        LATER,
        "the user operation makes 0 calls, and you requested 1",
      );
    });

    it("with a call to another address, with another value or with other data", () => {
      refuses(later({ callData: batch([{ ...LATER_CALL, to: OTHER }]) }), LATER, differ(0, "to"));
      refuses(
        later({ callData: batch([{ ...LATER_CALL, value: 1n }]) }),
        LATER,
        differ(0, "value"),
      );
      refuses(
        later({ callData: batch([{ ...LATER_CALL, data: "0x00" }]) }),
        LATER,
        differ(0, "data"),
      );
      const [transfer, token] = FIRST_SEND.calls;
      refuses(
        FIRST_SEND.prepared,
        { ...FIRST, calls: [transfer, { ...token, data: `0x${token.data.slice(2, -2)}0b` }] },
        differ(1, "data"),
      );
      refuses(FIRST_SEND.prepared, { ...FIRST, calls: [token, transfer] }, differ(0, "to"));
      refuses(
        FIRST_SEND.prepared,
        { ...FIRST, calls: [{ ...transfer, value: transfer.value + 1n }, token] },
        differ(0, "value"),
      );
    });
  });

  describe("with a policy set, refuses a user operation the policy does not pay for", () => {
    const noPaymaster =
      "a policy is set, but the user operation names no paymaster, so the account would pay the gas";
    const notSponsored =
      "a policy is set, but the response's feePayment says the gas is not sponsored";

    it("with no paymaster, or the zero address", () => {
      refuses(LATER_SEND.prepared, { ...LATER, sponsored: true }, noPaymaster);
      refuses(first({ paymaster: ZERO }), FIRST, noPaymaster);
    });

    it("with feePayment not sponsored, or missing", () => {
      const operation = firstOperation();
      const unsponsored = {
        ...operation,
        feePayment: { ...FIRST_OPERATION.feePayment, sponsored: false },
      };
      refuses({ type: "array", data: [AUTHORIZATION, unsponsored] }, FIRST, notSponsored);
      refuses(
        { type: "array", data: [AUTHORIZATION, { ...operation, feePayment: undefined }] },
        FIRST,
        notSponsored,
      );
      const truthy = {
        ...operation,
        feePayment: { ...FIRST_OPERATION.feePayment, sponsored: "true" },
      };
      refuses({ type: "array", data: [AUTHORIZATION, truthy] }, FIRST, notSponsored);
    });
  });

  describe("refuses a delegation other than the pinned one", () => {
    const elsewhere = `the account is delegated to ${OTHER}, not to ${DELEGATE}`;
    const otherCode = `0xef0100${OTHER.slice(2)}` as const;

    it("an authorization to another delegate", () => {
      refuses(
        first({}, { ...AUTHORIZATION, data: { ...AUTHORIZATION.data, address: OTHER } }),
        FIRST,
        `the authorization delegates the account to ${OTHER}, not to ${DELEGATE}`,
      );
      refuses(
        first({}, { ...AUTHORIZATION, data: { ...AUTHORIZATION.data, address: ZERO } }),
        FIRST,
        `the authorization delegates the account to ${ZERO}, not to ${DELEGATE}`,
      );
    });

    it("an authorization for another chain, or for every chain", () => {
      for (const chainId of [0, 1]) {
        refuses(
          first({}, { ...AUTHORIZATION, chainId }),
          FIRST,
          `the prepared authorization is for chain ${String(chainId)}, not chain 11155111`,
        );
      }
    });

    it("a re-delegation of an account delegated elsewhere", () => {
      refuses(FIRST_SEND.prepared, { ...FIRST, accountCode: otherCode }, elsewhere);
    });

    it("a user operation under another delegate", () => {
      refuses(LATER_SEND.prepared, { ...LATER, accountCode: otherCode }, elsewhere);
    });

    it("a user operation from an address with no delegation and no authorization", () => {
      const message = "the account has no delegation, and the response has no authorization";
      refuses(LATER_SEND.prepared, { ...LATER, accountCode: undefined }, message);
      refuses(LATER_SEND.prepared, { ...LATER, accountCode: "0x" }, message);
    });

    it("an account with contract code", () => {
      const message = "the account has contract code that is not an EIP-7702 delegation";
      const delegate = DELEGATE.slice(2);
      for (const accountCode of [
        "0x6080",
        `0xef0100${delegate}00`,
        `0xef0100${delegate.slice(2)}`,
        `0xef0200${delegate}`,
        `0x00ef01${delegate}`,
      ] as const) {
        refuses(LATER_SEND.prepared, { ...LATER, accountCode }, message);
        refuses(FIRST_SEND.prepared, { ...FIRST, accountCode }, message);
      }
    });
  });
});
