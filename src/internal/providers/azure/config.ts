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

const checkKeyId = (value: string): string | undefined =>
  parseAzureKeyId(value) === undefined
    ? `expected ${HOSTS} with the path /keys/<name> or /keys/<name>/<version>`
    : undefined;

// A vault URL is used in its canonical form (its origin); an invalid one then fails `checkKeyId`.
const canonicalVault = (value: string): string => parseAzureVaultUrl(value) ?? value;

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
  const part = (field: string, value: Parameters<typeof resolveIdentifier>[0]) =>
    resolveIdentifier(value, context.resolveVariable, `${context.path}.${field}`);
  let keyId;
  if ("keyId" in key) {
    keyId = resolveIdentifier(
      key.keyId,
      context.resolveVariable,
      `${context.path}.keyId`,
      checkKeyId,
    );
  } else if (key.keyVersion === undefined) {
    keyId = joinIdentifiers(
      ({ vaultUrl, keyName }) => `${canonicalVault(vaultUrl)}/keys/${keyName}`,
      { vaultUrl: part("vaultUrl", key.vaultUrl), keyName: part("keyName", key.keyName) },
      context.path,
      checkKeyId,
    );
  } else {
    keyId = joinIdentifiers(
      ({ vaultUrl, keyName, keyVersion }) =>
        `${canonicalVault(vaultUrl)}/keys/${keyName}/${keyVersion}`,
      {
        vaultUrl: part("vaultUrl", key.vaultUrl),
        keyName: part("keyName", key.keyName),
        keyVersion: part("keyVersion", key.keyVersion),
      },
      context.path,
      checkKeyId,
    );
  }
  return {
    provider: "azure",
    ...resolveCommonKeyConfig(key, context, `azure:${keyId.display}`),
    keyId,
  };
}
