/**
 * Host suffixes of Azure Key Vault and Managed HSM, in the public and sovereign clouds. Keys on any
 * other host are rejected, so a key id cannot point the signer at an arbitrary server.
 */
const AZURE_VAULT_HOST_SUFFIXES: readonly string[] = [
  ".vault.azure.net",
  ".managedhsm.azure.net",
  ".vault.azure.cn",
  ".managedhsm.azure.cn",
  ".vault.usgovcloudapi.net",
  ".managedhsm.usgovcloudapi.net",
  ".vault.microsoftazure.de",
  ".managedhsm.microsoftazure.de",
];

/** A parsed Azure key identifier. */
export interface ParsedAzureKeyId {
  /** `https://<host>`, without a trailing slash. */
  vaultUrl: string;
  keyName: string;
  keyVersion?: string;
}

const KEY_NAME_RE = /^[0-9A-Za-z-]{1,127}$/;
const KEY_VERSION_RE = /^[0-9A-Za-z]{1,64}$/;

/**
 * Checks that a URL is an Azure Key Vault or Managed HSM origin.
 *
 * @param url - The parsed URL.
 * @returns Whether it uses https, the default port and an Azure vault host.
 */
function isVaultOrigin(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    AZURE_VAULT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)
  );
}

function parseUrl(value: string): URL | undefined {
  // `?`, `#` and `\` are rejected outright: URL parsing would drop an empty query or fragment
  // and turn `\` into `/`, so the value used later would differ from the one checked.
  if (/[?#\\]/.test(value)) {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Parses a vault URL such as `https://my-vault.vault.azure.net`.
 *
 * @param value - The URL, with or without a trailing slash.
 * @returns The normalised vault URL, or `undefined` if it is not an Azure vault origin.
 */
export function parseAzureVaultUrl(value: string): string | undefined {
  const url = parseUrl(value);
  if (
    url === undefined ||
    !isVaultOrigin(url) ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  return url.origin;
}

/**
 * Parses a key identifier such as `https://my-vault.vault.azure.net/keys/deployer/0123abcd`.
 *
 * @param value - The key identifier, versioned or not.
 * @returns Its parts, or `undefined` if it is not an Azure key identifier.
 */
export function parseAzureKeyId(value: string): ParsedAzureKeyId | undefined {
  const url = parseUrl(value);
  if (url === undefined || !isVaultOrigin(url) || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  const [, collection, keyName, keyVersion, ...rest] = url.pathname.replace(/\/$/, "").split("/");
  if (
    collection !== "keys" ||
    keyName === undefined ||
    !KEY_NAME_RE.test(keyName) ||
    rest.length > 0
  ) {
    return undefined;
  }
  if (keyVersion !== undefined && !KEY_VERSION_RE.test(keyVersion)) {
    return undefined;
  }
  return keyVersion === undefined
    ? { vaultUrl: url.origin, keyName }
    : { vaultUrl: url.origin, keyName, keyVersion };
}

/** Checks a key name. */
export function isAzureKeyName(value: string): boolean {
  return KEY_NAME_RE.test(value);
}

/** Checks a key version. */
export function isAzureKeyVersion(value: string): boolean {
  return KEY_VERSION_RE.test(value);
}
