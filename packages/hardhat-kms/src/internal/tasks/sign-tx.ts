import { readFile } from "node:fs/promises";

import { isObject } from "@nomicfoundation/hardhat-utils/lang";
import type { RpcTransactionRequest } from "@nomicfoundation/hardhat-zod-utils/rpc";
import type { NewTaskActionFunction } from "hardhat/types/tasks";
import { addr } from "micro-eth-signer";

import { sameAddress, toChecksumAddress } from "../crypto/address.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError, errorName } from "../errors.ts";
import { createConnectionChain } from "../rpc/chain-id.ts";
import { createTransactionFiller, type UnsignedTransaction } from "../rpc/transaction-filler.ts";
import { type SignedTransaction, signTransaction } from "../rpc/transactions.ts";
import { printLine, printNote, withNamedSigner } from "./keys.ts";

/** The arguments of `kms sign-tx`. */
interface SignTxArguments {
  key: string;
  tx: string;
}

/** The operation in error messages. */
const OPERATION = "kms sign-tx";

/**
 * The refusal of blob transactions, worded as the filler words it for `blobs` and
 * `blobVersionedHashes`. The task gives it for `type` 0x3 and `maxFeePerBlobGas`, which Hardhat's
 * request schema does not read.
 */
/**
 * The fields of Hardhat 3.18's request schema (`rpcTransactionRequest`). The type makes the
 * compiler require every key of `RpcTransactionRequest` here, and no other.
 */
const SCHEMA_FIELDS: Readonly<Record<keyof RpcTransactionRequest, true>> = {
  from: true,
  to: true,
  gas: true,
  gasPrice: true,
  maxFeePerGas: true,
  maxPriorityFeePerGas: true,
  value: true,
  data: true,
  nonce: true,
  chainId: true,
  accessList: true,
  authorizationList: true,
  blobs: true,
  blobVersionedHashes: true,
};

/**
 * The fields the task reads: the schema's, plus `type`. Any other field is refused: the schema
 * drops unknown fields, so a misspelt `gasLimit` or an `input` would otherwise be signed as if it
 * were absent.
 */
export const KNOWN_FIELDS: ReadonlySet<string> = new Set([...Object.keys(SCHEMA_FIELDS), "type"]);

/** The fields the unknown-field error lists: those the task signs, without the blob fields. */
const LISTED_FIELDS = [...KNOWN_FIELDS].filter(
  (field) => field !== "blobs" && field !== "blobVersionedHashes",
);

/** The fields that hold a JSON-RPC quantity. */
const QUANTITY_FIELDS = [
  "value",
  "gas",
  "gasPrice",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "nonce",
  "chainId",
] as const;

/** The name of a field that other tools use, and the `eth_sendTransaction` name for it. */
const RENAMED_FIELDS: Readonly<Record<string, string>> = { gasLimit: "gas", input: "data" };

/** The micro-eth-signer type of each `type` the task signs. */
const TYPES: Readonly<Record<number, string>> = {
  0: "legacy",
  1: "eip2930",
  2: "eip1559",
  4: "eip7702",
};

/**
 * Names a transaction type by its number and micro-eth-signer's name, such as `0x2 (eip1559)`.
 *
 * @param name - micro-eth-signer's name of the type.
 * @returns The description.
 */
function describeType(name: string): string {
  const number = Object.entries(TYPES).find(([, type]) => type === name)?.[0];
  return number === undefined ? name : `0x${number} (${name})`;
}

/**
 * Reads the transaction file: a JSON object with `eth_sendTransaction` field names.
 *
 * @param file - The file's path.
 * @returns The transaction.
 */
async function readTransaction(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code: unknown = isObject(error) ? error.code : undefined;
    throw catalogError(
      ERRORS.txFileUnreadable,
      { file, code: typeof code === "string" ? code : errorName(error) },
      { operation: OPERATION },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : errorName(error);
    throw catalogError(ERRORS.txFileNotJson, { file, reason }, { operation: OPERATION });
  }
  if (!isObject(parsed) || Array.isArray(parsed)) {
    throw catalogError(ERRORS.txFileNotObject, { file }, { operation: OPERATION });
  }
  return parsed;
}

/** Shows a value from the file in an error, cut short. */
function shown(value: unknown): string {
  // Values from JSON.parse always have a JSON form.
  const text = JSON.stringify(value);
  return text.length > 70 ? `${text.slice(0, 67)}...` : text;
}

/**
 * Refuses an address with mixed case whose EIP-55 checksum is wrong, which usually means a typo.
 * All-lowercase and all-uppercase addresses carry no checksum and are accepted, as everywhere.
 *
 * @param where - The field, for the error message.
 * @param value - The value from the file.
 */
function checkChecksum(where: string, value: unknown): void {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return;
  }
  const digits = value.slice(2);
  if (digits === digits.toLowerCase() || digits === digits.toUpperCase()) {
    return;
  }
  if (addr.addChecksum(value) !== value) {
    throw catalogError(ERRORS.txFileChecksum, { field: where, value }, { operation: OPERATION });
  }
}

/**
 * Checks the checksum of every address in the transaction: `to`, `from`, and the addresses of
 * the access list and the authorization list.
 *
 * @param tx - The transaction from the file.
 */
function checkAddressChecksums(tx: Record<string, unknown>): void {
  checkChecksum("to", tx.to);
  checkChecksum("from", tx.from);
  for (const list of ["accessList", "authorizationList"] as const) {
    const items = tx[list];
    if (Array.isArray(items)) {
      for (const [index, item] of items.entries()) {
        checkChecksum(`${list}[${index}].address`, isObject(item) ? item.address : undefined);
      }
    }
  }
}

/**
 * Refuses fields the task does not sign: unknown or renamed fields, quantities that are not hex,
 * addresses with a wrong checksum, and blob transactions.
 *
 * @param tx - The transaction from the file.
 * @returns The `type` the transaction asks for, if any, as micro-eth-signer names it.
 */
function checkFields(tx: Record<string, unknown>): string | undefined {
  if (tx.maxFeePerBlobGas !== undefined) {
    throw catalogError(ERRORS.txBlob, {}, { operation: OPERATION });
  }
  const unknown = Object.keys(tx).filter((field) => !KNOWN_FIELDS.has(field));
  if (unknown.length > 0) {
    const hints = unknown.flatMap((field) => {
      const renamed = RENAMED_FIELDS[field];
      return renamed === undefined ? [] : [`use ${renamed} instead of ${field}`];
    });
    throw catalogError(
      ERRORS.txFileUnknownFields,
      {
        fields: `${unknown.length === 1 ? "field" : "fields"} ${unknown.join(", ")}`,
        hints: hints.length > 0 ? ` (${hints.join("; ")})` : "",
        known: LISTED_FIELDS.join(", "),
      },
      { operation: OPERATION },
    );
  }
  for (const field of QUANTITY_FIELDS) {
    const value = tx[field];
    if (value !== undefined && (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))) {
      throw catalogError(
        ERRORS.txFileNotQuantity,
        { field, value: shown(value) },
        { operation: OPERATION },
      );
    }
  }
  checkAddressChecksums(tx);
  if (tx.type === undefined) {
    return undefined;
  }
  if (typeof tx.type !== "string" || !/^0x[0-9a-fA-F]+$/.test(tx.type)) {
    throw catalogError(ERRORS.txFileTypeNotQuantity, {}, { operation: OPERATION });
  }
  const number = Number.parseInt(tx.type, 16);
  if (number === 3) {
    throw catalogError(ERRORS.txBlob, {}, { operation: OPERATION });
  }
  const type = TYPES[number];
  if (type === undefined) {
    throw catalogError(ERRORS.txFileUnsupportedType, { type: tx.type }, { operation: OPERATION });
  }
  return type;
}

/**
 * Refuses a filled transaction whose type differs from the `type` the file asks for. The fields
 * decide the type, as for `eth_signTransaction`; `type` only states what the caller expects.
 *
 * @param requested - The type the file asks for, if any.
 * @param unsigned - The filled, unsigned transaction.
 */
function checkType(requested: string | undefined, unsigned: UnsignedTransaction): void {
  if (requested !== undefined && requested !== unsigned.type) {
    throw catalogError(
      ERRORS.txTypeMismatch,
      { requested: describeType(requested), actual: describeType(unsigned.type) },
      { operation: OPERATION },
    );
  }
}

/**
 * `kms sign-tx <key> <tx> --network <name>`: fills a transaction on the network's node the way
 * `eth_signTransaction` does, signs it with the key and prints the raw signed transaction on standard
 * output, as `cast mktx` does, and its hash on standard error. It never broadcasts.
 *
 * @param args - The task arguments.
 * @param hre - The Hardhat runtime.
 * @returns The raw signed transaction and its hash.
 */
const kmsSignTx: NewTaskActionFunction<SignTxArguments> = async ({ key, tx: file }, hre) => {
  const network = hre.globalOptions.network;
  if (network === undefined) {
    throw catalogError(ERRORS.signTxNeedsNetwork, {}, { operation: OPERATION });
  }
  const tx = await readTransaction(file);
  const requestedType = checkFields(tx);
  const { type: _type, ...request } = tx;
  if (request.to === undefined || request.to === null) {
    printNote("the transaction has no `to`: it creates a contract");
  }
  const signed: SignedTransaction = await withNamedSigner(hre, key, async (signer) => {
    const address = (await signer.getAddress()).toLowerCase();
    const { from } = request;
    if (from !== undefined && (typeof from !== "string" || !sameAddress(from, address))) {
      throw catalogError(
        ERRORS.signTxWrongFrom,
        {
          from: typeof from === "string" ? from : typeof from,
          keyName: key,
          address: toChecksumAddress(address),
        },
        { operation: OPERATION },
      );
    }
    const connection = await hre.network.create(network);
    try {
      return await signTransaction(signer, {
        filler: createTransactionFiller(connection, createConnectionChain(connection)),
        method: OPERATION,
        params: [{ ...request, from: address }],
        from: address,
        checkUnsigned: (unsigned) => {
          checkType(requestedType, unsigned);
        },
      });
    } finally {
      await connection.close();
    }
  });
  // Only the raw transaction goes to standard output, as with cast mktx, so that
  // `cast publish $(npx hardhat kms sign-tx ...)` works.
  printLine(signed.raw);
  printNote(`hash ${signed.hash}`);
  return { raw: signed.raw, hash: signed.hash };
};

export default kmsSignTx;
