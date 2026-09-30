// The `kms` config types, for users who import only this package. A type reference, unlike an
// import, adds nothing to the JavaScript, so a missing hardhat-kms fails with Hardhat's own
// missing-plugin error rather than a module-not-found error when the config loads.
/// <reference types="hardhat-kms/types" preserve="true" />
import { definePlugin } from "hardhat/plugins";
import type { HardhatPlugin } from "hardhat/types/plugins";

/**
 * The AWS KMS provider for hardhat-kms: signs with the `aws` keys of your `kms` config.
 *
 * Add it to the `plugins` array of your Hardhat config. It loads hardhat-kms itself, so
 * `hardhat-kms` does not need its own entry.
 */
const hardhatKmsAwsPlugin: HardhatPlugin = definePlugin({
  id: "hardhat-kms-aws",
  npmPackage: "hardhat-kms-aws",
  dependencies: () => [import("hardhat-kms")],
  hookHandlers: {
    kms: () => import("./internal/hook-handlers/kms.ts"),
  },
});

export default hardhatKmsAwsPlugin;
