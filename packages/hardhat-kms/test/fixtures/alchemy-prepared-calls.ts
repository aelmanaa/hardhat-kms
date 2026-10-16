// What `prepareCalls` of `@alchemy/wallet-apis` 5.3.0 returns, for checkPreparedCalls tests.
//
// Made on 2026-10-16 in a scratch project with `@alchemy/wallet-apis@5.3.0`,
// `@alchemy/smart-accounts@5.3.0` and `viem@2.57.1` from npm: a stub transport answered
// `wallet_prepareCalls` with a wire response shaped like the example in
// `@alchemy/wallet-api-types@0.2.0-alpha.6` (`src/rpc/examples.ts`: gas values, paymaster data, a
// single call encoded as `executeBatch`), with the sender, chain and calls below, and the hash in
// the signature request computed with viem's `getUserOperationHash` for EntryPoint v0.7. The SDK's
// own `client.prepareCalls(...)` decoded each response; the objects below are its output as is
// (bigint quantities, a number chain id, the authorization nonce as a number). The calls of
// FIRST_SEND were encoded by `encodeCallsMAv2` from `@alchemy/smart-accounts`. The sender is the
// first Anvil and Hardhat test account, whose private key is public.

/** The chain of every fixture: Sepolia. */
export const CHAIN_ID = 11155111;

/** The key's address: the first Anvil and Hardhat test account. */
export const SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/** Modular Account v2 v1.1.0 (SemiModularAccount7702), the Wallet APIs' default delegate. */
export const DELEGATE = "0x77021100bD87b7008E5E1989d0eB38555d0d0000";

/** The code of an account that EIP-7702 delegated to {@link DELEGATE}. */
export const DELEGATED_CODE: `0x${string}` = `0xef0100${DELEGATE.slice(2).toLowerCase()}`;

/** A later send: one call, no value, encoded as `executeBatch`; not sponsored, no authorization. */
export const LATER_SEND = {
  calls: [{ to: "0x1234567890123456789012345678901234567890", data: "0x" }],
  prepared: {
    type: "user-operation-v070",
    data: {
      sender: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      nonce: 18446744073709551616n,
      callData:
        "0x34fcd5be0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000001234567890123456789012345678901234567890000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000",
      callGasLimit: 11192n,
      verificationGasLimit: 51269n,
      preVerificationGas: 84852n,
      maxFeePerGas: 469050000n,
      maxPriorityFeePerGas: 6350000n,
    },
    chainId: 11155111,
    signatureRequest: {
      type: "personal_sign",
      data: {
        raw: "0xe3fd5f20c5d41b8b45ec83dd34e70a48f40711fb1b5a4d44fcab5b77c6ebfa75",
      },
      rawPayload: "0x7939bc5242d32fa6ebf316cfeff1926cd27a0c5c9aa93cd0a111e8f486e18556",
    },
    feePayment: {
      sponsored: false,
      tokenAddress: "0x0000000000000000000000000000000000000000",
      maxAmount: 7988n,
    },
  },
} as const;

/**
 * A first send: two calls (a value transfer and an ERC-20 `transfer`), sponsored by a policy,
 * with the EIP-7702 authorization to {@link DELEGATE}.
 */
export const FIRST_SEND = {
  calls: [
    { to: "0x1234567890123456789012345678901234567890", value: 1000000000000000n },
    {
      to: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      data: "0xa9059cbb0000000000000000000000001234567890123456789012345678901234567890000000000000000000000000000000000000000000000000000000000000000a",
    },
  ],
  prepared: {
    type: "array",
    data: [
      {
        type: "authorization",
        data: {
          address: "0x77021100bD87b7008E5E1989d0eB38555d0d0000",
          nonce: 0,
        },
        chainId: 11155111,
        signatureRequest: {
          type: "eip7702Auth",
          rawPayload: "0xabababababababababababababababababababababababababababababababab",
        },
      },
      {
        type: "user-operation-v070",
        data: {
          sender: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          nonce: 18446744073709551616n,
          callData:
            "0x34fcd5be00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000123456789012345678901234567890123456789000000000000000000000000000000000000000000000000000038d7ea4c68000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c7238000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb0000000000000000000000001234567890123456789012345678901234567890000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000",
          callGasLimit: 11192n,
          verificationGasLimit: 51269n,
          preVerificationGas: 84852n,
          maxFeePerGas: 469050000n,
          maxPriorityFeePerGas: 6350000n,
          paymaster: "0x3f222Df6aB18C1E10d0Ec136503c3B0dfd929048",
          paymasterData:
            "0x0000000000000000682d7e7c9fa6f71c28c31141a11ac9eb2bdbe898ddbd42a4f7085f8bb3380ba75dd9231a386e24fe5a84777217c907391e983b5b0f78a4a9d0fd1c8631dd22c10e106b461c",
          paymasterVerificationGasLimit: 29907n,
          paymasterPostOpGasLimit: 0n,
        },
        chainId: 11155111,
        signatureRequest: {
          type: "personal_sign",
          data: {
            raw: "0x43b1daeb6cb4839f833625f4cce0d53103b1e1086ae8e690f570ef46d070e402",
          },
          rawPayload: "0x03b93a47ace0881b6058711a59e9aaffa71688cf0e9f0537cb3fc6d429747ea1",
        },
        feePayment: {
          sponsored: true,
          tokenAddress: "0x0000000000000000000000000000000000000000",
          maxAmount: 7988n,
        },
      },
    ],
  },
} as const;
