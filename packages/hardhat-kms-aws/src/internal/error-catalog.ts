import type { ErrorEntry } from "hardhat-kms/provider-utils";

/*
 * Every error @hardhat-kms/aws builds, with its cause and fix. Build errors only from these
 * entries, with catalogError, catalogMessage or internalError from hardhat-kms/provider-utils;
 * `pnpm run docs:check` fails on a throw that bypasses them. `pnpm run docs:errors` writes
 * docs/user/reference/errors.md from this file.
 */

/** The @hardhat-kms/aws error catalogue. */
export const ERRORS = {
  keySpec: {
    id: "aws.key.spec",
    kind: "error",
    group: "Keys",
    template:
      "the key spec is {keySpec}, not ECC_SECG_P256K1 (secp256k1). Create the key with --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY",
    cause: "The key is not a secp256k1 key, for example an RSA or a P-256 key.",
    fix: "A key's spec cannot be changed. Create a new key with the command the message gives, and point the config at it.",
  },
  keyUsage: {
    id: "aws.key.usage",
    kind: "error",
    group: "Keys",
    template: "the key usage is {keyUsage}, not SIGN_VERIFY",
    cause:
      "The key was created for another usage, such as `ENCRYPT_DECRYPT` or `GENERATE_VERIFY_MAC`.",
    fix: "A key's usage cannot be changed. Create a new key with `--key-usage SIGN_VERIFY`.",
  },
  signingAlgorithm: {
    id: "aws.key.signing-algorithm",
    kind: "error",
    group: "Keys",
    template: "the key does not support ECDSA_SHA_256",
    cause:
      "The `GetPublicKey` answer does not list `ECDSA_SHA_256` among the key's signing algorithms. Every `ECC_SECG_P256K1` signing key supports it, so the endpoint may not be AWS KMS.",
    fix: "Check the key's `endpoint`, if one is set. Against AWS KMS itself, report it.",
  },
  noKeyArn: {
    id: "aws.key.no-key-arn",
    kind: "error",
    group: "Keys",
    template: "the response has no key ARN",
    cause:
      "The `GetPublicKey` answer has no key ARN, which the adapter needs: it signs with the ARN, never with an alias.",
    fix: "Check the key's `endpoint`, if one is set. Against AWS KMS itself, report it.",
  },
  noPublicKey: {
    id: "aws.key.no-public-key",
    kind: "error",
    group: "Keys",
    template: "the response has no public key",
    cause: "The `GetPublicKey` answer has no public key.",
    fix: "Check the key's `endpoint`, if one is set. Against AWS KMS itself, report it.",
  },
  lookupUnfinished: {
    id: "aws.sign.lookup-unfinished",
    kind: "error",
    group: "Signing",
    template: "the key lookup did not finish, so there is no key ARN to sign with",
    cause:
      "The `GetPublicKey` call that learns the key ARN was abandoned when its time ran out. The adapter never signs without the ARN.",
    fix: "Run again. If it repeats, check the network and region, or raise `timeoutMs`.",
  },
  responseKey: {
    id: "aws.sign.response-key",
    kind: "error",
    group: "Signing",
    template: "the response is for another key than the one requested",
    cause:
      "The `Sign` answer names another key ARN than the one the adapter signed with. The signature is refused.",
    fix: "Check the key's `endpoint` and any proxy. Against AWS KMS itself, report it.",
  },
  responseAlgorithm: {
    id: "aws.sign.response-algorithm",
    kind: "error",
    group: "Signing",
    template: "the response does not use ECDSA_SHA_256",
    cause:
      "The `Sign` answer names another signing algorithm than `ECDSA_SHA_256`. The signature is refused.",
    fix: "Check the key's `endpoint` and any proxy. Against AWS KMS itself, report it.",
  },
  noSignature: {
    id: "aws.sign.no-signature",
    kind: "error",
    group: "Signing",
    template: "the response has no signature",
    cause: "The `Sign` answer has no signature.",
    fix: "Check the key's `endpoint` and any proxy. Against AWS KMS itself, report it.",
  },
  noRegion: {
    id: "aws.connect.no-region",
    kind: "error",
    group: "Connecting",
    template:
      "no AWS region is configured. Set `region` on the key, `kms.defaults.aws.region`, AWS_REGION, or a region in the AWS profile, or use a key ARN",
    cause:
      "The AWS SDK found no region for the key: the key id is not an ARN, and no region is set anywhere the SDK looks.",
    fix: "Set `region` on the key or `kms.defaults.aws.region`, set `AWS_REGION`, give the profile a region, or use a key ARN.",
  },
  noCredentials: {
    id: "aws.connect.no-credentials",
    kind: "error",
    group: "Connecting",
    template:
      "no AWS credentials were found. Sign in with `aws login` or `aws sso login`, set AWS_PROFILE or the key's `profile`, or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY",
    cause:
      "No source in the AWS SDK's default credential chain had credentials: no environment keys, no usable profile, no container or instance role. An `aws login` session whose token could not be refreshed also ends here.",
    fix: "Sign in with `aws login` or `aws sso login` and set `AWS_PROFILE` or the key's `profile` to that profile, or set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Check that the profile name is spelt as in `~/.aws/config`. See the AWS setup guide.",
  },
  ssoSession: {
    id: "aws.connect.sso-session",
    kind: "error",
    group: "Connecting",
    template:
      "the AWS IAM Identity Center (SSO) session has expired or has not started. Run `aws sso login` with the profile the key uses",
    cause:
      "The profile signs in through IAM Identity Center, and its cached token is missing, expired, or cannot be refreshed.",
    fix: "Run `aws sso login --profile <profile>` with the profile the key uses, then run the command again.",
  },
  loginSession: {
    id: "aws.connect.login-session",
    kind: "error",
    group: "Connecting",
    template:
      "the `aws login` session has no usable token. Run `aws login` with the profile the key uses",
    cause:
      "The profile signs in with `aws login` (its `login_session` setting), and its cached token is missing, unreadable, or cannot be refreshed.",
    fix: "Run `aws login --profile <profile>` with the profile the key uses, then run the command again.",
  },
  mfaRequired: {
    id: "aws.connect.mfa-required",
    kind: "error",
    group: "Connecting",
    template:
      "the AWS profile assumes a role that needs an MFA code, which the plugin cannot ask for. Get temporary credentials first, and pass them in the environment without the profile",
    cause:
      "The profile has `role_arn` and `mfa_serial`. The AWS SDK needs a callback to ask for the MFA code, and the plugin has none: it signs without prompting.",
    fix: 'Export temporary credentials with `eval "$(aws configure export-credentials --profile <profile> --format env)"`, which asks for the code, then unset `AWS_PROFILE` and the key\'s `profile`: while a profile is set, the AWS SDK skips the environment keys. Or use a profile that signs in with `aws sso login`.',
  },
  expiredToken: {
    id: "aws.connect.expired-token",
    kind: "error",
    group: "Connecting",
    template:
      "AWS refused the call because the session token has expired (ExpiredTokenException). Sign in again, or get new temporary credentials",
    cause:
      "The temporary credentials, often `AWS_SESSION_TOKEN` and its keys in the environment, have expired.",
    fix: "Sign in again, or export new temporary credentials. A profile that signs in with `aws login` or `aws sso login` refreshes them itself while its session lasts.",
  },
  notFound: {
    id: "aws.key.not-found",
    kind: "error",
    group: "Keys",
    template:
      "AWS KMS has no such key in region {region} (NotFoundException). Check `keyId`, and that the region is the key's",
    cause:
      "The key id or alias does not exist in this account and region. An alias or a bare key id is looked up in the client's region, so a key in another region, or another account, is not found.",
    fix: "Check `keyId`. Set the key's `region`, or use the key ARN, which names its region.",
  },
  accessDenied: {
    id: "aws.key.access-denied",
    kind: "error",
    group: "Keys",
    template:
      "AWS KMS refused the call in region {region} (AccessDeniedException). Grant kms:GetPublicKey and kms:Sign on the key to the identity the credentials belong to, and check that the region is the key's",
    cause:
      "The identity lacks `kms:GetPublicKey` or `kms:Sign` on this key, the `Sign` conditions do not match, or the key policy does not allow IAM access. A key looked up in another region can also give this error.",
    fix: "Grant the two permissions as in the AWS setup guide, step 2. Check which identity signs with `aws sts get-caller-identity` and the same profile, and check the region.",
  },
  disabled: {
    id: "aws.key.disabled",
    kind: "error",
    group: "Keys",
    template:
      "the key is disabled (DisabledException). Enable it with aws kms enable-key --key-id <key id or ARN>",
    cause: "The key is disabled, for example right after its deletion was cancelled.",
    fix: "Run `aws kms enable-key --key-id <key id or ARN>`. It takes a key id or key ARN, not an alias.",
  },
  invalidState: {
    id: "aws.key.invalid-state",
    kind: "error",
    group: "Keys",
    template:
      "the key's state does not allow the call (KMSInvalidStateException), usually because it is pending deletion. Check it with aws kms describe-key",
    cause:
      "The key is pending deletion, or in another state that does not allow signing, such as pending import.",
    fix: "For a key pending deletion, run `aws kms cancel-key-deletion --key-id <key id or ARN>`, then `aws kms enable-key --key-id <key id or ARN>`. Both take a key id or key ARN, not an alias. See the key loss guide.",
  },
  unavailable: {
    id: "aws.key.unavailable",
    kind: "error",
    group: "Keys",
    template: "AWS KMS could not use the key just now (KeyUnavailableException). Run again",
    cause:
      "AWS KMS could not reach the key's material for a moment, after the AWS SDK's own retries.",
    fix: "Run the command again. If it repeats, check the AWS Health Dashboard for AWS KMS in the key's region.",
  },
  historyKeyLookupDenied: {
    id: "aws.history.key-lookup-denied",
    kind: "error",
    group: "History",
    template:
      "cannot find the key ARN: the credentials lack kms:GetPublicKey, which kms history needs for a key named by an alias or a bare key id. Grant it, or name the key by its key ARN",
    cause:
      "CloudTrail records each sign event under the key ARN. For a key named by an alias or a bare key id, `kms history` first calls `GetPublicKey` to learn the ARN, and AWS KMS refused that call.",
    fix: "Grant `kms:GetPublicKey` on the key to the identity that runs `kms history` (signing needs it too), or set `keyId` to the key ARN.",
  },
  historyUnreadableEvent: {
    id: "aws.history.unreadable-event",
    kind: "error",
    group: "History",
    template:
      "CloudTrail returned a sign event that is not a readable event record, so the history cannot be shown in full",
    cause:
      "A `LookupEvents` answer held a `Sign` event whose `CloudTrailEvent` field is not a JSON object with a valid `eventTime`. The reader cannot tell whether the event belongs to the key, so it stops instead of leaving it out.",
    fix: "Run again. If it repeats, look at the event in the CloudTrail console, and open an issue at https://github.com/aelmanaa/hardhat-kms/issues.",
  },
  noPackageVersion: {
    id: "aws.internal.no-package-version",
    kind: "internal",
    group: "Internal",
    template: "{packageName}/package.json has no version",
    cause:
      "The installed @hardhat-kms/aws has no `version` in its package.json, so the install is broken.",
    fix: "Reinstall the dependencies. If it repeats, open an issue at https://github.com/aelmanaa/hardhat-kms/issues.",
  },
} as const;

/** Every entry, checked against the entry type. */
export const ENTRIES: readonly ErrorEntry[] = Object.values(ERRORS);
