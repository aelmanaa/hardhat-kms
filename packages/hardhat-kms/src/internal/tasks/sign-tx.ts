import { readFile } from "node:fs/promises";

import { isObject } from "@nomicfoundation/hardhat-utils/lang";
import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { sameAddress, toChecksumAddress } from "../crypto/address.ts";
import { errorName, kmsError } from "../errors.ts";
import { createConnectionChain } from "../rpc/chain-id.ts";
import { createTransactionFiller, type UnsignedTransaction } from "../rpc/transaction-filler.ts";
import { type SignedTransaction, signTransaction } from "../rpc/transactions.ts";
import { printLine, withNamedSigner } from "./keys.ts";

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
const BLOB_MESSAGE =
  "blob transactions (EIP-4844) cannot be signed with KMS accounts; send them from another account";

/**
 * The fields `eth_sendTransaction` takes, as Hardhat 3.18's request schema (`rpcTransactionRequest`)
 * reads them, plus `type`. Any other field is refused: the schema drops unknown fields, so a
 * misspelt `gasLimit` or an `input` would otherwise be signed as if it were absent.
 */
const KNOWN_FIELDS = new Set([
  "from",
  "to",
  "gas",
  "gasPrice",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "value",
  "data",
  "nonce",
  "chainId",
  "accessList",
  "authorizationList",
  "blobs",
  "blobVersionedHashes",
  "type",
]);

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
    throw kmsError(
      `cannot read the transaction file ${file} (${typeof code === "string" ? code : errorName(error)})`,
      { operation: OPERATION },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : errorName(error);
    throw kmsError(`the transaction file ${file} is not valid JSON: ${reason}`, {
      operation: OPERATION,
    });
  }
  if (!isObject(parsed) || Array.isArray(parsed)) {
    throw kmsError(
      `the transaction file ${file} must hold one JSON object with eth_sendTransaction fields`,
      { operation: OPERATION },
    );
  }
  return parsed;
}

/**
 * Refuses fields the task does not sign: unknown or renamed fields, and blob transactions.
 *
 * @param tx - The transaction from the file.
 * @returns The `type` the transaction asks for, if any, as micro-eth-signer names it.
 */
function checkFields(tx: Record<string, unknown>): string | undefined {
  if (tx.maxFeePerBlobGas !== undefined) {
    throw kmsError(BLOB_MESSAGE, { operation: OPERATION });
  }
  const unknown = Object.keys(tx).filter((field) => !KNOWN_FIELDS.has(field));
  if (unknown.length > 0) {
    const hints = unknown.flatMap((field) => {
      const renamed = RENAMED_FIELDS[field];
      return renamed === undefined ? [] : [`use ${renamed} instead of ${field}`];
    });
    throw kmsError(
      `unknown transaction ${unknown.length === 1 ? "field" : "fields"} ${unknown.join(", ")}${
        hints.length > 0 ? ` (${hints.join("; ")})` : ""
      }. The fields are those of eth_sendTransaction: ${[...KNOWN_FIELDS].join(", ")}.`,
      { operation: OPERATION },
    );
  }
  if (tx.type === undefined) {
    return undefined;
  }
  if (typeof tx.type !== "string" || !/^0x[0-9a-fA-F]+$/.test(tx.type)) {
    throw kmsError('type must be a hex quantity, such as "0x2"', { operation: OPERATION });
  }
  const number = Number.parseInt(tx.type, 16);
  if (number === 3) {
    throw kmsError(BLOB_MESSAGE, { operation: OPERATION });
  }
  const type = TYPES[number];
  if (type === undefined) {
    throw kmsError(
      `transaction type ${tx.type} is not supported; KMS accounts sign types 0x0, 0x1, 0x2 and 0x4`,
      { operation: OPERATION },
    );
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
    throw kmsError(
      `the transaction asks for type ${describeType(requested)}, but its fields make it type ${describeType(unsigned.type)}; nothing was signed. Set the fee fields of type ${describeType(requested)}, or remove type.`,
      { operation: OPERATION },
    );
  }
}

/**
 * `kms sign-tx <key> <tx> --network <name>`: fills a transaction on the network's node the way
 * `eth_signTransaction` does, signs it with the key and prints the raw signed transaction and its
 * hash, one per line. It never broadcasts.
 *
 * @param args - The task arguments.
 * @param hre - The Hardhat runtime.
 * @returns The raw signed transaction and its hash.
 */
const kmsSignTx: NewTaskActionFunction<SignTxArguments> = async ({ key, tx: file }, hre) => {
  const network = hre.globalOptions.network;
  if (network === undefined) {
    throw kmsError(
      "--network is required: the transaction is filled on that network's node, and its chain id is checked against it",
      { operation: OPERATION },
    );
  }
  const tx = await readTransaction(file);
  const requestedType = checkFields(tx);
  const { type: _type, ...request } = tx;
  const signed: SignedTransaction = await withNamedSigner(hre, key, async (signer) => {
    const address = (await signer.getAddress()).toLowerCase();
    const { from } = request;
    if (from !== undefined && (typeof from !== "string" || !sameAddress(from, address))) {
      throw kmsError(
        `the transaction's from is ${typeof from === "string" ? from : typeof from}, but key ${key} has the address ${toChecksumAddress(address)}. Remove from, or name the key of that address.`,
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
  printLine(signed.raw);
  printLine(signed.hash);
  return { raw: signed.raw, hash: signed.hash };
};

export default kmsSignTx;
