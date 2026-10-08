// Where the live suite sends its transactions. A fork of Sepolia is the default: it signs with the
// real KMS keys and checks every transaction on a local anvil node, at no cost. Real Sepolia needs
// HARDHAT_KMS_LIVE_NETWORK=sepolia.
//
// Which packages it runs: the checkout's by default, or the published ones with
// HARDHAT_KMS_LIVE_SOURCE=registry:<version> (helpers/packages.ts).
import { exactVersion } from "../../../scripts/registry.ts";

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

/** The variable that selects where the suite takes hardhat-kms and the provider plugins from. */
export const SOURCE_VARIABLE = "HARDHAT_KMS_LIVE_SOURCE";

/**
 * `source`: the checkout's packages. `registry`: the four packages installed from the registry at
 * `version`.
 */
export type LiveSource = { kind: "source" } | { kind: "registry"; version: string };

/**
 * Reads the package source from the environment. An unset or empty variable, or `source`, means
 * the checkout.
 *
 * @param env - The environment, normally `process.env`.
 * @returns The source.
 * @throws If the variable holds anything other than `source` or `registry:<exact version>`, so a
 *   typo or a range such as `registry:^1.0.0` cannot pick a source by accident.
 */
export function liveSource(env: Readonly<Record<string, string | undefined>>): LiveSource {
  const value = env[SOURCE_VARIABLE]?.trim() ?? "";
  if (value === "" || value === "source") {
    return { kind: "source" };
  }
  if (value.startsWith("registry:")) {
    try {
      return { kind: "registry", version: exactVersion(value.slice("registry:".length)) };
    } catch {
      // The message below names this variable rather than --from-registry.
    }
  }
  throw new Error(
    `${SOURCE_VARIABLE} must be "source" or "registry:<exact version>", such as registry:1.0.0, not "${value}"`,
  );
}
