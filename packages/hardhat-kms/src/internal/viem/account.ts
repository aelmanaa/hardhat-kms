// `connection.kms.getAccount`: a viem local account whose key is a KMS key. It signs with the same
// signer, digests and checks as the JSON-RPC path, and refuses before any KMS call what it does
// not sign. viem is an optional peer dependency, loaded only here, on the first getAccount.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { isObject } from "@nomicfoundation/hardhat-utils/lang";

import { addressFromPublicKey, sameAddress } from "../crypto/address.ts";
import { authorizationDigest } from "../crypto/digests.ts";
import { recoverPublicKey, toRpcSignature } from "../crypto/signature.ts";
import { coreDebug } from "../debug.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError, errorName } from "../errors.ts";
import {
  type ConnectionAccounts,
  kmsAccountsSentence,
  type LibraryNonceRequest,
} from "../rpc/dispatcher.ts";
import { assembleSignedTransaction } from "../rpc/transactions.ts";
import { checkTypedDataChain } from "../rpc/typed-data.ts";
import type { KmsSigner, SignerCallOptions } from "../signer/kms-signer.ts";
import { CancelledError } from "../signer/timeout.ts";
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
  KmsNonceManager,
  KmsRawSignAccount,
  KmsSignedAuthorization,
  KmsSignTransactionOptions,
  KmsTransactionRequest,
  KmsTransactionSerializer,
  KmsTypedDataDefinition,
} from "./types.ts";

const log = coreDebug("account");

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
  /** Whether the connection is closed; its accounts then refuse to sign. */
  closed(): boolean;
  /** The connection's nonces for its library accounts' own sends. */
  nonces: {
    /**
     * Chooses an account's next nonce; for `consume`, under its send lock, which the send keeps
     * until its broadcast.
     */
    choose(request: LibraryNonceRequest): Promise<bigint>;
    /** Notes that the account signed a transaction with this nonce. */
    signed(address: string, nonce: bigint): void;
    /** Ends the hold or the reservation of a send that failed. */
    reset(address: string, chainId: bigint): Promise<void>;
  };
}

/** The parts of viem an account uses. */
interface ViemParts {
  /** viem's default transaction serializer, which must encode the transaction as the plugin does. */
  serializeTransaction: KmsTransactionSerializer;
  /** viem's version, `X.Y.Z`, from its `package.json`; `""` when it cannot be read. */
  version: string;
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
  return { serializeTransaction: viem.serializeTransaction, version: await readViemVersion() };
};

/**
 * Reads the version of the viem that `import("viem")` loads from this module, from its
 * `package.json`, which viem exports.
 *
 * @param resolve - Resolves a module specifier to a file; tests pass another resolver.
 * @returns The version, or `""` when it cannot be read.
 */
export async function readViemVersion(
  resolve: (specifier: string) => string = createRequire(import.meta.url).resolve,
): Promise<string> {
  try {
    const manifest: unknown = JSON.parse(String(await readFile(resolve("viem/package.json"))));
    return isObject(manifest) && typeof manifest.version === "string" ? manifest.version : "";
  } catch {
    return "";
  }
}

/**
 * The lowest viem release whose `sendTransaction` calls the nonce manager's `reset` only after its
 * `consume` (wevm/viem#4967); the floor of the peer range.
 */
export const VIEM_FLOOR = "2.55.13";

/**
 * Refuses a viem release below {@link VIEM_FLOOR}, since pnpm and Yarn only warn when the
 * installed viem is outside the peer range. A pre-release of the floor, such as `2.55.13-canary.0`,
 * is below it, as semver orders them. A version that does not read as `X.Y.Z` passes: the check
 * must not refuse a viem it cannot read.
 *
 * @param version - viem's version, such as `2.57.2`.
 * @param operation - The account method, for the error message.
 */
function checkViemVersion(version: string, operation: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:$|\+|(-))/.exec(version);
  if (match === null) {
    return;
  }
  // The first part that differs decides: negative when the installed viem is older.
  const order =
    VIEM_FLOOR.split(".")
      .map((minimum, index) => Number(match[index + 1]) - Number(minimum))
      .find((difference) => difference !== 0) ?? 0;
  if (order < 0 || (order === 0 && match[4] === "-")) {
    throw catalogError(
      ERRORS.accountViemTooOld,
      { installed: version.slice(0, 64), floor: VIEM_FLOOR },
      { operation },
    );
  }
}

const OPTION_NAMES = new Set(["rawSign", "allowChainZeroAuthorization", "signal"]);

/** The options of `getAccount`, checked. */
interface AccountOptions {
  rawSign: boolean;
  allowChainZeroAuthorization: boolean;
  /** Cancels the account's KMS calls when it aborts. */
  signal: AbortSignal | undefined;
}

function readOptions(options: unknown, operation: string): AccountOptions {
  if (options === undefined) {
    return { rawSign: false, allowChainZeroAuthorization: false, signal: undefined };
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
  // Own properties only: an inherited `rawSign`, such as one on a polluted Object.prototype,
  // must not turn an option on.
  const flag = (name: string): boolean => {
    const value = Object.hasOwn(options, name) ? options[name] : undefined;
    if (value === undefined || typeof value === "boolean") {
      return value === true;
    }
    throw catalogError(
      ERRORS.accountField,
      { field: `options.${name}`, expected: "a boolean" },
      { operation },
    );
  };
  const signal = Object.hasOwn(options, "signal") ? options.signal : undefined;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw catalogError(
      ERRORS.accountField,
      { field: "options.signal", expected: "an AbortSignal" },
      { operation },
    );
  }
  return {
    rawSign: flag("rawSign"),
    allowChainZeroAuthorization: flag("allowChainZeroAuthorization"),
    signal,
  };
}

/**
 * Why viem could not be loaded: the error's name, and its Node.js code when it has one, such as
 * `ERR_MODULE_NOT_FOUND`.
 */
function loadFailure(error: unknown): string {
  const code: unknown = isObject(error) ? error.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? `${errorName(error)}, ${code}`
    : errorName(error);
}

// Printed once per process, the first time a library account's nonce is chosen for a client
// whose transport does not go through Hardhat.
let warnedAboutTransport = false;

/**
 * The type of a viem client's transport when it does not go through Hardhat: any type but
 * `custom`, such as `http` or `webSocket`. A `custom` transport over another provider cannot be
 * told apart from `custom(connection.provider)`.
 *
 * @param client - The viem client of the send.
 * @returns The transport's type, or `undefined` for a `custom` or unknown transport.
 */
function ownTransportType(client: unknown): string | undefined {
  const transport: unknown = isObject(client) ? client.transport : undefined;
  const type: unknown = isObject(transport) ? transport.type : undefined;
  return typeof type === "string" && type !== "custom" ? type : undefined;
}

/**
 * Warns, once per process, when viem asks for a nonce for a client whose transport does not go
 * through Hardhat: its broadcast never reaches the plugin.
 *
 * @param type - The transport's type.
 */
function warnAboutTransport(type: string): void {
  if (warnedAboutTransport) {
    return;
  }
  warnedAboutTransport = true;
  warn(
    `a connection.kms.getAccount account sends with a viem "${type}" transport, which does not go through Hardhat. The plugin chose the transaction's nonce and keeps it from its own sends for 60 s, but it does not order or see the broadcast, so a node that mines each transaction on arrival, such as Hardhat's simulated network, can refuse the plugin's next send with "Nonce too high". Send through custom(connection.provider); see https://github.com/aelmanaa/hardhat-kms/blob/main/docs/user/reference/library-accounts.md#clients-with-their-own-transport-on-an-automining-node.`,
  );
}

/**
 * Refuses, before any KMS call, when the account's connection is closed.
 *
 * @param connection - The account's connection.
 * @param operation - The account method, for the error message.
 */
function checkOpen(connection: AccountConnection, operation: string): void {
  if (connection.closed()) {
    throw catalogError(
      ERRORS.accountConnectionClosed,
      { network: connection.network },
      { operation },
    );
  }
}

/**
 * Refuses, before any KMS call, once the signal given to `getAccount` has aborted.
 *
 * @param signal - The account's signal, if any.
 * @param operation - The account method, for the error message.
 */
function checkNotCancelled(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) {
    throw catalogError(ERRORS.accountCancelled, {}, { operation });
  }
}

/** A `0x`-prefixed hex string, typed as such. */
function hex(value: string): KmsHex {
  return `0x${value.slice(2)}`;
}

function bytesHex(bytes: Uint8Array): KmsHex {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/** A 32-byte word as `0x` hex, as viem's signatures give `r` and `s`. */
function word(value: bigint): KmsHex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/**
 * Signs with the account's key, through the connection's signer cache. It refuses when the
 * connection is closed or the account's signal has aborted, checked right before the KMS call, so
 * a close or an abort during a call's earlier steps (such as the chain id lookup) still stops it.
 * `use` gets the call options to pass to the signer, which carry the account's signal. A result
 * that comes back after the signal aborted is dropped, so viem never gets a signature to send.
 */
type WithSigner = <T>(
  operation: string,
  use: (signer: KmsSigner, call: SignerCallOptions) => Promise<T>,
) => Promise<T>;

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
  checkOpen(connection, operation);
  checkNotCancelled(context.options.signal, operation);
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
  log("%s: signing a %s transaction for chain %s", address, input.type, chainId.toString());
  const signed = await context.withSigner(operation, async (signer, call) => {
    const signature = await signer.signDigest(keccak_256(unsignedBytes), call);
    return assembleSignedTransaction(input.unsigned, signature, address, operation);
  });
  // After the signature: a reservation whose transaction was signed is the one most likely sent.
  connection.nonces.signed(address.toLowerCase(), input.unsigned.raw.nonce);
  return hex(signed.toHex(true));
}

/** Checks an authorization's chain, then signs it and reads the result back (decision 0004). */
async function signAuthorization(
  context: AccountContext,
  parameters: KmsAuthorizationRequest,
): Promise<KmsSignedAuthorization> {
  const operation = "signAuthorization";
  const { connection, address } = context;
  checkOpen(connection, operation);
  checkNotCancelled(context.options.signal, operation);
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
  const signature = await context.withSigner(
    operation,
    async (signer, call) => await signer.signDigest(digest, call),
  );
  const signed: KmsSignedAuthorization = {
    address: request.delegate,
    chainId: request.chainId,
    nonce: request.nonce,
    r: word(signature.r),
    s: word(signature.s),
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
  const recoveredAddress =
    // Stryker disable next-line ConditionalExpression,StringLiteral: a KmsSigner verifies each signature, so it always recovers
    recovered === undefined ? "" : addressFromPublicKey(recovered);
  if (!sameAddress(recoveredAddress, address)) {
    throw catalogError(ERRORS.accountAuthNoRecovery, {}, { operation });
  }
  return signed;
}

/**
 * Builds the account's viem `nonceManager`. viem calls `consume` once per send without a nonce
 * (`sendTransaction`, `writeContract`, `deployContract`), and `reset` when that send fails. The
 * connection chooses the nonce as the plugin's own sends would, and keeps it from them until the
 * raw transaction reaches the node, `reset` is called, or 60 s pass.
 *
 * viem calls `reset` after a `consume` that failed too, and a failed `consume` holds and reserves
 * nothing. The manager counts its failed consumes and keeps that many resets, so a reset after one
 * cannot end the hold of another send from the same key.
 */
function buildNonceManager(context: AccountContext): KmsNonceManager {
  const { connection } = context;
  const address = context.address.toLowerCase();
  const choose = async (
    operation: string,
    parameters: { chainId: number; client?: unknown },
    reserve: boolean,
  ): Promise<number> => {
    checkOpen(connection, operation);
    // A refused consume is counted below, like any failed consume, so the reset viem sends after
    // it ends no other send's hold.
    const { signal } = context.options;
    checkNotCancelled(signal, operation);
    const type = reserve ? ownTransportType(parameters.client) : undefined;
    const own = type !== undefined;
    if (own) {
      warnAboutTransport(type);
    }
    const chainId = BigInt(parameters.chainId);
    try {
      return Number(
        await connection.nonces.choose({ address, chainId, reserve, ownTransport: own, signal }),
      );
    } catch (error) {
      // The signal ended the wait for the send lock: nothing is held or reserved.
      if (error instanceof CancelledError) {
        throw catalogError(ERRORS.accountCancelled, {}, { operation });
      }
      throw error;
    }
  };
  // The resets still to come after this account's failed consumes.
  let owedResets = 0;
  const manager: KmsNonceManager = {
    consume: async (parameters) => {
      try {
        return await choose("nonceManager.consume", parameters, true);
      } catch (error) {
        owedResets += 1;
        throw error;
      }
    },
    get: async (parameters) => await choose("nonceManager.get", parameters, false),
    // Nothing to count: each consume reads the node and the reservations again.
    increment: () => undefined,
    reset: (parameters) => {
      if (owedResets > 0) {
        owedResets -= 1;
        return;
      }
      // viem does not await reset; a failure only leaves the hold to its time limit.
      connection.nonces.reset(address, BigInt(parameters.chainId)).catch((error: unknown) => {
        log("%s: nonceManager.reset failed (%s)", context.address, errorName(error));
      });
    },
  };
  return Object.freeze(manager);
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
      return hex(
        await withSigner(
          "signMessage",
          async (signer, call) => await signer.signPersonalMessage(message, call),
        ),
      );
    },
    signTypedData: async (parameters: KmsTypedDataDefinition) => {
      const operation = "signTypedData";
      checkOpen(connection, operation);
      checkNotCancelled(context.options.signal, operation);
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
      return hex(
        await withSigner(
          operation,
          async (signer, call) => await signer.signTypedData(typedData, call),
        ),
      );
    },
    signTransaction: async (transaction, options) =>
      await signTransaction(context, transaction, options),
    signAuthorization: async (parameters) => await signAuthorization(context, parameters),
    nonceManager: buildNonceManager(context),
  };
  if (!context.options.rawSign) {
    return Object.freeze(account);
  }
  const raw: KmsRawSignAccount = {
    ...account,
    sign: async (parameters: { hash: unknown }) => {
      const digest = readHash(parameters, "sign");
      const signature = await withSigner(
        "sign",
        async (signer, call) => await signer.signDigest(digest, call),
      );
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
    // Also checked before the KMS call, but the key lookup before it can call the KMS too.
    checkOpen(connection, operation);
    let viem: ViemParts;
    try {
      viem = await load();
    } catch (error) {
      throw catalogError(ERRORS.accountViemMissing, { reason: loadFailure(error) }, { operation });
    }
    checkViemVersion(viem.version, operation);
    const checked = readOptions(options, operation);
    // Before the key lookup, which can call the KMS.
    checkNotCancelled(checked.signal, operation);
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
    const { signal } = checked;
    const withSigner: WithSigner = async (method, use) => {
      checkOpen(connection, method);
      checkNotCancelled(signal, method);
      const result = await accounts.signWith(key, async (signer) => await use(signer, { signal }));
      checkNotCancelled(signal, method);
      return result;
    };
    // The one KMS call of getAccount; it also checks the key's address pin.
    const publicKey = await withSigner(
      operation,
      async (signer, call) => await signer.getPublicKey(call),
    );
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
