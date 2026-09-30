import { conditionalUnionType } from "@nomicfoundation/hardhat-zod-utils";
import { z } from "zod";

import { BUILTIN_PROVIDER_CONFIGS } from "../providers/builtin-config.ts";
import { commonKeyFields, nonEmptyString, timeoutSchema } from "./common.ts";

/** Key names are used on the command line, so they are kept simple. */
const KEY_NAME_PATTERN: RegExp = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const isObject = (data: unknown): data is Record<string, unknown> =>
  typeof data === "object" && data !== null && !Array.isArray(data);

/** A third-party provider's key: only the shared fields are checked here; the provider checks the rest. */
const externalKeySchema = z.object({ provider: nonEmptyString, ...commonKeyFields }).passthrough();

/** A key of any provider, dispatched on its `provider` field. */
const keySchema: z.ZodTypeAny = conditionalUnionType(
  [
    ...Object.entries(BUILTIN_PROVIDER_CONFIGS).map(
      ([id, provider]) =>
        [(data: unknown) => isObject(data) && data.provider === id, provider.schema] as [
          (data: unknown) => boolean,
          z.ZodTypeAny,
        ],
    ),
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
    keys: z.record(keySchema).optional(),
    defaults: z
      .object({
        aws: z.object({ region: nonEmptyString.optional() }).strict().optional(),
        timeoutMs: timeoutSchema.optional(),
        approvalTimeoutMs: timeoutSchema.optional(),
      })
      .strict()
      .optional(),
    allowCrossChainTypedData: z.boolean().optional(),
    simulatedBalance: z.bigint().nonnegative().optional(),
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
    for (const name of Object.keys(keys)) {
      if (!KEY_NAME_PATTERN.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["kms", "keys", name],
          message: "Key names start with a letter and use at most 64 letters, digits, `_` or `-`",
        });
      }
    }
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
