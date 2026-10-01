// Where the live suite sends its transactions. A fork of Sepolia is the default: it signs with the
// real KMS keys and checks every transaction on a local anvil node, at no cost. Real Sepolia needs
// HARDHAT_KMS_LIVE_NETWORK=sepolia.

/** The variable that selects the mode. */
export const MODE_VARIABLE = "HARDHAT_KMS_LIVE_NETWORK";

/** `fork`: a local anvil fork of Sepolia. `sepolia`: the public network, which spends Sepolia ETH. */
export type LiveMode = "fork" | "sepolia";

/**
 * Reads the mode from the environment. An unset or empty variable means the fork.
 *
 * @param env - The environment, normally `process.env`.
 * @returns The mode.
 * @throws If the variable holds anything other than `fork` or `sepolia`, so a typo cannot pick a
 *   mode by accident.
 */
export function liveMode(env: Readonly<Record<string, string | undefined>>): LiveMode {
  const value = env[MODE_VARIABLE]?.trim().toLowerCase() ?? "";
  if (value === "" || value === "fork") {
    return "fork";
  }
  if (value === "sepolia") {
    return "sepolia";
  }
  throw new Error(`${MODE_VARIABLE} must be "fork" or "sepolia", not "${value}"`);
}
