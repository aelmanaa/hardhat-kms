/**
 * Helpers for provider plugins: the first-party provider packages build on them, and third-party
 * providers may too.
 *
 * @experimental This module may change before 1.0.
 */

export {
  publicKeyFromJwk,
  publicKeyFromSpkiDer,
  publicKeyFromSpkiPem,
  InvalidPublicKeyError,
  type EcJsonWebKey,
} from "./internal/crypto/public-key.ts";
export { crc32c } from "./internal/crypto/crc32c.ts";
// The catalogue helpers and their types are for the first-party provider packages only;
// third-party providers build their errors with kmsError.
export {
  catalogError,
  catalogMessage,
  internalError,
  kmsError,
  type ErrorDetails,
  type ErrorEntry,
  type ErrorKind,
  type TemplateParams,
  type TemplateValue,
} from "./internal/errors.ts";
export { parseAwsKeyId, type ParsedAwsKeyId } from "./internal/providers/aws/key-id.ts";
export { parseAzureKeyId, type ParsedAzureKeyId } from "./internal/providers/azure/key-id.ts";
export { checkProviderVersion } from "./internal/providers/version.ts";
