import {
  conditionalUnionType,
  incompatibleFieldType,
  unionType,
} from "@nomicfoundation/hardhat-zod-utils";
import { z } from "zod";

import type { GcpKmsKeyConfig, GcpKmsKeyUserConfig, KmsIdentifier } from "../../../types.ts";
import { commonKeyFields, identifierSchema } from "../../config/common.ts";
import { joinIdentifiers, resolveIdentifier } from "../../config/identifiers.ts";
import { type KeyResolveContext, resolveCommonKeyConfig } from "../../config/key-common.ts";
import {
  gcpKeyVersionName,
  isGcpKeyVersion,
  isGcpSegment,
  parseGcpKeyVersionName,
} from "./key-version-name.ts";

const COMPONENTS = ["projectId", "location", "keyRing", "keyName", "keyVersion"] as const;
const EITHER_FORM =
  "Use either `keyVersionName` or `projectId`, `location`, `keyRing`, `keyName` and `keyVersion`, not both";

const keyVersionNameSchema = z
  .object({
    provider: z.literal("gcp"),
    keyVersionName: identifierSchema,
    ...Object.fromEntries(COMPONENTS.map((field) => [field, incompatibleFieldType(EITHER_FORM)])),
    ...commonKeyFields,
  })
  .strict()
  .superRefine((key, ctx) => {
    if (
      typeof key.keyVersionName === "string" &&
      parseGcpKeyVersionName(key.keyVersionName) === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keyVersionName"],
        message:
          "Expected projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>/cryptoKeyVersions/<version>",
      });
    }
  });

const componentsSchema = z
  .object({
    provider: z.literal("gcp"),
    keyVersionName: incompatibleFieldType(EITHER_FORM),
    projectId: identifierSchema,
    location: identifierSchema,
    keyRing: identifierSchema,
    keyName: identifierSchema,
    keyVersion: unionType(
      [identifierSchema, z.number().int().positive()],
      "Expected a positive integer, a string or a Configuration Variable",
    ),
    ...commonKeyFields,
  })
  .strict()
  .superRefine((key, ctx) => {
    for (const field of ["projectId", "location", "keyRing", "keyName"] as const) {
      const value: unknown = key[field];
      if (typeof value === "string" && !isGcpSegment(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "Expected a non-empty value without slashes",
        });
      }
    }
    const version: unknown = key.keyVersion;
    if (typeof version === "string" && !isGcpKeyVersion(version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keyVersion"],
        message: "Expected a positive integer version",
      });
    }
  });

/** Validates a Google Cloud KMS key config, in either of its two forms. */
export const gcpKeySchema: z.ZodTypeAny = conditionalUnionType(
  [
    [
      (data) => typeof data === "object" && data !== null && "keyVersionName" in data,
      keyVersionNameSchema,
    ],
    [() => true, componentsSchema],
  ],
  EITHER_FORM,
);

/**
 * Resolves a Google Cloud KMS key config into a key version name.
 *
 * @param key - The validated key config.
 * @param context - The key's name and the resolved defaults.
 * @returns The resolved key.
 */
export function resolveGcpKey(
  key: GcpKmsKeyUserConfig,
  context: KeyResolveContext,
): GcpKmsKeyConfig {
  const resolve = (
    value: string | number | Parameters<typeof resolveIdentifier>[0],
  ): KmsIdentifier =>
    resolveIdentifier(typeof value === "number" ? String(value) : value, context.resolveVariable);
  const keyVersionName =
    "keyVersionName" in key
      ? resolve(key.keyVersionName)
      : joinIdentifiers(gcpKeyVersionName, {
          projectId: resolve(key.projectId),
          location: resolve(key.location),
          keyRing: resolve(key.keyRing),
          keyName: resolve(key.keyName),
          keyVersion: resolve(key.keyVersion),
        });
  return {
    provider: "gcp",
    ...resolveCommonKeyConfig(key, context, `gcp:${keyVersionName.display}`),
    keyVersionName,
  };
}
