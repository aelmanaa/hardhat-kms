import { parseAwsKeyId } from "../providers/aws/key-id.ts";
import { parseAzureKeyId } from "../providers/azure/key-id.ts";

/** Values shorter than this are never replaced, so that masking cannot garble ordinary text. */
const MIN_HIDDEN_LENGTH = 8;

/** What a value that names something other than the key prints as. */
const HIDDEN = "<hidden>";

const AWS_KEY_SEGMENT = /:((?:key|alias)\/[^:]+)$/;
const GCP_KEY_NAME =
  /^(.*?(projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+)\/cryptoKeys\/[^/]+)\/cryptoKeyVersions\/[^/]+$/;

/**
 * A value to hide, and what it prints as: the key's display id for the key itself (a key id and
 * the parts that name the key on their own), `<hidden>` for anything else.
 */
export interface HiddenValue {
  value: string;
  kind: "key" | "other";
  /** Leading text of `value` that is kept, such as `vaults/` in `vaults/<name>`. */
  prefix?: string;
}

/** The values {@link hiddenSet} builds the set from. */
export interface HiddenSources {
  /** Key identifiers of the key being read: key ARNs, key URLs, key version names. */
  keys: ReadonlyArray<string | null | undefined>;
  /**
   * Other values that must not print: a workspace id, the values of a key's configuration
   * variable parts, scope ids, the reader's `hiddenValues` and `extraIds`.
   */
  others: ReadonlyArray<string | null | undefined>;
}

/**
 * The parts of a key identifier that name something on their own, each with what it names:
 *
 * - the key: an AWS key id and its `key/` or `alias/` segment, an Azure versionless key URL, and a
 *   Google Cloud key name without its version;
 * - something else: an Azure vault host, vault name and `vaults/<name>` resource id segment, and a
 *   Google Cloud key ring path.
 *
 * Other values give nothing.
 *
 * @param value - A key identifier, such as a key ARN, key URL or key version name.
 * @returns The parts, without the value itself.
 */
function derivedParts(value: string): HiddenValue[] {
  const parts: HiddenValue[] = [];
  const aws = parseAwsKeyId(value);
  if (aws?.kind === "keyArn" || aws?.kind === "aliasArn") {
    const segment = AWS_KEY_SEGMENT.exec(value)?.[1];
    if (segment !== undefined) {
      parts.push({ value: segment, kind: "key" });
      if (aws.kind === "keyArn") {
        parts.push({ value: segment.slice("key/".length), kind: "key" });
      }
    }
  }
  const azure = parseAzureKeyId(value);
  if (azure !== undefined) {
    const host = new URL(azure.vaultUrl).host;
    const vault = host.split(".")[0] ?? host;
    parts.push(
      { value: `${azure.vaultUrl}/keys/${azure.keyName}`, kind: "key" },
      { value: host, kind: "other" },
      { value: vault, kind: "other" },
      // A resource id segment, long enough to mask a vault name too short to mask alone.
      { value: `vaults/${vault}`, kind: "other", prefix: "vaults/" },
      { value: `managedHSMs/${vault}`, kind: "other", prefix: "managedHSMs/" },
    );
  }
  const gcp = GCP_KEY_NAME.exec(value);
  if (gcp?.[1] !== undefined && gcp[2] !== undefined) {
    parts.push({ value: gcp[1], kind: "key" }, { value: gcp[2], kind: "other" });
  }
  return parts;
}

/** A value as it may appear in a URL, a query string or escaped JSON, with its kept prefix. */
function encodedForms(entry: HiddenValue): HiddenValue[] {
  const forms: HiddenValue[] = [];
  for (const encode of [encodeURIComponent, (text: string) => text.replaceAll("/", "\\/")]) {
    const value = encode(entry.value);
    if (value !== entry.value) {
      forms.push({
        ...entry,
        value,
        ...(entry.prefix === undefined ? {} : { prefix: encode(entry.prefix) }),
      });
    }
  }
  return forms;
}

/**
 * The values to hide: each given value, the parts that name something on their own, and their
 * URL-encoded and `\/`-escaped forms, long enough to mask safely, each once whatever its case,
 * longest first. A value given both as a key and as something else is masked as the key.
 *
 * @param sources - The key's identifiers and the other values to hide.
 * @returns The values to pass to {@link masker}.
 */
export function hiddenSet(sources: HiddenSources): HiddenValue[] {
  const given = (
    values: ReadonlyArray<string | null | undefined>,
    kind: HiddenValue["kind"],
  ): HiddenValue[] =>
    values.flatMap((value) =>
      value === null || value === undefined
        ? []
        : [
            { value, kind },
            // Everything derived from a value that is not the key is not the key either.
            ...derivedParts(value).map((part) => (kind === "key" ? part : { ...part, kind })),
          ],
    );
  const seen = new Set<string>();
  const hidden: HiddenValue[] = [];
  // Keys first, so that a value given as both is masked as the key.
  for (const entry of [...given(sources.keys, "key"), ...given(sources.others, "other")]) {
    for (const form of [entry, ...encodedForms(entry)]) {
      const folded = form.value.toLowerCase();
      if (form.value.length >= MIN_HIDDEN_LENGTH && !seen.has(folded)) {
        seen.add(folded);
        hidden.push(form);
      }
    }
  }
  return hidden.toSorted((a, b) => b.value.length - a.value.length);
}

/**
 * Applies `replace` to the parts of `text` around each occurrence of `keep`, which stays as it is.
 *
 * @param text - The text.
 * @param keep - A string to leave untouched, such as the key's display id.
 * @param replace - What to do with the rest.
 * @returns The text.
 */
function outside(text: string, keep: string, replace: (part: string) => string): string {
  return keep === "" ? replace(text) : text.split(keep).map(replace).join(keep);
}

/**
 * Builds a function that replaces each hidden value in a text, in any case: a key value with the
 * key's display id, any other value with `<hidden>`. The display id itself is never rewritten, so
 * a literal key's display id stays as it is.
 *
 * @param hidden - The values to hide, from {@link hiddenSet}.
 * @param displayId - What a key value prints as.
 * @returns The masking function.
 */
export function masker(
  hidden: readonly HiddenValue[],
  displayId: string,
): (text: string) => string {
  if (hidden.length === 0) {
    return (text) => text;
  }
  const entries = new Map(hidden.map((entry) => [entry.value.toLowerCase(), entry]));
  // Longest first, so a key ARN is replaced whole before its key id.
  const pattern = new RegExp(
    hidden.map((entry) => entry.value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "gi",
  );
  return (text) =>
    outside(text, displayId, (part) =>
      part.replace(pattern, (match) => {
        const entry = entries.get(match.toLowerCase());
        const kept = match.slice(0, entry?.prefix?.length ?? 0);
        return `${kept}${entry?.kind === "key" ? displayId : HIDDEN}`;
      }),
    );
}

// The shapes of ids that a reader's error may hold although the plugin was never given them, such
// as the key ARN an alias resolved to.
const ID_SHAPES: readonly RegExp[] = [
  // ARNs: partition, service, region, account, resource.
  /\barn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:\d*:[A-Za-z0-9/_+=,.@:*-]+/gi,
  // Azure vault and Managed HSM hosts, with whatever URL path follows.
  /(?:https?:\/\/)?[A-Za-z0-9-]+\.(?:vault|managedhsm)\.(?:azure\.net|azure\.cn|usgovcloudapi\.net|microsoftazure\.de)(?:[/:][^\s"'<>,;)]*)?/gi,
  // Google Cloud resource names.
  /\bprojects\/[^/\s"'<>,;)]+(?:\/[A-Za-z]+\/[^/\s"'<>,;)]+)*/g,
  // GUIDs, such as an AWS key id, an Azure subscription or workspace id.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  // AWS account ids.
  /\b\d{12}\b/g,
];

/**
 * Builds the function that masks the text of an error a reader throws: the hidden values as
 * {@link masker} does, then anything shaped like an ARN, an Azure vault URL, a Google Cloud
 * resource name, a GUID or an AWS account id as `<hidden>`. The display id is kept as it is.
 *
 * @param hidden - The values to hide, from {@link hiddenSet}.
 * @param displayId - What a key value prints as.
 * @returns The masking function.
 */
export function errorMasker(
  hidden: readonly HiddenValue[],
  displayId: string,
): (text: string) => string {
  const mask = masker(hidden, displayId);
  return (text) =>
    outside(mask(text), displayId, (part) =>
      ID_SHAPES.reduce((masked, shape) => masked.replace(shape, HIDDEN), part),
    );
}
