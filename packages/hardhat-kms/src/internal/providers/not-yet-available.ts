import { kmsError } from "../errors.ts";
import type { ProviderModule } from "./types.ts";

/**
 * Stands in for a provider adapter that is not written yet.
 *
 * @param provider - The provider's name.
 * @param issue - The issue that tracks the adapter.
 * @returns Never: it always rejects.
 */
export async function notYetAvailable(provider: string, issue: number): Promise<ProviderModule> {
  return await Promise.reject(
    kmsError(
      `signing with ${provider} keys is not available yet (https://github.com/aelmanaa/hardhat-kms/issues/${issue})`,
    ),
  );
}
