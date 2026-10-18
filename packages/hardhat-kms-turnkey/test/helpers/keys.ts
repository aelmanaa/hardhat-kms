// Test keys and a resolved Turnkey key. None of them is a real credential.
import type { KmsIdentifier, SignContext, TurnkeyKmsKeyConfig } from "hardhat-kms/types";

import { HARDHAT_ACCOUNT_0 } from "../../../hardhat-kms/test/helpers/vectors.ts";
import { apiKeyFromPrivateKey } from "../../src/internal/stamp.ts";

/** A P-256 API private key, planted in tests: no output may contain it. */
export const API_PRIVATE_KEY: string =
  "4b8f1c7e3a2d5f6e9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f";

const apiKey = apiKeyFromPrivateKey(API_PRIVATE_KEY);
if (apiKey === undefined) {
  throw new Error("the test API key is invalid");
}
/** Its compressed public key. */
export const API_PUBLIC_KEY: string = apiKey.publicKey;

/** Another API private key, of another pair. */
export const OTHER_API_PRIVATE_KEY: string = "1f".repeat(32);

/** The organization, planted from a variable in tests: no output may contain it. */
export const ORGANIZATION: string = "a3c1e9f2-5b7d-4e8a-9c0f-1d2e3f4a5b6c";

/** The wallet account: Hardhat's first default account. */
export const ACCOUNT: { secretKey: string; address: string } = HARDHAT_ACCOUNT_0;
export const ACCOUNT_SECRET_KEY: Uint8Array = new Uint8Array(
  Buffer.from(HARDHAT_ACCOUNT_0.secretKey, "hex"),
);

/** An identifier whose value the test sets; its display is the variable name. */
export function variable(name: string, value: string): KmsIdentifier & { reads: number } {
  const identifier = {
    reads: 0,
    display: `<${name}>`,
    get: async () => {
      identifier.reads++;
      return await Promise.resolve(value);
    },
  };
  return identifier;
}

/** A resolved Turnkey key, as the core resolves one with variables. */
export function turnkeyKey(
  changes: Partial<TurnkeyKmsKeyConfig> = {},
  values: { privateKey?: string; publicKey?: string; organizationId?: string } = {},
): TurnkeyKmsKeyConfig {
  return {
    provider: "turnkey",
    name: "deployer",
    displayId: `turnkey:<TURNKEY_ORGANIZATION_ID>/${ACCOUNT.address}`,
    address: ACCOUNT.address,
    timeoutMs: 30_000,
    transactionSigning: "transaction",
    organizationId: variable("TURNKEY_ORGANIZATION_ID", values.organizationId ?? ORGANIZATION),
    apiPrivateKey: variable("TURNKEY_API_PRIVATE_KEY", values.privateKey ?? API_PRIVATE_KEY),
    ...(values.publicKey === undefined
      ? {}
      : { apiPublicKey: variable("TURNKEY_API_PUBLIC_KEY", values.publicKey) }),
    ...changes,
  };
}

/**
 * A call context with its own controller; `messages` collects the status lines, and `sent` the
 * ids passed to `requestSent`, `null` for a call without one, and `refused` for each
 * `requestRefused`, each with what `onSent` returned.
 */
export function signContext(onSent: () => unknown = () => undefined): SignContext & {
  controller: AbortController;
  messages: string[];
  sent: Array<[string | null, unknown]>;
} {
  const controller = new AbortController();
  const messages: string[] = [];
  const sent: Array<[string | null, unknown]> = [];
  return {
    controller,
    messages,
    sent,
    signal: controller.signal,
    requestId: "req-1",
    displayMessage: async (message) => {
      messages.push(message);
      await Promise.resolve();
    },
    requestSent: (id) => {
      sent.push([id ?? null, onSent()]);
    },
    requestRefused: () => {
      sent.push(["refused", onSent()]);
    },
  };
}
