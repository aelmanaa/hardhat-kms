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

/**
 * The only configuration variable a secret accepts: a name, and no `default` and no `format`
 * other than Hardhat's own `{variable}`. A `default`, or text around `{variable}` in a `format`,
 * would put the secret in the config file. Strict, so an object that only looks like a variable
 * and carries another field is refused too.
 */
const secretVariableSchema = z
  .object({
    _type: z.literal("ConfigurationVariable"),
    name: z.string(),
    format: z.literal("{variable}").optional(),
  })
  .strict();

/**
 * A secret, such as a Turnkey key's API private key: only `configVariable(NAME)`. The error never
 * contains the value, a `default` or a `format`.
 */
export const secretSchema: z.ZodEffects<z.ZodUnknown> = z.unknown().superRefine((data, ctx) => {
  if (!secretVariableSchema.safeParse(data).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: catalogMessage(ERRORS.secretVariable, {}),
    });
  }
});

/** The keccak256 of no bytes: the code hash of an address without code. */
const EMPTY_CODE_HASH: string =
  "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

/**
 * Control, format, surrogate, private-use and unassigned characters (`\p{C}`), and the line and
 * paragraph separators (U+2028, U+2029), such as escapes, carriage returns and bidirectional
 * overrides, which could change how a terminal shows a label.
 */
const UNPRINTABLE: RegExp = /[\p{C}\p{Zl}\p{Zp}]/u;
const LABEL_MAX_LENGTH = 64;

/** A delegate's address in `allowedDelegates`, checked as an address pin is. */
const delegateAddressSchema = z.string().superRefine((value, ctx) => {
  try {
    toChecksumAddress(value);
  } catch (error) {
    if (!(error instanceof InvalidAddressError)) {
      throw error;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: catalogMessage(ERRORS.delegateAddress, {}),
    });
  }
});

const chainIdMessage = catalogMessage(ERRORS.delegateChainId, {});
const chainZeroMessage = catalogMessage(ERRORS.delegateChainZero, {});
const chainsMessage = catalogMessage(ERRORS.delegateChains, {});

/** A chain id in an entry's `chains`: a whole number from 1 to 2^53 - 1. */
const delegateChainIdSchema = z
  .number({ invalid_type_error: chainIdMessage })
  .superRefine((chain, ctx) => {
    if (chain === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: chainZeroMessage });
    } else if (!Number.isSafeInteger(chain) || chain < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: chainIdMessage });
    }
  });

/** An entry's `chains`: `"all"` or a non-empty list of chain ids. */
const delegateChainsSchema = conditionalUnionType(
  [
    [
      (data) => typeof data === "string",
      z.literal("all", { errorMap: () => ({ message: chainsMessage }) }),
    ],
    [Array.isArray, z.array(delegateChainIdSchema).min(1, chainsMessage)],
  ],
  chainsMessage,
);

/** One entry of a key's `allowedDelegates`. */
const allowedDelegateSchema = z
  .object({
    address: delegateAddressSchema,
    chains: delegateChainsSchema,
    label: z
      .string()
      .refine(
        (value) =>
          value.length >= 1 &&
          value.length <= LABEL_MAX_LENGTH &&
          value.trim() === value &&
          !UNPRINTABLE.test(value),
        catalogMessage(ERRORS.delegateLabel, {}),
      )
      .optional(),
    codeHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, catalogMessage(ERRORS.delegateCodeHash, {}))
      .refine(
        (value) => value.toLowerCase() !== EMPTY_CODE_HASH,
        catalogMessage(ERRORS.delegateCodeHashEmpty, {}),
      )
      .optional(),
  })
  .strict();

/** A key's `allowedDelegates`: a list of entries, possibly empty. */
const allowedDelegatesSchema: z.ZodTypeAny = z.array(allowedDelegateSchema, {
  invalid_type_error: catalogMessage(ERRORS.delegateList, {}),
});

/** Fields every key accepts, whatever its provider. */
export const commonKeyFields: {
  address: z.ZodOptional<typeof addressSchema>;
  timeoutMs: z.ZodOptional<z.ZodNumber>;
  allowRawDigests: z.ZodOptional<z.ZodBoolean>;
  allowedDelegates: z.ZodOptional<z.ZodTypeAny>;
} = {
  address: addressSchema.optional(),
  timeoutMs: timeoutSchema.optional(),
  allowRawDigests: z
    .boolean({ invalid_type_error: catalogMessage(ERRORS.allowRawDigestsType, {}) })
    .optional(),
  allowedDelegates: allowedDelegatesSchema.optional(),
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
