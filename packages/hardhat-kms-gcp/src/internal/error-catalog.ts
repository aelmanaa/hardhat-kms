import type { ErrorEntry } from "hardhat-kms/provider-utils";

/*
 * Every error hardhat-kms-gcp builds, with its cause and fix. Build errors only from these
 * entries, with catalogError, catalogMessage or internalError from hardhat-kms/provider-utils;
 * `pnpm run docs:check` fails on a throw that bypasses them. `pnpm run docs:errors` writes
 * docs/user/reference/errors.md from this file.
 */

/** The hardhat-kms-gcp error catalogue. */
export const ERRORS = {
  responseVersion: {
    id: "gcp.response.key-version",
    kind: "error",
    group: "Responses",
    template: "the response is for another key version than the one requested",
    cause:
      "Cloud KMS answered for another key version than the one requested. The adapter does not retry this.",
    fix: "Run again; if it repeats, report it.",
  },
  noPublicKey: {
    id: "gcp.response.no-public-key",
    kind: "error",
    group: "Responses",
    template: "the response has no public key",
    cause: "The `getPublicKey` answer has no PEM public key.",
    fix: "Run again; if it repeats, report it.",
  },
  noSignature: {
    id: "gcp.response.no-signature",
    kind: "error",
    group: "Responses",
    template: "the response has no signature",
    cause: "The `asymmetricSign` answer has no signature.",
    fix: "Run again; if it repeats, report it.",
  },
  algorithm: {
    id: "gcp.key.algorithm",
    kind: "error",
    group: "Keys",
    template:
      "the key version's algorithm is {algorithm}, not EC_SIGN_SECP256K1_SHA256 (secp256k1). Create the key with --purpose asymmetric-signing --default-algorithm ec-sign-secp256k1-sha256 --protection-level hsm",
    cause: "The key version is not a secp256k1 signing key.",
    fix: "A key's algorithm cannot be changed. Create a new key with the command the message gives, and point the config at it.",
  },
  lookupUnfinished: {
    id: "gcp.sign.lookup-unfinished",
    kind: "error",
    group: "Signing",
    template: "the key lookup did not finish, so the key version's algorithm is not checked",
    cause:
      "The `getPublicKey` call that checks the key version's algorithm was abandoned when its time ran out. The adapter never signs before that check.",
    fix: "Run again. If it repeats, check the network, or raise `timeoutMs`.",
  },
  checksumExhausted: {
    id: "gcp.retry.checksum",
    kind: "error",
    group: "Retries",
    template:
      "{reason}, after {attempts} attempts. Data is being corrupted between this machine and Google Cloud KMS",
    cause:
      "A CRC32C checksum failed on every attempt. The reason is one of the checksum reasons below.",
    fix: "Check proxies or other software that rewrites HTTPS traffic between this machine and Cloud KMS.",
  },
  unavailableExhausted: {
    id: "gcp.retry.unavailable",
    kind: "error",
    group: "Retries",
    template:
      "{reason}, after {attempts} attempts. Check the network connection, DNS and any proxy",
    cause:
      "Cloud KMS could not be reached, or answered UNAVAILABLE, on every attempt. The reason is `gcp.reason.unreachable` or `gcp.reason.unavailable`.",
    fix: "Check the network, DNS and any `HTTPS_PROXY`. For UNAVAILABLE without a network code, try again later.",
  },
  abandoned: {
    id: "gcp.retry.abandoned",
    kind: "error",
    group: "Retries",
    template: "{reason}",
    cause:
      "A call failed in a way a retry could fix, but its time had run out, so it was not repeated. The message is one of the reasons below.",
    fix: "Run again, or raise `timeoutMs`.",
  },
  pemChecksum: {
    id: "gcp.reason.pem-checksum",
    kind: "reason",
    group: "Retries",
    template: "the public key does not match its checksum (pemCrc32c)",
    cause: "The public key was corrupted on its way from Cloud KMS.",
    fix: "See `gcp.retry.checksum`.",
  },
  digestNotConfirmed: {
    id: "gcp.reason.digest-not-confirmed",
    kind: "reason",
    group: "Retries",
    template: "Google Cloud KMS did not confirm the digest's checksum (verifiedDigestCrc32c)",
    cause:
      "The checksum sent with the digest did not reach Cloud KMS. The adapter never signs on without it.",
    fix: "See `gcp.retry.checksum`.",
  },
  signatureChecksum: {
    id: "gcp.reason.signature-checksum",
    kind: "reason",
    group: "Retries",
    template: "the signature does not match its checksum (signatureCrc32c)",
    cause: "The signature was corrupted on its way from Cloud KMS.",
    fix: "See `gcp.retry.checksum`.",
  },
  digestChecksumRefused: {
    id: "gcp.reason.digest-checksum-refused",
    kind: "reason",
    group: "Retries",
    template: "Google Cloud KMS refused the digest's checksum (digestCrc32c, INVALID_ARGUMENT)",
    cause: "The digest was corrupted on its way to Cloud KMS, which refused it.",
    fix: "See `gcp.retry.checksum`.",
  },
  unavailable: {
    id: "gcp.reason.unavailable",
    kind: "reason",
    group: "Retries",
    template: "Google Cloud KMS is unavailable (UNAVAILABLE)",
    cause: "Cloud KMS answered that it is unavailable.",
    fix: "Try again later.",
  },
  unreachable: {
    id: "gcp.reason.unreachable",
    kind: "reason",
    group: "Retries",
    template: "could not reach Google Cloud KMS ({code})",
    cause:
      "The request never reached Cloud KMS. The code says why: `ENOTFOUND` or `EAI_AGAIN` for DNS, `ECONNREFUSED` or `ECONNRESET` for the connection.",
    fix: "Check the network, DNS and any `HTTPS_PROXY`.",
  },
  notFound: {
    id: "gcp.status.not-found",
    kind: "error",
    group: "Google Cloud KMS answers",
    template:
      "the key version was not found (NOT_FOUND). Check the project, location, key ring, key and version",
    cause:
      "The project, location, key ring, key or version does not exist, or the caller cannot see it.",
    fix: "Check `keyVersionName` or its parts.",
  },
  permissionDenied: {
    id: "gcp.status.permission-denied",
    kind: "error",
    group: "Google Cloud KMS answers",
    template:
      "permission denied (PERMISSION_DENIED). The caller needs cloudkms.cryptoKeyVersions.viewPublicKey and cloudkms.cryptoKeyVersions.useToSign on the key, for example through roles/cloudkms.signer and roles/cloudkms.publicKeyViewer",
    cause: "The identity lacks `viewPublicKey` or `useToSign` on this key.",
    fix: "Grant the roles the message names on the key, as in the setup guide.",
  },
  failedPrecondition: {
    id: "gcp.status.failed-precondition",
    kind: "error",
    group: "Google Cloud KMS answers",
    template:
      "the key version cannot be used (FAILED_PRECONDITION). It may be disabled, destroyed or scheduled for destruction; enable it or configure another version",
    cause: "The key version is disabled, scheduled for destruction or destroyed.",
    fix: "Enable it with `gcloud kms keys versions enable`, restore it first with `gcloud kms keys versions restore`, or configure another version.",
  },
  unauthenticated: {
    id: "gcp.status.unauthenticated",
    kind: "error",
    group: "Google Cloud KMS answers",
    template:
      "the Google Cloud credentials were refused (UNAUTHENTICATED). Run `gcloud auth application-default login` again, or check GOOGLE_APPLICATION_CREDENTIALS",
    cause: "The credentials expired or were revoked.",
    fix: "Run `gcloud auth application-default login` again, or check the file `GOOGLE_APPLICATION_CREDENTIALS` names.",
  },
  resourceExhausted: {
    id: "gcp.status.resource-exhausted",
    kind: "error",
    group: "Google Cloud KMS answers",
    template:
      "Google Cloud KMS is throttling requests (RESOURCE_EXHAUSTED). Try again later, or raise the project's Cloud KMS quota",
    cause: "The project hit its Cloud KMS quota.",
    fix: "Try again later, or ask for a higher quota.",
  },
  deadlineExceeded: {
    id: "gcp.status.deadline-exceeded",
    kind: "error",
    group: "Google Cloud KMS answers",
    template: "Google Cloud KMS did not answer in time (DEADLINE_EXCEEDED)",
    cause: "The request reached its deadline, the key's `timeoutMs`, as the SDK reports it.",
    fix: "Check the network, or raise `timeoutMs`.",
  },
  callFailed: {
    id: "gcp.status.other",
    kind: "error",
    group: "Google Cloud KMS answers",
    template: "the Google Cloud KMS call failed ({status})",
    cause:
      "Cloud KMS answered with another gRPC status. Only the status name is shown, since the server's message names the project and the key.",
    fix: "Look the status up in the Cloud KMS documentation, and run with `DEBUG=hardhat:kms:*` to see the call.",
  },
  noCredentials: {
    id: "gcp.connect.no-credentials",
    kind: "error",
    group: "Connecting",
    template:
      "no Google Cloud credentials found. Run `gcloud auth application-default login`, or set GOOGLE_APPLICATION_CREDENTIALS",
    cause: "google-auth-library found no Application Default Credentials.",
    fix: "Run `gcloud auth application-default login`, or set `GOOGLE_APPLICATION_CREDENTIALS` to a credentials file.",
  },
  noPackageVersion: {
    id: "gcp.internal.no-package-version",
    kind: "internal",
    group: "Internal",
    template: "{packageName}/package.json has no version",
    cause:
      "The installed hardhat-kms-gcp has no `version` in its package.json, so the install is broken.",
    fix: "Reinstall the dependencies. If it repeats, open an issue at https://github.com/aelmanaa/hardhat-kms/issues.",
  },
} as const;

/** Every entry, checked against the entry type. */
export const ENTRIES: readonly ErrorEntry[] = Object.values(ERRORS);
