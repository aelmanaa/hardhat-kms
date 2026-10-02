import {
  conditionalUnionType,
  incompatibleFieldType,
  unionType,
} from "@nomicfoundation/hardhat-zod-utils";
import { z } from "zod";

import type {
  GcpKmsKeyConfig,
  GcpKmsKeyUserConfig,
  KmsIdentifier,
  KmsIdentifierUserConfig,
} from "../../../types.ts";
import { commonKeyFields, identifierSchema } from "../../config/common.ts";
import { joinIdentifiers, resolveIdentifier } from "../../config/identifiers.ts";
import { type KeyResolveContext, resolveCommonKeyConfig } from "../../config/key-common.ts";
import { ERRORS } from "../../error-catalog.ts";
import { catalogMessage } from "../../errors.ts";
import {
  gcpKeyVersionName,
  isGcpKeyVersion,
  isGcpSegment,
  parseGcpKeyVersionName,
} from "./key-version-name.ts";

const COMPONENTS = ["projectId", "location", "keyRing", "keyName", "keyVersion"] as const;
const EITHER_FORM = catalogMessage(ERRORS.gcpEitherForm, {});

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
        message: catalogMessage(ERRORS.gcpKeyVersionName, {}),
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
      [identifierSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER)],
      catalogMessage(ERRORS.gcpKeyVersionType, {}),
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
          message: catalogMessage(ERRORS.gcpSegment, {}),
        });
      }
    }
    const version: unknown = key.keyVersion;
    if (typeof version === "string" && !isGcpKeyVersion(version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keyVersion"],
        message: catalogMessage(ERRORS.gcpKeyVersion, {}),
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

const checkKeyVersionName = (value: string): string | undefined =>
  parseGcpKeyVersionName(value) === undefined
    ? catalogMessage(ERRORS.gcpKeyVersionNameReason, {})
    : undefined;

const checkSegment = (value: string): string | undefined =>
  isGcpSegment(value) ? undefined : catalogMessage(ERRORS.gcpSegmentReason, {});

const checkKeyVersion = (value: string): string | undefined =>
  isGcpKeyVersion(value) ? undefined : catalogMessage(ERRORS.gcpKeyVersionReason, {});

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
  // Each part is checked on its own, so an error names the part (and its variable) at fault.
  const part = (field: string, value: KmsIdentifierUserConfig | number): KmsIdentifier =>
    resolveIdentifier(
      typeof value === "number" ? String(value) : value,
      context.resolveVariable,
      `${context.path}.${field}`,
      field === "keyVersion" ? checkKeyVersion : checkSegment,
    );
  const keyVersionName =
    "keyVersionName" in key
      ? resolveIdentifier(
          key.keyVersionName,
          context.resolveVariable,
          `${context.path}.keyVersionName`,
          checkKeyVersionName,
        )
      : joinIdentifiers(
          gcpKeyVersionName,
          {
            projectId: part("projectId", key.projectId),
            location: part("location", key.location),
            keyRing: part("keyRing", key.keyRing),
            keyName: part("keyName", key.keyName),
            keyVersion: part("keyVersion", key.keyVersion),
          },
          context.path,
          checkKeyVersionName,
        );
  return {
    provider: "gcp",
    ...resolveCommonKeyConfig(key, context, `gcp:${keyVersionName.display}`),
    keyVersionName,
  };
}
