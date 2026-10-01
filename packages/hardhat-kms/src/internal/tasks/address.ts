import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { printLine, withNamedSigner } from "./keys.ts";

/** The arguments of `kms address`. */
interface AddressArguments {
  key: string;
}

/**
 * `kms address <key>`: prints the key's EIP-55 checksummed address. The address comes from the
 * KMS, and a configured `address` pin must match it.
 *
 * @param args - The task arguments.
 * @param hre - The Hardhat runtime.
 * @returns The address.
 */
const kmsAddress: NewTaskActionFunction<AddressArguments> = async ({ key }, hre) => {
  const address = await withNamedSigner(hre, key, async (signer) => await signer.getAddress());
  printLine(address);
  return address;
};

export default kmsAddress;
