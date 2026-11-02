/**
 * Helpers for provider plugins: the first-party provider packages build on them, and third-party
 * providers may too.
 *
 * @experimental This module may change in a minor release, before and after 1.0.
 * @module hardhat-kms/provider-utils
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
  catalogWarning,
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
// For history readers, first-party or not: the errors kms history expects when a log cannot be read.
export { auditLogAccessDenied, auditLogThrottled } from "./internal/history/errors.ts";
// For provider plugins: a logger under `hardhat:kms:<provider id>` that prints plain values only.
// The core's own namespaces are refused.
export { kmsDebug, type DebugValue, type KmsDebugLogger } from "./internal/debug.ts";
// For first-party packages whose tasks name a key as the core's `kms` tasks do, such as
// @hardhat-kms/safe: the key's address, checked against its pin, without printing it.
export { kmsKeyAddress } from "./internal/tasks/keys.ts";
// For first-party packages whose tasks ask a person before a key signs (decisions 0021 and 0023).
export { confirm, isYes, processTerminal, type Terminal } from "./internal/tasks/confirm.ts";
