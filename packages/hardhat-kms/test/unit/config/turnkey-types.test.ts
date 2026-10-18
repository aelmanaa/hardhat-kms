// A Turnkey key's types, checked by tsc: this file fails to compile when a Turnkey key stops
// fitting `defineConfig`, or when `provider` stops narrowing a resolved key to a Turnkey key.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configVariable, defineConfig } from "hardhat/config";

import hardhatKms from "../../../src/index.ts";
import type {
  KmsKeyConfig,
  TurnkeyKmsKeyConfig,
  TurnkeyTransactionSigning,
} from "../../../src/types.ts";

const config = defineConfig({
  plugins: [hardhatKms],
  kms: {
    keys: {
      deployer: {
        provider: "turnkey",
        organizationId: configVariable("TURNKEY_ORGANIZATION_ID"),
        address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        apiPrivateKey: configVariable("TURNKEY_API_PRIVATE_KEY"),
        apiPublicKey: configVariable("TURNKEY_API_PUBLIC_KEY"),
        timeoutMs: 30_000,
        transactionSigning: "digest",
      },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: "http://127.0.0.1:8545",
      kmsAccounts: [
        "deployer",
        {
          provider: "turnkey",
          organizationId: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
          address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          apiPrivateKey: configVariable("TURNKEY_API_PRIVATE_KEY"),
        },
      ],
    },
  },
});

function turnkeyOnly(key: KmsKeyConfig): TurnkeyKmsKeyConfig | undefined {
  return key.provider === "turnkey" ? key : undefined;
}

/** A resolved Turnkey key always has a transaction-signing mode. */
function signingOf(key: TurnkeyKmsKeyConfig): TurnkeyTransactionSigning {
  return key.transactionSigning;
}

describe("Turnkey key types", () => {
  it("fit defineConfig, and narrow on provider (checked by tsc)", () => {
    assert.equal(config.kms?.keys?.deployer?.provider, "turnkey");
    assert.equal(typeof turnkeyOnly, "function");
    assert.equal(typeof signingOf, "function");
  });
});
