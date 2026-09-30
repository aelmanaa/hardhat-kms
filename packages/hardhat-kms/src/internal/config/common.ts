import { sensitiveStringSchema } from "@nomicfoundation/hardhat-zod-utils";
import { z } from "zod";

import { InvalidAddressError, toChecksumAddress } from "../crypto/address.ts";

/** Largest delay Node's timers accept; larger values fire after 1 ms. */
const MAX_TIMEOUT_MS: number = 2 ** 31 - 1;

/** Default time budget for each KMS call. */
export const DEFAULT_TIMEOUT_MS: number = 30_000;

/** A timeout in milliseconds that Node can schedule. */
export const timeoutSchema: z.ZodNumber = z
  .number({ invalid_type_error: "Expected a number of milliseconds" })
  .int("Expected an integer number of milliseconds")
  .min(1, "Expected at least 1 ms")
  .max(MAX_TIMEOUT_MS, `Expected at most ${MAX_TIMEOUT_MS} ms`);

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
      message:
        "Expected a 0x-prefixed 20-byte address, all lowercase, all uppercase or with a valid EIP-55 checksum",
    });
  }
});

/** A value that can be a literal string or a configuration variable. */
export const identifierSchema: typeof sensitiveStringSchema = sensitiveStringSchema;

/** Fields every key accepts, whatever its provider. */
export const commonKeyFields: {
  address: z.ZodOptional<typeof addressSchema>;
  timeoutMs: z.ZodOptional<z.ZodNumber>;
  approvalTimeoutMs: z.ZodOptional<z.ZodNumber>;
} = {
  address: addressSchema.optional(),
  timeoutMs: timeoutSchema.optional(),
  approvalTimeoutMs: timeoutSchema.optional(),
};

/** A non-empty string without surrounding whitespace. */
export const nonEmptyString: z.ZodEffects<z.ZodString> = z
  .string()
  .min(1, "Expected a non-empty string")
  .refine((value) => value.trim() === value, "Unexpected leading or trailing whitespace");
