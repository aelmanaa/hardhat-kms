import { z } from "zod";

import type { TurnkeyKmsKeyConfig, TurnkeyKmsKeyUserConfig } from "../../../types.ts";
import { commonKeyFields, identifierSchema, secretSchema } from "../../config/common.ts";
import { resolveIdentifier } from "../../config/identifiers.ts";
import { type KeyResolveContext, resolveCommonKeyConfig } from "../../config/key-common.ts";
import { toChecksumAddress } from "../../crypto/address.ts";
import { ERRORS } from "../../error-catalog.ts";
import { catalogMessage } from "../../errors.ts";

/** A UUID, in any case, as Turnkey writes organization ids. */
const UUID = /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

/**
 * Whether a value is a Turnkey organization id.
 *
 * @param value - The value, trimmed when it comes from a configuration variable.
 * @returns Whether it is a UUID.
 */
function isTurnkeyOrganizationId(value: string): boolean {
  return UUID.test(value);
}

/**
 * Validates a Turnkey key config. `address` is required, the API private key is a configuration
 * variable only, `transactionSigning` is `"transaction"` or `"digest"`, and unknown fields fail.
 */
export const turnkeyKeySchema: z.ZodTypeAny = z
  .object({
    provider: z.literal("turnkey"),
    organizationId: identifierSchema,
    apiPrivateKey: secretSchema,
    apiPublicKey: identifierSchema.optional(),
    transactionSigning: z.enum(["transaction", "digest"]).optional(),
    ...commonKeyFields,
  })
  .strict()
  .superRefine((key, ctx) => {
    if (typeof key.organizationId === "string" && !isTurnkeyOrganizationId(key.organizationId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["organizationId"],
        message: catalogMessage(ERRORS.turnkeyOrganizationId, {}),
      });
    }
    if (key.address === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["address"],
        message: catalogMessage(ERRORS.turnkeyAddressRequired, {}),
      });
    }
  });

const checkOrganizationId = (value: string): string | undefined =>
  isTurnkeyOrganizationId(value)
    ? undefined
    : catalogMessage(ERRORS.turnkeyOrganizationIdReason, {});

/**
 * Resolves a Turnkey key config. The display id is `turnkey:<organizationId>/<address>`, with an
 * organization id from a configuration variable shown as `<VARIABLE_NAME>`. The API keys never
 * reach it.
 *
 * @param key - The validated key config.
 * @param context - The key's name and the resolved defaults.
 * @returns The resolved key.
 */
export function resolveTurnkeyKey(
  key: TurnkeyKmsKeyUserConfig,
  context: KeyResolveContext,
): TurnkeyKmsKeyConfig {
  const address = toChecksumAddress(key.address);
  const organizationId = resolveIdentifier(
    key.organizationId,
    context.resolveVariable,
    `${context.path}.organizationId`,
    checkOrganizationId,
  );
  return {
    provider: "turnkey",
    ...resolveCommonKeyConfig(key, context, `turnkey:${organizationId.display}/${address}`),
    address,
    organizationId,
    transactionSigning: key.transactionSigning ?? "transaction",
    apiPrivateKey: resolveIdentifier(
      key.apiPrivateKey,
      context.resolveVariable,
      `${context.path}.apiPrivateKey`,
    ),
    ...(key.apiPublicKey === undefined
      ? {}
      : {
          apiPublicKey: resolveIdentifier(
            key.apiPublicKey,
            context.resolveVariable,
            `${context.path}.apiPublicKey`,
          ),
        }),
  };
}
