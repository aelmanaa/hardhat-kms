import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { printLine, printNote, withNamedSigner } from "./keys.ts";

/** The arguments of `kms address`. */
interface AddressArguments {
  key: string;
}

/**
 * `kms address <key>`: prints the key's EIP-55 checksummed address. The address comes from the
 * KMS, and a configured `address` pin must match it. A provider that can report neither a public
 * key nor an address leaves only the pin, which is printed with a note on standard error.
 *
 * @param args - The task arguments.
 * @param hre - The Hardhat runtime.
 * @returns The address.
 */
const kmsAddress: NewTaskActionFunction<AddressArguments> = async ({ key }, hre) => {
  const { address, confirmed } = await withNamedSigner(
    hre,
    key,
    async (signer) => await signer.confirmedAddress(),
  );
  if (!confirmed) {
    printNote(
      `${key}: the provider cannot report this key's address, so this is the configured \`address\` pin, not checked yet. The first signature checks it.`,
    );
  }
  printLine(address);
  return address;
};

export default kmsAddress;
