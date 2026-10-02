import type { ErrorEntry } from "hardhat-kms/provider-utils";

/*
 * Every error hardhat-kms-aws builds, with its cause and fix. Build errors only from these
 * entries, with catalogError, catalogMessage or internalError from hardhat-kms/provider-utils;
 * `pnpm run docs:check` fails on a throw that bypasses them. `pnpm run docs:errors` writes
 * docs/user/reference/errors.md from this file.
 */

/** The hardhat-kms-aws error catalogue. */
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
  noPackageVersion: {
    id: "aws.internal.no-package-version",
    kind: "internal",
    group: "Internal",
    template: "{packageName}/package.json has no version",
    cause:
      "The installed hardhat-kms-aws has no `version` in its package.json, so the install is broken.",
    fix: "Reinstall the dependencies. If it repeats, open an issue at https://github.com/aelmanaa/hardhat-kms/issues.",
  },
} as const;

/** Every entry, checked against the entry type. */
export const ENTRIES: readonly ErrorEntry[] = Object.values(ERRORS);
