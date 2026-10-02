import { parseAwsKeyId } from "../providers/aws/key-id.ts";
import { parseAzureKeyId } from "../providers/azure/key-id.ts";

/** Values shorter than this are never replaced, so that masking cannot garble ordinary text. */
const MIN_HIDDEN_LENGTH = 8;

const AWS_KEY_SEGMENT = /:((?:key|alias)\/[^:]+)$/;
const GCP_KEY_NAME =
  /^(.*projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+)\/cryptoKeyVersions\/[^/]+$/;

/**
 * The parts of a key identifier that identify the key on their own: an AWS key id or alias name
 * from an ARN, an Azure vault host and versionless key URL, and a Google Cloud key name without
 * its version. Other values give nothing.
 *
 * @param value - A key identifier, such as a key ARN, key URL or key version name.
 * @returns The parts, without the value itself.
 */
function derivedParts(value: string): string[] {
  const parts: string[] = [];
  const aws = parseAwsKeyId(value);
  if (aws?.kind === "keyArn" || aws?.kind === "aliasArn") {
    const segment = AWS_KEY_SEGMENT.exec(value)?.[1];
    if (segment !== undefined) {
      parts.push(segment);
      if (aws.kind === "keyArn") {
        parts.push(segment.slice("key/".length));
      }
    }
  }
  const azure = parseAzureKeyId(value);
  if (azure !== undefined) {
    parts.push(new URL(azure.vaultUrl).host, `${azure.vaultUrl}/keys/${azure.keyName}`);
  }
  const gcp = GCP_KEY_NAME.exec(value)?.[1];
  if (gcp !== undefined) {
    parts.push(gcp);
  }
  return parts;
}

/**
 * The values to hide: each given value and the parts that identify the key on their own, long
 * enough to mask safely, each once whatever its case, longest first.
 *
 * @param values - Key identifiers and other values to hide.
 * @returns The values to pass to {@link masker}.
 */
export function hiddenSet(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const hidden: string[] = [];
  for (const value of values.flatMap((item) =>
    item === null || item === undefined ? [] : [item, ...derivedParts(item)],
  )) {
    const folded = value.toLowerCase();
    if (value.length >= MIN_HIDDEN_LENGTH && !seen.has(folded)) {
      seen.add(folded);
      hidden.push(value);
    }
  }
  return hidden.toSorted((a, b) => b.length - a.length);
}

/**
 * Builds a function that replaces each hidden value in a text, in any case, with the key's
 * display id.
 *
 * @param hidden - The values to hide, from {@link hiddenSet}.
 * @param displayId - What to show instead.
 * @returns The masking function.
 */
export function masker(hidden: readonly string[], displayId: string): (text: string) => string {
  if (hidden.length === 0) {
    return (text) => text;
  }
  // Longest first, so a key ARN is replaced whole before its key id.
  const pattern = new RegExp(
    hidden.map((value) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "gi",
  );
  return (text) => text.replace(pattern, () => displayId);
}
