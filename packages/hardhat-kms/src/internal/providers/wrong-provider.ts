/**
 * Rejects a key handed to another provider's resolver. Validation dispatches on `provider`, so
 * this only guards against internal misuse.
 *
 * @param expected - The resolver's provider id.
 * @param actual - The key's provider id.
 * @returns Never: it always throws.
 */
export function wrongProvider(expected: string, actual: string): never {
  throw new Error(`Expected a "${expected}" key, got "${actual}"`);
}
