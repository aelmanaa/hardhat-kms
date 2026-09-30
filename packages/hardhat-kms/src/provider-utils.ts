/**
 * Helpers for provider plugins: the first-party provider packages build on them, and third-party
 * providers may too.
 *
 * @experimental This module may change before 1.0.
 */

export { publicKeyFromSpkiDer, InvalidPublicKeyError } from "./internal/crypto/public-key.ts";
export { kmsError, type ErrorDetails } from "./internal/errors.ts";
export { parseAwsKeyId, type ParsedAwsKeyId } from "./internal/providers/aws/key-id.ts";
