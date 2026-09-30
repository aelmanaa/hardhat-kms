/** The components of a Google Cloud KMS key version resource name. */
export interface GcpKeyVersionComponents {
  projectId: string;
  location: string;
  keyRing: string;
  keyName: string;
  keyVersion: string;
}

const SEGMENT = String.raw`[A-Za-z0-9_.:-]+`;
const NAME_RE = new RegExp(
  `^projects/(${SEGMENT})/locations/(${SEGMENT})/keyRings/(${SEGMENT})/cryptoKeys/(${SEGMENT})/cryptoKeyVersions/(\\d+)$`,
);

/**
 * Parses a key version resource name.
 *
 * @param value - `projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>/cryptoKeyVersions/<v>`.
 * @returns Its components, or `undefined` if it is not a key version name.
 */
export function parseGcpKeyVersionName(value: string): GcpKeyVersionComponents | undefined {
  const match = NAME_RE.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, projectId = "", location = "", keyRing = "", keyName = "", keyVersion = ""] = match;
  return { projectId, location, keyRing, keyName, keyVersion };
}

/**
 * Builds a key version resource name from its components.
 *
 * @param components - The components.
 * @returns The resource name.
 */
export function gcpKeyVersionName(components: GcpKeyVersionComponents): string {
  const { projectId, location, keyRing, keyName, keyVersion } = components;
  return `projects/${projectId}/locations/${location}/keyRings/${keyRing}/cryptoKeys/${keyName}/cryptoKeyVersions/${keyVersion}`;
}

/** Checks one component: no slashes, not empty. */
export function isGcpSegment(value: string): boolean {
  return new RegExp(`^${SEGMENT}$`).test(value);
}

/** Checks a key version number. */
export function isGcpKeyVersion(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}
