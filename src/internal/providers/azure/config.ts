import { conditionalUnionType, incompatibleFieldType } from "@nomicfoundation/hardhat-zod-utils";
import { z } from "zod";

import type { AzureKmsKeyConfig, AzureKmsKeyUserConfig } from "../../../types.ts";
import { commonKeyFields, identifierSchema } from "../../config/common.ts";
import { joinIdentifiers, resolveIdentifier } from "../../config/identifiers.ts";
import { type KeyResolveContext, resolveCommonKeyConfig } from "../../config/key-common.ts";
import {
  isAzureKeyName,
  isAzureKeyVersion,
  parseAzureKeyId,
  parseAzureVaultUrl,
} from "./key-id.ts";

const EITHER_FORM =
  "Use either `keyId` or `vaultUrl` with `keyName` (and an optional `keyVersion`), not both";
const HOSTS =
  "an https URL on an Azure Key Vault or Managed HSM host (for example `*.vault.azure.net`)";

const keyIdSchema = z
  .object({
    provider: z.literal("azure"),
    keyId: identifierSchema,
    vaultUrl: incompatibleFieldType(EITHER_FORM),
    keyName: incompatibleFieldType(EITHER_FORM),
    keyVersion: incompatibleFieldType(EITHER_FORM),
    ...commonKeyFields,
  })
  .strict()
  .superRefine((key, ctx) => {
    if (typeof key.keyId === "string" && parseAzureKeyId(key.keyId) === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keyId"],
        message: `Expected ${HOSTS} with the path /keys/<name> or /keys/<name>/<version>`,
      });
    }
  });

const componentsSchema = z
  .object({
    provider: z.literal("azure"),
    keyId: incompatibleFieldType(EITHER_FORM),
    vaultUrl: identifierSchema,
    keyName: identifierSchema,
    keyVersion: identifierSchema.optional(),
    ...commonKeyFields,
  })
  .strict()
  .superRefine((key, ctx) => {
    if (typeof key.vaultUrl === "string" && parseAzureVaultUrl(key.vaultUrl) === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["vaultUrl"],
        message: `Expected ${HOSTS}, with no path`,
      });
    }
    if (typeof key.keyName === "string" && !isAzureKeyName(key.keyName)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keyName"],
        message: "Expected 1 to 127 letters, digits or dashes",
      });
    }
    if (typeof key.keyVersion === "string" && !isAzureKeyVersion(key.keyVersion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keyVersion"],
        message: "Expected letters and digits only",
      });
    }
  });

/** Validates an Azure Key Vault or Managed HSM key config, in either of its two forms. */
export const azureKeySchema: z.ZodTypeAny = conditionalUnionType(
  [
    [(data) => typeof data === "object" && data !== null && "keyId" in data, keyIdSchema],
    [() => true, componentsSchema],
  ],
  EITHER_FORM,
);

/**
 * Resolves an Azure key config into a key identifier URL.
 *
 * @param key - The validated key config.
 * @param context - The key's name and the resolved defaults.
 * @returns The resolved key.
 */
export function resolveAzureKey(
  key: AzureKmsKeyUserConfig,
  context: KeyResolveContext,
): AzureKmsKeyConfig {
  const resolve = (value: Parameters<typeof resolveIdentifier>[0]) =>
    resolveIdentifier(value, context.resolveVariable);
  let keyId;
  if ("keyId" in key) {
    keyId = resolve(key.keyId);
  } else if (key.keyVersion === undefined) {
    keyId = joinIdentifiers(
      ({ vaultUrl, keyName }) => `${vaultUrl.replace(/\/$/, "")}/keys/${keyName}`,
      {
        vaultUrl: resolve(key.vaultUrl),
        keyName: resolve(key.keyName),
      },
    );
  } else {
    keyId = joinIdentifiers(
      ({ vaultUrl, keyName, keyVersion }) =>
        `${vaultUrl.replace(/\/$/, "")}/keys/${keyName}/${keyVersion}`,
      {
        vaultUrl: resolve(key.vaultUrl),
        keyName: resolve(key.keyName),
        keyVersion: resolve(key.keyVersion),
      },
    );
  }
  return {
    provider: "azure",
    ...resolveCommonKeyConfig(key, context, `azure:${keyId.display}`),
    keyId,
  };
}
