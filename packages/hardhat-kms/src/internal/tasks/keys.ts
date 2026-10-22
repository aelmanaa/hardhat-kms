import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import type { KmsKeyConfig } from "../../types.ts";
import { keyIdentity } from "../config/key-identity.ts";
import { sameAddress } from "../crypto/address.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogError } from "../errors.ts";
import { commandLineKeys } from "../hook-handlers/hre.ts";
import { SignerCache } from "../signer/key-cache.ts";
import type { KmsSigner } from "../signer/kms-signer.ts";
import { systemTimers } from "../signer/timeout.ts";

/** Where a key that a task can name comes from. */
type TaskKeySource = "kms.keys" | "kmsAccounts" | "--kms";

/** A key that a task can name on the command line. */
export interface TaskKey {
  /** The name to type: `deployer`, `sepolia.kmsAccounts[0]` or `AWS_KMS_KEY_ID`. */
  name: string;
  source: TaskKeySource;
  key: KmsKeyConfig;
}

/**
 * Every key a task can name, each once: the keys in `kms.keys`, then the inline keys of each
 * network's `kmsAccounts`, then the keys chosen with `--kms`. A network entry that names a key in
 * `kms.keys` is that key, so it is not listed again.
 *
 * @param hre - The Hardhat runtime.
 * @returns The keys, in that order.
 */
export function taskKeys(hre: HardhatRuntimeEnvironment): TaskKey[] {
  const listed = new Set<KmsKeyConfig>();
  const keys: TaskKey[] = [];
  const add = (key: KmsKeyConfig, source: TaskKeySource): void => {
    if (!listed.has(key)) {
      listed.add(key);
      keys.push({ name: key.name, source, key });
    }
  };
  for (const key of Object.values(hre.config.kms.keys)) {
    add(key, "kms.keys");
  }
  for (const network of Object.values(hre.config.networks)) {
    if (network.type === "http" || network.type === "edr-simulated") {
      for (const key of network.kmsAccounts) {
        add(key, "kmsAccounts");
      }
    }
  }
  for (const key of commandLineKeys(hre)) {
    add(key, "--kms");
  }
  return keys;
}

/**
 * Finds the key a task names. The error for an unknown name lists the names a task accepts, which
 * are safe to print: none of them is a key id.
 *
 * @param hre - The Hardhat runtime.
 * @param name - The name from the command line.
 * @returns The key.
 */
export function findTaskKey(hre: HardhatRuntimeEnvironment, name: string): KmsKeyConfig {
  const keys = taskKeys(hre);
  const matches = keys.filter((candidate) => candidate.name === name);
  const [match, other] = matches;
  if (match !== undefined && other === undefined) {
    return match.key;
  }
  if (match !== undefined && other !== undefined) {
    // Only a key in `kms.keys` and a `--kms` key can share a name today, such as AWS_KMS_KEY_ID.
    const sources = matches.map((candidate) => candidate.source);
    throw catalogError(ERRORS.keyNameAmbiguous, { name, sources: sources.join(" and ") });
  }
  const known = keys.map((candidate) => candidate.name);
  if (known.length === 0) {
    throw catalogError(ERRORS.taskUnknownKeyNoKeys, { name });
  }
  // Key names are case-sensitive; a slip in case is the likeliest mistake.
  const sameLetters = known.filter((candidate) => candidate.toLowerCase() === name.toLowerCase());
  throw sameLetters.length === 0
    ? catalogError(ERRORS.taskUnknownKey, { name, known: known.join(", ") })
    : catalogError(ERRORS.taskUnknownKeySuggested, {
        name,
        suggestions: sameLetters.join('" or "'),
        known: known.join(", "),
      });
}

/**
 * Refuses a `--kms` key that is the same KMS key as a config key with `allowedDelegates`: the
 * `--kms` key has no config and so no list, and signing an authorization with it would skip the
 * config key's list (#562). An unpinned config key is the same when its identifier names the same
 * KMS key; a pinned one when the `--kms` key's address, once known, equals its `address` pin. The
 * network hook refuses such a pair only on connections; `kms sign-auth --chain` and `kms sign-tx`
 * check here.
 *
 * @param hre - The Hardhat runtime.
 * @param key - The key the task signs with.
 * @param operation - The task, for the error message.
 * @param address - The key's address, when it is known.
 */
export async function refuseListBypass(
  hre: HardhatRuntimeEnvironment,
  key: KmsKeyConfig,
  operation: string,
  address?: string,
): Promise<void> {
  if (!commandLineKeys(hre).includes(key)) {
    return;
  }
  const listed = taskKeys(hre).filter(
    (candidate) => candidate.source !== "--kms" && candidate.key.allowedDelegates !== undefined,
  );
  if (listed.length === 0) {
    return;
  }
  const id = await keyIdentity(key);
  for (const { key: other } of listed) {
    // As in the network hook, a pinned config key is compared by its pin, not read: reading it
    // could ask for a variable or a keystore password the run would not otherwise need.
    const same =
      other.address === undefined
        ? id !== undefined && id === (await keyIdentity(other))
        : address !== undefined && sameAddress(address, other.address);
    if (same) {
      throw catalogError(
        ERRORS.delegateCommandLineKey,
        { name: key.name, other: other.name },
        { operation },
      );
    }
  }
}

/**
 * Runs `use` with signers for a task, then closes every signer it opened, so the SDK clients do
 * not keep the process running. Each call has its own signers, apart from the network hook's.
 *
 * @param hre - The Hardhat runtime.
 * @param use - What to do; `signerFor` opens the signer of a key, once per key.
 * @returns What `use` returns.
 */
export async function withTaskSigners<T>(
  hre: HardhatRuntimeEnvironment,
  use: (signerFor: (key: KmsKeyConfig) => Promise<KmsSigner>) => Promise<T>,
): Promise<T> {
  // Status messages go to standard error, so standard output holds only the task's result.
  const cache = new SignerCache(systemTimers, async (_context, message) => {
    printNote(message);
  });
  try {
    return await use(async (key) => await cache.signerFor(hre, key));
  } finally {
    await cache.closeAll();
  }
}

/**
 * Runs `use` with the signer of the key a task names, then closes it.
 *
 * @param hre - The Hardhat runtime.
 * @param name - The key's name from the command line.
 * @param use - What to do with the signer.
 * @returns What `use` returns.
 */
export async function withNamedSigner<T>(
  hre: HardhatRuntimeEnvironment,
  name: string,
  use: (signer: KmsSigner) => Promise<T>,
): Promise<T> {
  const key = findTaskKey(hre, name);
  return await withTaskSigners(hre, async (signerFor) => await use(await signerFor(key)));
}

/**
 * Prints one line of a task's result to standard output, where scripts can read it.
 *
 * @param line - The text, without the newline.
 */
export function printLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Prints a status line or a warning for the person running a task to standard error, so that
 * standard output holds only the result.
 *
 * @param line - The text, without the prefix or the newline.
 */
export function printNote(line: string): void {
  process.stderr.write(`[hardhat-kms] ${line}\n`);
}
