import { conditionalUnionType } from "@nomicfoundation/hardhat-zod-utils";
import { z } from "zod";

import { BUILTIN_PROVIDERS } from "../providers/registry.ts";
import { commonKeyFields, nonEmptyString, timeoutSchema } from "./common.ts";

/** Key names are kept simple because tasks will take them as command-line arguments. */
const KEY_NAME_PATTERN: RegExp = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const isObject = (data: unknown): data is Record<string, unknown> =>
  typeof data === "object" && data !== null && !Array.isArray(data);

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Finds the built-in provider a misspelled id most likely meant: same id in another case, or at
 * most two edits away.
 *
 * @param provider - A provider id that is not built in.
 * @returns The built-in id, or `undefined`.
 */
function builtinLookalike(provider: string): string | undefined {
  return Object.keys(BUILTIN_PROVIDERS).find(
    (id) => id === provider.toLowerCase() || editDistance(id, provider.toLowerCase()) <= 2,
  );
}

const misspelledProviderSchema = z
  .object({ provider: z.string() })
  .passthrough()
  .superRefine((key, ctx) => {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provider"],
      message: `Unknown provider "${key.provider}". Did you mean "${builtinLookalike(key.provider) ?? ""}"?`,
    });
  });

/** A third-party provider's key: only the shared fields are checked here; the provider checks the rest. */
const externalKeySchema = z.object({ provider: nonEmptyString, ...commonKeyFields }).passthrough();

/** A key of any provider, dispatched on its `provider` field. */
const keySchema: z.ZodTypeAny = conditionalUnionType(
  [
    ...Object.entries(BUILTIN_PROVIDERS).map(
      ([id, provider]) =>
        [(data: unknown) => isObject(data) && data.provider === id, provider.schema] as [
          (data: unknown) => boolean,
          z.ZodTypeAny,
        ],
    ),
    [
      (data) =>
        isObject(data) &&
        typeof data.provider === "string" &&
        builtinLookalike(data.provider) !== undefined,
      misspelledProviderSchema,
    ],
    [(data) => isObject(data) && typeof data.provider === "string", externalKeySchema],
  ],
  'Expected a key object with a `provider` field, for example { provider: "aws", keyId: "alias/deployer" }',
);

const accountSchema = conditionalUnionType(
  [
    [(data) => typeof data === "string", z.string()],
    [isObject, keySchema],
  ],
  "Expected the name of a key in `kms.keys` or a key object",
);

const kmsSchema = z
  .object({
    keys: z
      .record(
        z
          .string()
          .regex(
            KEY_NAME_PATTERN,
            "Key names start with a letter and use at most 64 letters, digits, `_` or `-`",
          ),
        keySchema,
      )
      .optional(),
    defaults: z
      .object({
        aws: z.object({ region: nonEmptyString.optional() }).strict().optional(),
        timeoutMs: timeoutSchema.optional(),
        approvalTimeoutMs: timeoutSchema.optional(),
      })
      .strict()
      .optional(),
    allowCrossChainTypedData: z.boolean().optional(),
    simulatedBalance: z
      .bigint({ invalid_type_error: "Expected a bigint amount of wei, for example 10n ** 18n" })
      .nonnegative("Expected a non-negative amount of wei")
      .optional(),
  })
  .strict();

/**
 * The parts of the Hardhat user config this plugin owns: `kms` and each network's `kmsAccounts`.
 * Other fields are left to Hardhat and other plugins. Error paths start at the config root.
 */
export const kmsUserConfigSchema: z.ZodTypeAny = z
  .object({
    kms: kmsSchema.optional(),
    networks: z
      .record(z.object({ kmsAccounts: z.array(accountSchema).optional() }).passthrough())
      .optional(),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    const keys = config.kms?.keys ?? {};
    for (const [network, networkConfig] of Object.entries(config.networks ?? {})) {
      const seen = new Set<string>();
      (networkConfig.kmsAccounts ?? []).forEach((account: unknown, index: number) => {
        if (typeof account !== "string") {
          return;
        }
        const path = ["networks", network, "kmsAccounts", index];
        if (!Object.hasOwn(keys, account)) {
          const known = Object.keys(keys);
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `Unknown key "${account}". ${known.length === 0 ? "`kms.keys` is empty." : `Known keys: ${known.join(", ")}.`}`,
          });
        } else if (seen.has(account)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `Key "${account}" is listed twice`,
          });
        }
        seen.add(account);
      });
    }
  });
