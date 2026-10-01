/**
 * Prints a warning for the user, prefixed with the plugin name. Hardhat plugins print warnings
 * with `console.warn`; this is the plugin's only place that does.
 *
 * @param message - The warning, without the prefix.
 */
export function warn(message: string): void {
  // oxlint-disable-next-line eslint/no-console -- a warning for the user, as Hardhat plugins print them
  console.warn(`hardhat-kms: ${message}`);
}
