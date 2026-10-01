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
  "AWS_MAX_ATTEMPTS",
  "AWS_RETRY_MODE",
];

/**
 * Points the AWS SDK at test credentials and nothing else: no profile, no config files, no FIPS or
 * dual-stack setting. Tests that talk to a local endpoint call it before creating clients.
 *
 * @returns A function that restores the previous environment.
 */
export function isolateAwsEnvironment(): () => void {
  const saved = { ...process.env };
  process.env.AWS_ACCESS_KEY_ID = "test";
  process.env.AWS_SECRET_ACCESS_KEY = "test";
  process.env.AWS_CONFIG_FILE = "/nonexistent/hardhat-kms-aws/config";
  process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/hardhat-kms-aws/credentials";
  for (const name of CLEARED) {
    Reflect.deleteProperty(process.env, name);
  }
  return () => {
    process.env = saved;
  };
}
