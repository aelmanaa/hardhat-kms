import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import type { KmsKeyConfig } from "../../types.ts";
import { kmsError } from "../errors.ts";
import { commandLineKeys } from "../hook-handlers/hre.ts";
import { SignerCache } from "../signer/key-cache.ts";
import type { KmsSigner } from "../signer/kms-signer.ts";

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
    // Only a key in `kms.keys` and a `--kms` key can share a name, such as AWS_KMS_KEY_ID.
    throw kmsError(
      `"${name}" names both a key in kms.keys and a key from --kms; rename the key in kms.keys`,
    );
  }
  const known = keys.map((candidate) => candidate.name);
  throw kmsError(
    `unknown key "${name}". ${known.length === 0 ? "No KMS keys are configured: add them to kms.keys or a network's kmsAccounts, or pass --kms." : `Known keys: ${known.join(", ")}.`}`,
  );
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
  const cache = new SignerCache();
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
