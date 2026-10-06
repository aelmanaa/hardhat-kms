// KeySign rows of AZKVAuditLogs, as the Log Analytics query API returned them for the test vault
// on 2026-10-02, with every tenant, object, application and assignment id, email address, IP
// address, vault and key replaced by a placeholder. Dynamic columns (Identity) come as JSON text.
import { COLUMNS } from "../../src/internal/history.ts";

export const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
export const VAULT_HOST = "example-vault.vault.azure.net";
export const KEY_NAME = "deployer";
export const KEY_URL: string = `https://${VAULT_HOST}/keys/${KEY_NAME}`;
export const VERSION_1 = "0123456789abcdef0123456789abcdef";
export const VERSION_2 = "fedcba9876543210fedcba9876543210";
export const USER = "live.com#signer@example.com";
export const USER_OBJECT_ID = "00000000-0000-4000-8000-000000000001";
export const CLI_APP_ID = "00000000-0000-4000-8000-000000000002";
export const SP_APP_ID = "00000000-0000-4000-8000-000000000003";
export const SP_OBJECT_ID = "00000000-0000-4000-8000-000000000004";
export const ASSIGNMENT_ID = "0123456789abcdef0123456789abcd01";
export const REQUEST_ID = "00000000-0000-4000-8000-0000000000a1";
export const PLUGIN_USER_AGENT =
  "hardhat-kms/0.0.0 azsdk-js-keyvault-keys/4.10.2 azsdk-js-keyvault-keys/4.10.2 azsdk-js-client azsdk-js-api azsdk-js-keyvault-keys/4.10.2 core-rest-pipeline/1.25.0 Node/0.0.0 (Linux 0.0.0; x64)";

type Row = Record<(typeof COLUMNS)[number], unknown>;

/** The token claims of `az login` with a Microsoft account that has no `upn` claim. */
const userIdentity = JSON.stringify({
  claim: {
    oid: USER_OBJECT_ID,
    appid: CLI_APP_ID,
    scp: "user_impersonation",
    appidacr: "0",
    iss: "https://sts.windows.net/00000000-0000-4000-8000-0000000000ff/",
    xms_az_nwperimid: [],
    idtyp: "user",
    ipaddr: "2001:db8::1",
    unique_name: USER,
    amr: "pwd",
  },
});

/** A KeySign the plugin made: a 200 with the plugin's user agent. */
export const PLUGIN_SIGN: Row = {
  TimeGenerated: "2026-10-02T09:06:13.8719275Z",
  OperationName: "KeySign",
  ResultType: "Success",
  ResultSignature: "OK",
  ResultDescription: "",
  HttpStatusCode: 200,
  CorrelationId: REQUEST_ID,
  CallerIpAddress: "203.0.113.7",
  ClientInfo: PLUGIN_USER_AGENT,
  Identity: userIdentity,
  Id: `${KEY_URL}/${VERSION_1}`,
  RequestUri: `https://${VAULT_HOST}:8443/keys/${KEY_NAME}/${VERSION_1}/sign?api-version=2025-07-01`,
  Algorithm: "ES256K",
  DurationMs: 333,
  OperationVersion: "2025-07-01",
  IsRbacAuthorized: true,
  IsAccessPolicyMatch: null,
  AppliedAssignmentId: ASSIGNMENT_ID,
  Tlsversion: "TLS1_3",
  SubnetId: "",
};

/**
 * A KeySign Key Vault refused: an algorithm the key's curve does not take. Key Vault logs it with
 * ResultType "Success" and the HTTP status 400; the description names the key URL.
 */
export const FAILED_SIGN: Row = {
  ...PLUGIN_SIGN,
  TimeGenerated: "2026-10-02T10:06:22.3625421Z",
  ResultSignature: "Bad Request",
  ResultDescription: `Key and signing algorithm are incompatible. Key ${KEY_URL}/${VERSION_1} uses curve 'P-256K', and algorithm 'ES256' can only be used with curve 'P-256'.`,
  HttpStatusCode: 400,
  CorrelationId: "00000000-0000-4000-8000-0000000000a2",
  ClientInfo: "azsdk-js-keyvault-keys/4.10.2 core-rest-pipeline/1.25.0 Node/0.0.0",
  Algorithm: "",
  DurationMs: 160,
};

/** A KeySign by a service principal, on another version, from outside the plugin. */
export const SERVICE_PRINCIPAL_SIGN: Row = {
  ...PLUGIN_SIGN,
  TimeGenerated: "2026-10-02T08:00:00.1234567Z",
  CorrelationId: "00000000-0000-4000-8000-0000000000a3",
  CallerIpAddress: "198.51.100.20",
  ClientInfo: "azsdk-python-keyvault-keys/4.9.0 Python/3.12.1",
  Identity: JSON.stringify({ claim: { oid: SP_OBJECT_ID, appid: SP_APP_ID, idtyp: "app" } }),
  Id: `${KEY_URL}/${VERSION_2}`,
  RequestUri: `https://${VAULT_HOST}:8444/keys/${KEY_NAME}/${VERSION_2}/sign?api-version=2025-07-01`,
};

/** The types the query API gives the projected columns. */
const TYPES: Record<string, string> = {
  TimeGenerated: "datetime",
  HttpStatusCode: "int",
  DurationMs: "int",
  Identity: "dynamic",
  IsRbacAuthorized: "bool",
  IsAccessPolicyMatch: "bool",
};

/**
 * A query API answer with these rows, in the order of {@link COLUMNS}.
 *
 * @param rows - The rows.
 * @returns The answer's JSON body.
 */
export function queryBody(rows: readonly Row[]): {
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string }>;
    rows: unknown[][];
  }>;
} {
  return {
    tables: [
      {
        name: "PrimaryResult",
        columns: COLUMNS.map((name) => ({ name, type: TYPES[name] ?? "string" })),
        rows: rows.map((row) => COLUMNS.map((name) => row[name])),
      },
    ],
  };
}

/** The 400 answer to a query on a table the workspace does not have, as Log Analytics sends it. */
export const NO_TABLE_ERROR = {
  error: {
    message: "The request had some invalid properties",
    code: "BadArgumentError",
    correlationId: "00000000-0000-4000-8000-0000000000b1",
    innererror: {
      code: "SemanticError",
      message: "A semantic error occurred.",
      innererror: {
        code: "SEM0100",
        message:
          "'where' operator: Failed to resolve table or column expression named 'AZKVAuditLogs'",
      },
    },
  },
};

/** The 404 answer for a workspace id no workspace has. */
export const WORKSPACE_NOT_FOUND_ERROR = {
  error: {
    message: "The workspace could not be found",
    code: "WorkspaceNotFoundError",
    correlationId: "00000000-0000-4000-8000-0000000000b2",
  },
};
