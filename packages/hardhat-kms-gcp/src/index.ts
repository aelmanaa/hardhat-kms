// The `kms` config types, for users who import only this package. A type reference, unlike an
// import, adds nothing to the JavaScript, so a missing hardhat-kms fails with Hardhat's own
// missing-plugin error rather than a module-not-found error when the config loads.
/// <reference types="hardhat-kms/types" preserve="true" />
import { definePlugin } from "hardhat/plugins";
import type { HardhatPlugin } from "hardhat/types/plugins";

/**
 * The Google Cloud KMS provider for hardhat-kms: signs with the `gcp` keys of your `kms` config.
 *
 * Add it to the `plugins` array of your Hardhat config. It loads hardhat-kms itself, so
 * `hardhat-kms` does not need its own entry.
 */
const hardhatKmsGcpPlugin: HardhatPlugin = definePlugin({
  id: "hardhat-kms-gcp",
  npmPackage: "hardhat-kms-gcp",
  dependencies: () => [import("hardhat-kms")],
  hookHandlers: {
    kms: () => import("./internal/hook-handlers/kms.ts"),
  },
});

export default hardhatKmsGcpPlugin;
