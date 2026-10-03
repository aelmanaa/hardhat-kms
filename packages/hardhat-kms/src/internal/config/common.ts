import {
  conditionalUnionType,
  configurationVariableSchema,
  sensitiveStringSchema,
} from "@nomicfoundation/hardhat-zod-utils";
import { z } from "zod";

import { InvalidAddressError, toChecksumAddress } from "../crypto/address.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogMessage } from "../errors.ts";

/** Largest delay Node's timers accept; larger values fire after 1 ms. */
const MAX_TIMEOUT_MS: number = 2 ** 31 - 1;

/** Default time budget for each KMS call. */
export const DEFAULT_TIMEOUT_MS: number = 30_000;

/** A timeout in milliseconds that Node can schedule. */
export const timeoutSchema: z.ZodNumber = z
  .number({ invalid_type_error: catalogMessage(ERRORS.timeoutType, {}) })
  .int(catalogMessage(ERRORS.timeoutInteger, {}))
  .min(1, catalogMessage(ERRORS.timeoutMin, {}))
  .max(MAX_TIMEOUT_MS, catalogMessage(ERRORS.timeoutMax, {}));

/** An address pin: a valid address whose mixed-case form, if used, has a correct EIP-55 checksum. */
export const addressSchema: z.ZodEffects<z.ZodString> = z.string().superRefine((value, ctx) => {
  try {
    toChecksumAddress(value);
  } catch (error) {
    if (!(error instanceof InvalidAddressError)) {
      throw error;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: catalogMessage(ERRORS.addressPin, {}),
    });
  }
});

/** A value that can be a literal string or a configuration variable. */
export const identifierSchema: typeof sensitiveStringSchema = sensitiveStringSchema;

/** Fields every key accepts, whatever its provider. */
export const commonKeyFields: {
  address: z.ZodOptional<typeof addressSchema>;
  timeoutMs: z.ZodOptional<z.ZodNumber>;
} = {
  address: addressSchema.optional(),
  timeoutMs: timeoutSchema.optional(),
};

/** A non-empty string without surrounding whitespace. */
export const nonEmptyString: z.ZodEffects<z.ZodString> = z
  .string()
  .min(1, catalogMessage(ERRORS.nonEmptyString, {}))
  .refine((value) => value.trim() === value, catalogMessage(ERRORS.surroundingWhitespace, {}));

/**
 * A setting that can be a literal string or a configuration variable, such as an AWS key's
 * `region` or `profile`. A literal must be a {@link nonEmptyString}; a variable's value is read when
 * the key is first used, and an empty value means the setting is unset.
 */
export const settingSchema: z.ZodTypeAny = conditionalUnionType(
  [
    [(data) => typeof data === "string", nonEmptyString],
    [
      (data) => typeof data === "object" && data !== null && !Array.isArray(data),
      configurationVariableSchema,
    ],
  ],
  catalogMessage(ERRORS.settingType, {}),
);
