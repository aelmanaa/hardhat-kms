import type { ConfigurationVariableResolver } from "hardhat/types/config";
import { z } from "zod";

import type { KmsAuditConfig, KmsAuditUserConfig } from "../../types.ts";
import { ERRORS } from "../error-catalog.ts";
import { catalogMessage } from "../errors.ts";
import { identifierSchema } from "./common.ts";
import { resolveIdentifier } from "./identifiers.ts";

/** A Log Analytics workspace id: a GUID. */
const WORKSPACE_ID = /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

/**
 * Whether a value is a Log Analytics workspace id. Readers put it in a request URL, so nothing
 * else may pass.
 *
 * @param value - The value, trimmed.
 * @returns Whether it is a GUID.
 */
export function isWorkspaceId(value: string): boolean {
  return WORKSPACE_ID.test(value);
}

/** The `kms.audit` section. A literal workspace id is checked here, a variable's when it is read. */
export const auditSchema: z.ZodTypeAny = z
  .object({
    azure: z
      .object({ workspaceId: identifierSchema.optional() })
      .strict()
      .superRefine((azure, ctx) => {
        if (typeof azure.workspaceId === "string" && !isWorkspaceId(azure.workspaceId.trim())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["workspaceId"],
            message: catalogMessage(ERRORS.azureWorkspaceId, {}),
          });
        }
      })
      .optional(),
  })
  .strict();

const checkWorkspaceId = (value: string): string | undefined =>
  isWorkspaceId(value) ? undefined : catalogMessage(ERRORS.azureWorkspaceIdReason, {});

/**
 * Resolves the `kms.audit` section. Expects a config that passed validation.
 *
 * @param audit - The validated `kms.audit` section, if any.
 * @param resolveVariable - Hardhat's configuration variable resolver.
 * @returns The resolved section; empty when nothing is set.
 */
export function resolveAuditConfig(
  audit: KmsAuditUserConfig | undefined,
  resolveVariable: ConfigurationVariableResolver,
): KmsAuditConfig {
  const workspaceId = audit?.azure?.workspaceId;
  if (workspaceId === undefined) {
    return {};
  }
  return {
    azure: {
      workspaceId: resolveIdentifier(
        workspaceId,
        resolveVariable,
        "kms.audit.azure.workspaceId",
        checkWorkspaceId,
      ),
    },
  };
}
