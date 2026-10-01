import { bytesToHexString } from "@nomicfoundation/hardhat-utils/hex";
import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { printLine, withNamedSigner } from "./keys.ts";

/** The arguments of `kms public-key`. */
interface PublicKeyArguments {
  key: string;
}

/**
 * `kms public-key <key>`: prints the key's uncompressed public key, 65 bytes starting with `0x04`.
 * A configured `address` pin must match it.
 *
 * @param args - The task arguments.
 * @param hre - The Hardhat runtime.
 * @returns The public key as hex.
 */
const kmsPublicKey: NewTaskActionFunction<PublicKeyArguments> = async ({ key }, hre) => {
  const publicKey = bytesToHexString(
    await withNamedSigner(hre, key, async (signer) => await signer.getPublicKey()),
  );
  printLine(publicKey);
  return publicKey;
};

export default kmsPublicKey;
