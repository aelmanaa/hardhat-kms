/** A parsed AWS KMS key reference. */
export interface ParsedAwsKeyId {
  kind: "keyId" | "keyArn" | "aliasName" | "aliasArn";
  /** The region, for ARNs. */
  region?: string;
}

const KEY_ID = String.raw`(?:mrk-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`;
const ALIAS = String.raw`alias/[A-Za-z0-9/_-]{1,250}`;
const KEY_ID_RE = new RegExp(`^${KEY_ID}$`);
const ALIAS_RE = new RegExp(`^${ALIAS}$`);
const ARN_RE = new RegExp(
  String.raw`^arn:aws(?:-[a-z]+)*:kms:([a-z0-9-]+):\d{12}:(?:key/${KEY_ID}|(${ALIAS}))$`,
);

/**
 * Parses an AWS KMS key reference: a key id, key ARN, alias name or alias ARN.
 *
 * @param value - The reference.
 * @returns Its kind, and the region for ARNs, or `undefined` if the value is not a valid reference.
 */
export function parseAwsKeyId(value: string): ParsedAwsKeyId | undefined {
  if (KEY_ID_RE.test(value)) {
    return { kind: "keyId" };
  }
  if (ALIAS_RE.test(value)) {
    return { kind: "aliasName" };
  }
  const arn = ARN_RE.exec(value);
  if (arn?.[1] !== undefined) {
    return { kind: arn[2] === undefined ? "keyArn" : "aliasArn", region: arn[1] };
  }
  return undefined;
}
