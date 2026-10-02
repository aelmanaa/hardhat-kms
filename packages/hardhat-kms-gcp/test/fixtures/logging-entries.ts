// Cloud Audit Logs entries for Cloud KMS, as `entries.list` returned them from a test project on
// 2026-10-02 with Data Access logs on, with every id replaced by a placeholder: the project, key
// ring, key, principals, IP addresses, insert ids and the OAuth client. The shapes, field names,
// the hex digest and the empty `status` of a served request are as logged.

export const PROJECT = "example-project";
/** A project number, which names the same project as `PROJECT` in a resource name. */
export const PROJECT_NUMBER = "123456789012";
export const LOCATION = "us-east1";
export const KEY_RING = "example-ring";
export const KEY = "deployer";
export const KEY_PATH: string = `locations/${LOCATION}/keyRings/${KEY_RING}/cryptoKeys/${KEY}`;
export const CRYPTO_KEY_NAME: string = `projects/${PROJECT}/${KEY_PATH}`;
export const KEY_VERSION_NAME: string = `${CRYPTO_KEY_NAME}/cryptoKeyVersions/1`;
export const USER = "signer@example.com";
export const SERVICE_ACCOUNT: string = `deployer@${PROJECT}.iam.gserviceaccount.com`;
export const OAUTH_CLIENT = "placeholder-client.apps.googleusercontent.com";
export const DIGEST_HEX = "bbc5f4ce54e5335c553c867d090bc11361b096a59579e8605e275691136ff613";
export const PLUGIN_USER_AGENT = "hardhat-kms/0.0.0 google-api-nodejs-client/11.1.0,gzip(gfe)";

interface EntryOptions {
  timestamp: string;
  insertId: string;
  version?: string;
  cryptoKeyName?: string;
  methodName?: string;
  status?: Record<string, unknown>;
  authenticationInfo?: Record<string, unknown>;
  callerIp?: string;
  userAgent?: string;
  digest?: string | undefined;
}

/**
 * A Data Access entry of Cloud KMS, with the fields and nesting the live entries had.
 *
 * @param options - What differs between entries.
 * @returns The entry, as `entries.list` returns it.
 */
export function kmsEntry(options: EntryOptions): Record<string, unknown> {
  const cryptoKeyName = options.cryptoKeyName ?? CRYPTO_KEY_NAME;
  const version = options.version ?? "1";
  const name = `${cryptoKeyName}/cryptoKeyVersions/${version}`;
  const [, project, , location, , keyRing, , key] = cryptoKeyName.split("/");
  return {
    protoPayload: {
      "@type": "type.googleapis.com/google.cloud.audit.AuditLog",
      status: options.status ?? {},
      authenticationInfo: options.authenticationInfo ?? {
        principalEmail: USER,
        principalSubject: `user:${USER}`,
        oauthInfo: { oauthClientId: OAUTH_CLIENT },
      },
      requestMetadata: {
        callerIp: options.callerIp ?? "203.0.113.7",
        callerSuppliedUserAgent: options.userAgent ?? PLUGIN_USER_AGENT,
        requestAttributes: { time: options.timestamp, auth: {} },
        destinationAttributes: {},
      },
      serviceName: "cloudkms.googleapis.com",
      methodName: options.methodName ?? "AsymmetricSign",
      authorizationInfo: [
        {
          resource: cryptoKeyName,
          permission: "cloudkms.cryptoKeyVersions.useToSign",
          granted: true,
          resourceAttributes: {
            service: "google.cloud.kms",
            name: cryptoKeyName,
            type: "cloudkms.googleapis.com/CryptoKey",
          },
          permissionType: "DATA_READ",
        },
      ],
      resourceName: name,
      request: {
        name,
        ...(options.digest === undefined ? {} : { digest: { sha256: options.digest } }),
        "@type": "type.googleapis.com/google.cloud.kms.v1.AsymmetricSignRequest",
      },
      metadata: {},
      resourceLocation: { currentLocations: [location] },
    },
    insertId: options.insertId,
    resource: {
      type: "cloudkms_cryptokeyversion",
      labels: {
        crypto_key_version_id: version,
        project_id: project,
        crypto_key_id: key,
        key_ring_id: keyRing,
        location,
      },
    },
    timestamp: options.timestamp,
    severity: "INFO",
    logName: `projects/${project}/logs/cloudaudit.googleapis.com%2Fdata_access`,
    // The live entries arrived 0.14 to 1.9 seconds later; the time does not matter here.
    receiveTimestamp: options.timestamp,
  };
}

/** A signature through the plugin, with user credentials: the shape of the live entries. */
export const PLUGIN_SIGN: Record<string, unknown> = kmsEntry({
  timestamp: "2026-10-02T09:06:06.982112024Z",
  insertId: "insert-1",
  digest: DIGEST_HEX,
});

/** A signature by a service account from inside Google's network, through another client. */
export const SERVICE_ACCOUNT_SIGN: Record<string, unknown> = kmsEntry({
  timestamp: "2026-10-02T08:30:00.5Z",
  insertId: "insert-2",
  version: "2",
  authenticationInfo: {
    principalEmail: SERVICE_ACCOUNT,
    principalSubject: `serviceAccount:${SERVICE_ACCOUNT}`,
  },
  callerIp: "private",
  userAgent: "google-cloud-sdk gcloud/540.0.0 command/gcloud.kms.asymmetric-sign",
  digest: DIGEST_HEX.toUpperCase(),
});

/**
 * A refused sign request, logged with its status, as the live run logged a request for a version
 * that does not exist. Its principal has only a subject, as a workload identity's does.
 */
export const FAILED_SIGN: Record<string, unknown> = kmsEntry({
  timestamp: "2026-10-02T08:00:00Z",
  insertId: "insert-3",
  version: "999999",
  status: {
    code: 5,
    message: `CryptoKeyVersion ${CRYPTO_KEY_NAME}/cryptoKeyVersions/999999 not found.`,
  },
  authenticationInfo: { principalSubject: "principal://iam.googleapis.com/placeholder" },
  digest: DIGEST_HEX,
});

/** A signature from an IPv6 address, which Cloud Audit Logs writes in its short form. */
export const IPV6_SIGN: Record<string, unknown> = kmsEntry({
  timestamp: "2026-10-02T07:30:00Z",
  insertId: "insert-6",
  callerIp: "2001:db8:85a3::8a2e:370:7334",
  digest: DIGEST_HEX,
});
