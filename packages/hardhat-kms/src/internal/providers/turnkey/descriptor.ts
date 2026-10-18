import type { KmsProviderDescriptor } from "../types.ts";
import { wrongProvider } from "../wrong-provider.ts";
import { resolveTurnkeyKey, turnkeyKeySchema } from "./config.ts";

/** The Turnkey provider. */
export const turnkeyProvider: KmsProviderDescriptor = {
  id: "turnkey",
  schema: turnkeyKeySchema,
  resolve: (key, context) =>
    key.provider === "turnkey"
      ? resolveTurnkeyKey(key, context)
      : wrongProvider("turnkey", key.provider),
  name: "Turnkey",
  adapter: { package: "@hardhat-kms/turnkey", historyReader: false },
};
