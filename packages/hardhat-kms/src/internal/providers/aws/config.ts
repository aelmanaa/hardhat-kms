import { z } from "zod";

import type { AwsKmsKeyConfig, AwsKmsKeyUserConfig } from "../../../types.ts";
import { commonKeyFields, identifierSchema, settingSchema } from "../../config/common.ts";
import { firstSetIdentifier, resolveIdentifier } from "../../config/identifiers.ts";
import { type KeyResolveContext, resolveCommonKeyConfig } from "../../config/key-common.ts";
import { ERRORS } from "../../error-catalog.ts";
import { catalogMessage } from "../../errors.ts";
import { parseAwsKeyId } from "./key-id.ts";

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
    region: settingSchema.optional(),
    profile: settingSchema.optional(),
    endpoint: z.string().refine(isHttpUrl, catalogMessage(ERRORS.awsEndpoint, {})).optional(),
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
        message: catalogMessage(ERRORS.awsKeyId, {}),
      });
    } else if (
      parsed.region !== undefined &&
      // A region from a configuration variable is compared when the key is first used.
      typeof key.region === "string" &&
      parsed.region !== key.region
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["region"],
        message: catalogMessage(ERRORS.awsRegionConflict, { region: parsed.region }),
      });
    }
  });

/**
 * Resolves an AWS KMS key config. Nothing is read from configuration variables here: `keyId`,
 * `region` and `profile` are read when the key is first used.
 *
 * The resolved `region` is the first one set among a literal key ARN's region, the key's `region`
 * and `kms.defaults.aws.region`. A `region` from a configuration variable whose value is empty
 * falls back to `kms.defaults.aws.region`. When `keyId` reads as a key ARN, its region wins, and
 * a `region` that names another one fails the `keyId` check: at validation for two literals, at
 * first use when either comes from a configuration variable.
 *
 * @param key - The validated key config.
 * @param context - The key's name and the resolved defaults.
 * @returns The resolved key.
 */
export function resolveAwsKey(
  key: AwsKmsKeyUserConfig,
  context: KeyResolveContext,
): AwsKmsKeyConfig {
  const keyRegion =
    key.region === undefined
      ? undefined
      : resolveIdentifier(key.region, context.resolveVariable, `${context.path}.region`);
  const keyId = resolveIdentifier(
    key.keyId,
    context.resolveVariable,
    `${context.path}.keyId`,
    async (value) => {
      const parsed = parseAwsKeyId(value);
      if (parsed === undefined) {
        return catalogMessage(ERRORS.awsKeyIdReason, {});
      }
      if (parsed.region === undefined || keyRegion === undefined) {
        return undefined;
      }
      const configured = await keyRegion.get();
      // An empty `region` from a configuration variable is unset, so it cannot conflict.
      return configured !== "" && configured !== parsed.region
        ? catalogMessage(ERRORS.awsRegionConflictReason, { region: keyRegion.display })
        : undefined;
    },
  );
  const arnRegion = typeof key.keyId === "string" ? parseAwsKeyId(key.keyId)?.region : undefined;
  const defaultRegion = context.defaults.aws.region;
  const region =
    arnRegion !== undefined
      ? resolveIdentifier(arnRegion, context.resolveVariable, `${context.path}.keyId`)
      : keyRegion === undefined
        ? defaultRegion
        : typeof key.region === "string" || defaultRegion === undefined
          ? keyRegion
          : firstSetIdentifier([keyRegion, defaultRegion]);
  const profile =
    key.profile === undefined
      ? undefined
      : resolveIdentifier(key.profile, context.resolveVariable, `${context.path}.profile`);
  return {
    provider: "aws",
    ...resolveCommonKeyConfig(key, context, `aws:${keyId.display}`),
    keyId,
    ...(region === undefined ? {} : { region }),
    ...(profile === undefined ? {} : { profile }),
    ...(key.endpoint === undefined ? {} : { endpoint: key.endpoint }),
  };
}
