// Redaction for the live tests' failures. Errors from the cloud SDKs, the plugin and viem can name
// the key, the vault, the project, the caller's account and the RPC URL; none of these may reach the
// test output. Nor may signed transactions and authorizations: one signed on the fork carries
// Sepolia's chain id and the account's real nonce, so anyone who copied it could broadcast it.

/** The environment variables that name the keys and the RPC. */
const KEY_VARIABLES = [
  "HARDHAT_KMS_LIVE_AWS_KEY_ID",
  "HARDHAT_KMS_LIVE_GCP_KEY",
  "HARDHAT_KMS_LIVE_AZURE_KEY_ID",
  "HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL",
] as const;

/** Parts of an identifier that name no resource and stay readable. */
const RESERVED = new Set([
  "arn",
  "aws",
  "kms",
  "key",
  "alias",
  "https:",
  "projects",
  "locations",
  "keyRings",
  "cryptoKeys",
  "cryptoKeyVersions",
  "keys",
  "vault.azure.net",
  "managedhsm.azure.net",
]);

/**
 * The literal values to remove: each variable's value and its parts. The AWS key id is split on
 * `:` and `/` (alias name, key UUID, ARN fields), the GCP key version name on `/` (project,
 * location, key ring, key), and the Azure key URL on `/` and on its host (vault name, key name,
 * version).
 *
 * @param env - The environment, normally `process.env`.
 * @returns The values, longest first, so a value is never left half-replaced by one it contains.
 */
export function secretsOf(env: Readonly<Record<string, string | undefined>>): string[] {
  const value = (name: (typeof KEY_VARIABLES)[number]): string => env[name]?.trim() ?? "";
  const aws = value("HARDHAT_KMS_LIVE_AWS_KEY_ID");
  const gcp = value("HARDHAT_KMS_LIVE_GCP_KEY");
  const azure = value("HARDHAT_KMS_LIVE_AZURE_KEY_ID");
  const azureHost = /^https:\/\/([^/]+)/.exec(azure)?.[1] ?? "";
  const values = [
    aws,
    ...aws.split(/[:/]/),
    gcp,
    ...gcp.split("/"),
    azure,
    azureHost,
    azureHost.split(".")[0] ?? "",
    ...azure.split("/"),
    value("HARDHAT_KMS_LIVE_SEPOLIA_RPC_URL"),
  ];
  return [...new Set(values)]
    .filter((item) => item.length >= 3 && !RESERVED.has(item))
    .toSorted((a, b) => b.length - a.length);
}

/**
 * Removes key ids, ARNs, account ids, resource names, project numbers and URLs from a message.
 *
 * @param message - The text to clean.
 * @param env - The environment holding the key variables.
 * @returns The message with every identifier replaced by a placeholder.
 */
export function redact(message: string, env: Readonly<Record<string, string | undefined>>): string {
  let text = message;
  for (const secret of secretsOf(env)) {
    text = text.replaceAll(secret, "<redacted>");
  }
  return (
    text
      // Signed data: raw transactions, 65-byte signatures and anything longer, with or without
      // `0x` (transaction hashes are 32 bytes and stay). Then the r and s of a signature or
      // authorization written as fields, and 32-byte values in an argument list such as viem's
      // `args: (message, v, r, s)`, where they are signature parts rather than hashes.
      .replaceAll(/(?:0x)?[0-9a-f]{130,}/gi, "<signed data>")
      .replaceAll(
        /(["']?\b[rs]["']?\s*[:=]\s*["']?)(?:0x[0-9a-f]+|[0-9a-f]{32,64}\b)/gi,
        "$1<signature>",
      )
      .replaceAll(
        /(\bargs:\s*|\b[a-z_]\w*)\(([^()]*)\)/gi,
        (_match, head: string, list: string) =>
          `${head}(${list.replaceAll(/\b(?:0x)?[0-9a-f]{64}\b/gi, "<signature>")})`,
      )
      // Patterns for identifiers that are not in the variables: other ARNs and aliases, the caller's account
      // and principal ids, the project number GCP reports, and any URL.
      .replaceAll(/arn:aws[^\s'"]*/g, "<arn>")
      .replaceAll(/\balias\/[\w/-]+/g, "alias/<redacted>")
      .replaceAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
      .replaceAll(/\b\d{12}\b/g, "<account>")
      .replaceAll(/\b[0-9a-f]{32}\b/gi, "<version>")
      .replaceAll(/(key vault ')[^']*'/gi, "$1<redacted>'")
      .replaceAll(/(projects?[\s/:='"#]*)\d+/gi, "$1<project>")
      .replaceAll(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
      .replaceAll(/\S*\/v2\/\S*/g, "<url>")
  );
}
