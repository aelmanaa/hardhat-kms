import { z } from "zod";

import type { AwsKmsKeyConfig, AwsKmsKeyUserConfig } from "../../../types.ts";
import { commonKeyFields, identifierSchema, nonEmptyString } from "../../config/common.ts";
import { resolveIdentifier } from "../../config/identifiers.ts";
import { type KeyResolveContext, resolveCommonKeyConfig } from "../../config/key-common.ts";
import { AWS_KEY_ID_FORMS, parseAwsKeyId } from "./key-id.ts";

function isHttpUrl(value: string): boolean {
  try {
    const { protocol, username, password } = new URL(value);
    // Credentials in the URL would end up in logs and errors; the SDK takes them from its own chain.
    return (protocol === "http:" || protocol === "https:") && username === "" && password === "";
  } catch {
    return false;
  }
}

/** Validates an AWS KMS key config. */
export const awsKeySchema: z.ZodTypeAny = z
  .object({
    provider: z.literal("aws"),
    keyId: identifierSchema,
    region: nonEmptyString.optional(),
    profile: nonEmptyString.optional(),
    endpoint: z
      .string()
      .refine(
        isHttpUrl,
        "Expected an http or https URL without credentials, such as http://localhost:4566",
      )
      .optional(),
    ...commonKeyFields,
  })
  .strict()
  .superRefine((key, ctx) => {
    if (typeof key.keyId !== "string") {
      return;
    }
    const parsed = parseAwsKeyId(key.keyId);
    if (parsed === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keyId"],
        message: `Expected ${AWS_KEY_ID_FORMS}`,
      });
    } else if (
      parsed.region !== undefined &&
      key.region !== undefined &&
      parsed.region !== key.region
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["region"],
        message: `Conflicts with the region in the key ARN (${parsed.region})`,
      });
    }
  });

/**
 * Resolves an AWS KMS key config.
 *
 * @param key - The validated key config.
 * @param context - The key's name and the resolved defaults.
 * @returns The resolved key.
 */
export function resolveAwsKey(
  key: AwsKmsKeyUserConfig,
  context: KeyResolveContext,
): AwsKmsKeyConfig {
  const keyId = resolveIdentifier(
    key.keyId,
    context.resolveVariable,
    `${context.path}.keyId`,
    (value) => {
      const parsed = parseAwsKeyId(value);
      if (parsed === undefined) {
        return `expected ${AWS_KEY_ID_FORMS}`;
      }
      if (parsed.region !== undefined && key.region !== undefined && parsed.region !== key.region) {
        return `the key ARN's region conflicts with \`region\` (${key.region})`;
      }
      return undefined;
    },
  );
  const arnRegion = typeof key.keyId === "string" ? parseAwsKeyId(key.keyId)?.region : undefined;
  const region = arnRegion ?? key.region ?? context.defaults.aws.region;
  return {
    provider: "aws",
    ...resolveCommonKeyConfig(key, context, `aws:${keyId.display}`),
    keyId,
    ...(region === undefined ? {} : { region }),
    ...(key.profile === undefined ? {} : { profile: key.profile }),
    ...(key.endpoint === undefined ? {} : { endpoint: key.endpoint }),
  };
}
