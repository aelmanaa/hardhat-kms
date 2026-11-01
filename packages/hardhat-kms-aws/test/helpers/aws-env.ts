/** Settings that would let a developer's or runner's AWS setup change how the SDK connects. */
const CLEARED = [
  "AWS_PROFILE",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_USE_FIPS_ENDPOINT",
  "AWS_USE_DUALSTACK_ENDPOINT",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_KMS",
  "AWS_ENDPOINT_URL_CLOUDTRAIL",
  "AWS_ENDPOINT_URL_STS",
  "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS",
  "AWS_MAX_ATTEMPTS",
  "AWS_RETRY_MODE",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
];

/**
 * Points the AWS SDK at test credentials and nothing else: no profile, no config files, no instance
 * metadata, no FIPS or dual-stack setting. Tests that talk to a local endpoint call it before
 * creating clients.
 *
 * Without a region, the SDK asks the instance metadata service at 169.254.169.254 and takes the body
 * of any 2xx answer as the region, so a runner that answers there gives a key with no region one
 * (#626).
 *
 * @returns A function that restores the previous environment.
 */
export function isolateAwsEnvironment(): () => void {
  const saved = { ...process.env };
  process.env.AWS_ACCESS_KEY_ID = "test";
  process.env.AWS_SECRET_ACCESS_KEY = "test";
  process.env.AWS_CONFIG_FILE = "/nonexistent/hardhat-kms-aws/config";
  process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/hardhat-kms-aws/credentials";
  process.env.AWS_EC2_METADATA_DISABLED = "true";
  for (const name of CLEARED) {
    Reflect.deleteProperty(process.env, name);
  }
  return () => {
    process.env = saved;
  };
}
