import type { ErrorEntry } from "hardhat-kms/provider-utils";

/*
 * Every error @hardhat-kms/turnkey builds, with its cause and fix. Build errors only from these
 * entries, with catalogError or internalError from hardhat-kms/provider-utils; `pnpm run
 * docs:check` fails on a throw that bypasses them. `pnpm run docs:errors` writes
 * docs/user/reference/errors.md from this file.
 *
 * No message quotes Turnkey's response: its `message` can name organizations. A message carries at
 * most the HTTP status and Turnkey's `turnkeyErrorCode` when that code matches
 * `^[A-Z][A-Z0-9_]{0,63}$`. Only `turnkey.activity.approval-needed` carries the activity id.
 */

/** The @hardhat-kms/turnkey error catalogue. */
export const ERRORS = {
  privateKeyFormat: {
    id: "turnkey.credential.private-key-format",
    kind: "error",
    group: "Credentials",
    template:
      "the API private key is not a P-256 private key: expected 64 hex characters, the private key of a Turnkey API key pair",
    cause:
      "The configuration variable of `apiPrivateKey` does not hold 64 hexadecimal characters, or holds a number that is not a valid P-256 private key. A common mistake is to paste the public key, which has 66 characters. The message never shows the value.",
    fix: "Generate a P-256 API key in the Turnkey dashboard or with the Turnkey CLI, and set the variable to the private key's hex.",
  },
  publicKeyMismatch: {
    id: "turnkey.credential.public-key-mismatch",
    kind: "error",
    group: "Credentials",
    template:
      "the API public key does not match the API private key. Set both from the same Turnkey API key pair, or remove `apiPublicKey`: the plugin derives it from the private key",
    cause:
      "`apiPublicKey` is set and differs from the compressed public key of `apiPrivateKey`. The plugin checks this before it sends any request, so a mismatched pair fails here and not as a 401 from Turnkey.",
    fix: "Set both variables from the same API key pair, or remove `apiPublicKey`.",
  },
  unauthenticated: {
    id: "turnkey.service.unauthenticated",
    kind: "error",
    group: "Turnkey answers",
    template:
      "Turnkey answered {status}: it did not accept the API key. The key may not be registered in this organization or its parent, or it has expired",
    cause:
      "Turnkey refused the request's stamp, for example with `SIGNATURE_INVALID`, `PUBLIC_KEY_NOT_FOUND`, `API_KEY_EXPIRED`, `CREDENTIAL_NOT_FOUND` or `UNAUTHENTICATED`.",
    fix: "Check that the API key belongs to a user of the key's organization or its parent organization, that it has not expired, and that `organizationId` is right.",
  },
  timestamp: {
    id: "turnkey.service.timestamp",
    kind: "error",
    group: "Turnkey answers",
    template:
      "Turnkey answered {status}: it refused the request's time. Turnkey accepts a request made at most 1 hour ago and at most 5 minutes ahead of its clock. Check this computer's clock",
    cause:
      "Turnkey refused the request's `timestampMs` as too old or in the future, which happens when this computer's clock is wrong. The plugin sets the time when it builds the request.",
    fix: "Sync this computer's clock, for example with NTP, and run again.",
  },
  forbidden: {
    id: "turnkey.service.forbidden",
    kind: "error",
    group: "Turnkey answers",
    template:
      "Turnkey answered {status}: no policy lets the API key's user sign this request with this address{request}. Add a policy that allows it, as the Turnkey setup guide shows",
    cause:
      "No Turnkey policy allows this API user to sign with this wallet account, or a policy denies it. A message is sent with `HASH_FUNCTION_KECCAK256`, typed data with `PAYLOAD_ENCODING_EIP712` and a digest with `HASH_FUNCTION_NO_OP` and `PAYLOAD_ENCODING_HEXADECIMAL`. For a message or typed data, the error names what the request used: a policy written for Foundry, which sends every request as a `HASH_FUNCTION_NO_OP` digest, may allow only that, and then denies messages, and typed data too when it also requires `PAYLOAD_ENCODING_HEXADECIMAL`. Turnkey also answers 403 when API access is disabled.",
    fix: "Add a policy that allows `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2` for this user and wallet account, with the hash function and encoding of each request the plugin sends, as the Turnkey setup guide shows.",
  },
  notFound: {
    id: "turnkey.service.not-found",
    kind: "error",
    group: "Turnkey answers",
    template: "Turnkey answered {status}: the organization was not found. Check `organizationId`",
    cause: "Turnkey has no organization with the key's `organizationId`.",
    fix: "Copy the organization id from the Turnkey dashboard. For a wallet in a sub-organization, use the sub-organization's id.",
  },
  badRequest: {
    id: "turnkey.service.bad-request",
    kind: "error",
    group: "Turnkey answers",
    template:
      "Turnkey answered {status}: it refused the request. Check that `address` is a wallet account of the organization `organizationId` names",
    cause:
      "Turnkey found the request invalid. The usual cause is an `address` that is not a wallet account or private key address of the organization.",
    fix: "Check `address` and `organizationId` against the wallet account in the Turnkey dashboard.",
  },
  quota: {
    id: "turnkey.service.quota",
    kind: "error",
    group: "Turnkey answers",
    template:
      "Turnkey answered {status}: the organization has used up its monthly signing quota. The Free plan includes 25 signatures a month",
    cause:
      "Turnkey refused to sign because the organization's plan has no signatures left this month (`SIGNING_QUOTA_EXCEEDED`). The plugin does not retry it.",
    fix: "Wait for the next month, or move the organization to a plan with more signatures.",
  },
  throttled: {
    id: "turnkey.service.throttled",
    kind: "error",
    group: "Turnkey answers",
    template:
      "Turnkey answered {status} {attempts} times: too many requests. The Free and Pay-as-you-go plans allow 1 request a second. Send fewer requests at a time",
    cause:
      "Turnkey rate-limited the organization (`RATE_LIMIT_EXCEEDED`, or a 429 without a code), and the plugin's retries, which send the same request so Turnkey signs it once, did not get through.",
    fix: "Sign fewer requests in parallel, or move the organization to a plan with a higher rate limit.",
  },
  redirected: {
    id: "turnkey.service.redirected",
    kind: "error",
    group: "Turnkey answers",
    template:
      "Turnkey answered {status}, a redirect. The plugin does not follow redirects, so the signed request goes nowhere else. Check the network and any proxy",
    cause:
      "The answer was a 3xx redirect. Turnkey's API does not redirect, so a proxy or captive portal may be in the way. The request carries a stamp over its body, so the plugin never sends it to another address.",
    fix: "Check the network and any `HTTPS_PROXY`.",
  },
  unreachable: {
    id: "turnkey.service.unreachable",
    kind: "error",
    group: "Turnkey answers",
    template:
      "Turnkey could not be reached after {attempts} attempts ({reason}). Check the network and any proxy",
    cause:
      "No HTTP answer came back, after the plugin's retries. The reason is the error's class name or code, for example `ECONNREFUSED`.",
    fix: "Check that `api.turnkey.com` can be reached, DNS and any proxy.",
  },
  answered: {
    id: "turnkey.service.answered",
    kind: "error",
    group: "Turnkey answers",
    template: "Turnkey answered {status}",
    cause:
      "Turnkey answered with a status the plugin has no explanation for, such as a server error that lasted through the retries. The message shows the status and Turnkey's error code, never its message.",
    fix: "Run again. If it repeats, check Turnkey's status page, or report it with the status and code.",
  },
  approvalNeeded: {
    id: "turnkey.activity.approval-needed",
    kind: "error",
    group: "Activities",
    template:
      "Turnkey holds {activity} until it gets {need}. The plugin does not wait for approvals, and the activity stays pending in Turnkey. Reject it in the Turnkey dashboard, so that nobody approves it later",
    cause:
      "A policy on the key requires consensus (`ACTIVITY_STATUS_CONSENSUS_NEEDED`) or another authenticator (`ACTIVITY_STATUS_AUTHENTICATORS_NEEDED`). The plugin fails at once. The activity stays in Turnkey: if someone approves it later, a signature exists for a request the plugin gave up on, with a nonce the plugin may use again. The message shows the activity id when it is a UUID, so that the activity can be found.",
    fix: "Reject the pending activity in the Turnkey dashboard. To sign with this key from the plugin, use a policy that allows these requests without approval.",
  },
  activityFailed: {
    id: "turnkey.activity.failed",
    kind: "error",
    group: "Activities",
    template: "Turnkey's signing activity failed ({code})",
    cause:
      "Turnkey accepted the request, then the activity ended as `ACTIVITY_STATUS_FAILED`. The message shows the failure's `turnkeyErrorCode`, or `no code`.",
    fix: "Check the activity in the Turnkey dashboard. Run again; if it repeats, report it with the code.",
  },
  activityRejected: {
    id: "turnkey.activity.rejected",
    kind: "error",
    group: "Activities",
    template: "Turnkey's signing activity was rejected ({code})",
    cause:
      "The activity ended as `ACTIVITY_STATUS_REJECTED`, for example after an approver rejected it.",
    fix: "Check the activity and the key's policies in the Turnkey dashboard.",
  },
  malformed: {
    id: "turnkey.sign.malformed",
    kind: "error",
    group: "Signing",
    template: "Turnkey answered in a form this plugin does not read: {problem}",
    cause:
      "The answer lacks a field every answer has, has an unknown activity status, or carries an `r`, `s` or `v` that is not a hex number of the expected size: `r` and `s` of 1 to 64 hex characters, `v` one of `00`, `01`, `1b` or `1c`. The plugin signs nothing with it.",
    fix: "Run again. If it repeats, report it with the problem the message names.",
  },
  responseMismatch: {
    id: "turnkey.sign.response-mismatch",
    kind: "error",
    group: "Signing",
    template:
      "Turnkey answered for another {field} than the request named. The plugin does not use the answer",
    cause:
      "The answer's activity names another organization, activity type or activity id than the request. Turnkey always answers for the request it got, so something between the plugin and Turnkey changed the answer.",
    fix: "Check the network and any proxy. If it repeats, report it.",
  },
  noPackageVersion: {
    id: "turnkey.internal.no-package-version",
    kind: "internal",
    group: "Internal",
    template: "{packageName}/package.json has no version",
    cause:
      "The installed @hardhat-kms/turnkey has no `version` in its package.json, so the install is broken.",
    fix: "Reinstall the dependencies. If it repeats, open an issue at https://github.com/aelmanaa/hardhat-kms/issues.",
  },
} as const;

/** Every entry, checked against the entry type. */
export const ENTRIES: readonly ErrorEntry[] = Object.values(ERRORS);
