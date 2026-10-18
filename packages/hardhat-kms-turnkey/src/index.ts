// The `kms` config types, for users who import only this package. A type reference, unlike an
// import, adds nothing to the JavaScript, so a missing hardhat-kms fails with Hardhat's own
// missing-plugin error rather than a module-not-found error when the config loads.
/// <reference types="hardhat-kms/types" preserve="true" />
import { definePlugin } from "hardhat/plugins";
import type { HardhatPlugin } from "hardhat/types/plugins";

/**
 * The Turnkey provider for hardhat-kms: signs with the `turnkey` keys of your `kms` config,
 * through Turnkey's API with an API key.
 *
 * Add it to the `plugins` array of your Hardhat config. It loads hardhat-kms itself, so
 * `hardhat-kms` does not need its own entry.
 */
const hardhatKmsTurnkeyPlugin: HardhatPlugin = definePlugin({
  id: "@hardhat-kms/turnkey",
  npmPackage: "@hardhat-kms/turnkey",
  dependencies: () => [import("hardhat-kms")],
  hookHandlers: {
    kms: () => import("./internal/hook-handlers/kms.ts"),
  },
});

export default hardhatKmsTurnkeyPlugin;
