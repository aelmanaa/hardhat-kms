// `connection.kms.getAccount`: a viem local account whose key is a KMS key. It signs with the same
// signer, digests and checks as the JSON-RPC path, and refuses before any KMS call what it does
// not sign. viem is an optional peer dependency, loaded only here, on the first getAccount.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { isObject } from "@nomicfoundation/hardhat-utils/lang";

import { addressFromPublicKey, sameAddress } from "../crypto/address.ts";
import { authorizationDigest } from "../crypto/digests.ts";
import { recoverPublicKey, toRpcSignature } from "../crypto/signature.ts";
import { kmsDebug } from "../debug.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError, errorName } from "../errors.ts";
import { type ConnectionAccounts, kmsAccountsSentence } from "../rpc/dispatcher.ts";
import { assembleSignedTransaction } from "../rpc/transactions.ts";
import { checkTypedDataChain } from "../rpc/typed-data.ts";
import type { KmsSigner } from "../signer/kms-signer.ts";
import { warn } from "../warnings.ts";
import {
  readAddress,
  readAuthorization,
  readHash,
  readMessage,
  readTransaction,
  readViemTypedData,
} from "./inputs.ts";
import type {
  KmsAccount,
  KmsAccountOptions,
  KmsAuthorizationRequest,
  KmsHex,
  KmsNetworkConnection,
  KmsRawSignAccount,
  KmsSignedAuthorization,
  KmsSignTransactionOptions,
  KmsTransactionRequest,
  KmsTransactionSerializer,
  KmsTypedDataDefinition,
} from "./types.ts";

const log = kmsDebug("account");

/** What an account needs from its network connection. */
export interface AccountConnection {
  /** The network's name, for messages. */
  network: string;
  /** The connection's KMS accounts. */
  accounts: Pick<ConnectionAccounts, "keyFor" | "addresses" | "signWith">;
  /** The connection's chain id. */
  chainId(): Promise<bigint>;
  /** `kms.allowCrossChainTypedData`. */
  allowCrossChainTypedData: boolean;
}

/** The parts of viem an account uses. */
interface ViemParts {
  /** viem's default transaction serializer, which must encode the transaction as the plugin does. */
  serializeTransaction: KmsTransactionSerializer;
}

/** Loads viem, the account's optional peer dependency. */
export type LoadViem = () => Promise<ViemParts>;

/**
 * Loads viem from the project.
 *
 * @returns The parts of viem the account uses.
 */
export const loadViem: LoadViem = async () => {
  const viem = await import("viem");
  return { serializeTransaction: viem.serializeTransaction };
};

const OPTION_NAMES = new Set(["rawSign", "allowChainZeroAuthorization"]);

/** The options of `getAccount`, checked. */
interface AccountOptions {
  rawSign: boolean;
  allowChainZeroAuthorization: boolean;
}

function readOptions(options: unknown, operation: string): AccountOptions {
  if (options === undefined) {
    return { rawSign: false, allowChainZeroAuthorization: false };
  }
  if (!isObject(options)) {
    throw catalogError(
      ERRORS.accountField,
      { field: "options", expected: "an object" },
      { operation },
    );
  }
  for (const name of Object.keys(options)) {
    if (!OPTION_NAMES.has(name)) {
      throw catalogError(ERRORS.accountOption, { name: name.slice(0, 64) }, { operation });
    }
  }
  const flag = (name: string): boolean => {
    const value = options[name];
    if (value === undefined || typeof value === "boolean") {
      return value === true;
    }
    throw catalogError(
      ERRORS.accountField,
      { field: `options.${name}`, expected: "a boolean" },
      { operation },
    );
  };
  return {
    rawSign: flag("rawSign"),
    allowChainZeroAuthorization: flag("allowChainZeroAuthorization"),
  };
}

/** `0x`-prefixed hex of a string that is hex, with or without the prefix. */
function hex(value: string): KmsHex {
  return `0x${value.startsWith("0x") ? value.slice(2) : value}`;
}

function bytesHex(bytes: Uint8Array): KmsHex {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/** A 32-byte word as `0x` hex, as viem's signatures give `r` and `s`. */
function word(value: bigint): KmsHex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** Signs with the account's key, through the connection's signer cache. */
type WithSigner = <T>(use: (signer: KmsSigner) => Promise<T>) => Promise<T>;

/** What the account methods share. */
interface AccountContext {
  connection: AccountConnection;
  viem: ViemParts;
  options: AccountOptions;
  /** The checksummed address. */
  address: KmsHex;
  withSigner: WithSigner;
}

/**
 * Checks a transaction, serializes it with the plugin's code, compares the bytes with the
 * serializer's, and only then signs it. Every refusal happens before the KMS call.
 */
async function signTransaction(
  context: AccountContext,
  transaction: KmsTransactionRequest,
  options: KmsSignTransactionOptions | undefined,
): Promise<KmsHex> {
  const operation = "signTransaction";
  const { connection, address } = context;
  const input = readTransaction(transaction, operation);
  const chainId = await connection.chainId();
  if (input.chainId !== chainId) {
    throw catalogError(
      ERRORS.accountTxWrongChain,
      { requested: input.chainId, network: connection.network, chainId },
      { operation },
    );
  }
  const unsignedBytes = input.unsigned.toBytes(false);
  const custom = options?.serializer;
  const serializer = custom ?? context.viem.serializeTransaction;
  const serializerName = custom === undefined ? "viem's serializeTransaction" : "the serializer";
  let encoded: unknown;
  try {
    encoded = await serializer(transaction);
  } catch (error) {
    throw catalogError(
      ERRORS.accountSerializerFailed,
      { serializer: serializerName, errorName: errorName(error) },
      { operation },
    );
  }
  if (typeof encoded !== "string" || encoded.toLowerCase() !== bytesHex(unsignedBytes)) {
    throw catalogError(
      ERRORS.accountSerializerMismatch,
      { serializer: serializerName },
      { operation },
    );
  }
  log("%s: signing a %s transaction for chain %s", address, input.type, chainId);
  const signed = await context.withSigner(async (signer) => {
    const signature = await signer.signDigest(keccak_256(unsignedBytes));
    return assembleSignedTransaction(input.unsigned, signature, address, operation);
  });
  return hex(signed.toHex(true));
}

/** Checks an authorization's chain, then signs it and reads the result back (decision 0004). */
async function signAuthorization(
  context: AccountContext,
  parameters: KmsAuthorizationRequest,
): Promise<KmsSignedAuthorization> {
  const operation = "signAuthorization";
  const { connection, address } = context;
  const request = readAuthorization(parameters, operation);
  if (request.chainId === 0 && !context.options.allowChainZeroAuthorization) {
    throw catalogError(ERRORS.accountAuthChainZero, {}, { operation });
  }
  if (request.chainId !== 0) {
    const chainId = await connection.chainId();
    if (BigInt(request.chainId) !== chainId) {
      throw catalogError(
        ERRORS.accountAuthWrongChain,
        { requested: request.chainId, network: connection.network, chainId },
        { operation },
      );
    }
  }
  const digest = authorizationDigest({
    chainId: BigInt(request.chainId),
    address: request.delegateBytes,
    nonce: BigInt(request.nonce),
  });
  log("%s: signing an authorization for chain %d", address, request.chainId);
  const signature = await context.withSigner(async (signer) => await signer.signDigest(digest));
  const signed: KmsSignedAuthorization = {
    address: request.delegate,
    chainId: request.chainId,
    nonce: request.nonce,
    r: word(signature.r),
    s: word(signature.s),
    v: signature.yParity === 1 ? 28n : 27n,
    yParity: signature.yParity,
  };
  // Read back from the returned fields, so the check also covers the step from signature to
  // output, as `kms sign-auth` does.
  const recovered = recoverPublicKey(
    digest,
    BigInt(signed.r),
    BigInt(signed.s),
    signed.yParity === 1 ? 1 : 0,
  );
  if (recovered === undefined || !sameAddress(addressFromPublicKey(recovered), address)) {
    throw catalogError(ERRORS.accountAuthNoRecovery, {}, { operation });
  }
  return signed;
}

/** Builds the account object. It holds closures only: no signer, key config or key material. */
function buildAccount(context: AccountContext, publicKey: KmsHex): KmsAccount | KmsRawSignAccount {
  const { connection, withSigner } = context;
  const account: KmsAccount = {
    address: context.address,
    publicKey,
    source: "hardhat-kms",
    type: "local",
    signMessage: async (parameters: { message: unknown }) => {
      const message = readMessage(parameters, "signMessage");
      return hex(await withSigner(async (signer) => await signer.signPersonalMessage(message)));
    },
    signTypedData: async (parameters: KmsTypedDataDefinition) => {
      const operation = "signTypedData";
      const typedData = readViemTypedData(parameters, operation);
      await checkTypedDataChain(typedData, {
        operation,
        allowCrossChain: connection.allowCrossChainTypedData,
        expectedChain: async () => ({
          chainId: await connection.chainId(),
          name: `network ${connection.network}`,
        }),
        mismatch: ERRORS.typedDataChainMismatchNetwork,
      });
      return hex(await withSigner(async (signer) => await signer.signTypedData(typedData)));
    },
    signTransaction: async (transaction, options) =>
      await signTransaction(context, transaction, options),
    signAuthorization: async (parameters) => await signAuthorization(context, parameters),
  };
  if (!context.options.rawSign) {
    return Object.freeze(account);
  }
  const raw: KmsRawSignAccount = {
    ...account,
    sign: async (parameters: { hash: unknown }) => {
      const digest = readHash(parameters, "sign");
      const signature = await withSigner(async (signer) => await signer.signDigest(digest));
      return hex(toRpcSignature(signature));
    },
  };
  return Object.freeze(raw);
}

/**
 * Builds `connection.kms` for a network connection.
 *
 * @param connection - What the accounts need from the connection.
 * @param load - Loads viem; tests pass another loader.
 * @returns The object to set as `connection.kms`.
 */
export function createKmsNetworkConnection(
  connection: AccountConnection,
  load: LoadViem = loadViem,
): KmsNetworkConnection {
  function getAccount(
    address: string,
    options: KmsAccountOptions & { rawSign: true },
  ): Promise<KmsRawSignAccount>;
  function getAccount(address: string, options?: KmsAccountOptions): Promise<KmsAccount>;
  async function getAccount(
    address: string,
    options?: KmsAccountOptions,
  ): Promise<KmsAccount | KmsRawSignAccount> {
    const operation = "getAccount";
    let viem: ViemParts;
    try {
      viem = await load();
    } catch (error) {
      throw catalogError(ERRORS.accountViemMissing, { errorName: errorName(error) }, { operation });
    }
    const checked = readOptions(options, operation);
    const checksummed = readAddress(address, "address", operation);
    const { accounts } = connection;
    const key = await accounts.keyFor(checksummed.toLowerCase());
    if (key === undefined) {
      const sentence = kmsAccountsSentence(await accounts.addresses());
      throw catalogError(
        ERRORS.accountNotKms,
        {
          address: checksummed,
          network: connection.network,
          accounts: sentence === undefined ? " It has no KMS accounts." : ` ${sentence}`,
        },
        { operation },
      );
    }
    const withSigner: WithSigner = async (use) => await accounts.signWith(key, use);
    // The one KMS call of getAccount; it also checks the key's address pin.
    const publicKey = await withSigner(async (signer) => await signer.getPublicKey());
    if (checked.rawSign) {
      warn(
        `the account ${checksummed} signs any 32-byte digest with sign({ hash }), which can be a transaction or a permit for any chain. Use rawSign only for an owner that needs it, such as a Coinbase smart account.`,
      );
    }
    log("%s: account for network %s", checksummed, connection.network);
    return buildAccount(
      { connection, viem, options: checked, address: checksummed, withSigner },
      bytesHex(publicKey),
    );
  }
  return Object.freeze({ getAccount });
}
