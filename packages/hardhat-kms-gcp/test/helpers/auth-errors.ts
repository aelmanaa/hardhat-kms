// Errors shaped as google-auth-library and gaxios reject while getting an access token, with
// secrets planted where a careless message would show them.

/** A project number, in request paths and messages: no error may show it. */
export const SECRET_PROJECT_NUMBER = "987654321098";

/** A description that repeats a claim of the external token: no error may show it. */
export const SECRET_CLAIM = "repo:acme-secret/private-repo";

/**
 * A `GaxiosError`'s shape: the request's URL in `config.url`, as gaxios 7 keeps it (a `URL`), and
 * the HTTP status on the error and on its response.
 *
 * @param url - The request URL.
 * @param status - The HTTP status.
 * @param urlAsString - Keep the URL as a string, as older gaxios versions did.
 * @returns The error.
 */
export function gaxiosError(url: string, status: number, urlAsString = false): Error {
  return Object.assign(new Error(`Request failed with status code ${status}: ${url}`), {
    config: { url: urlAsString ? url : new URL(url) },
    status,
    response: {
      status,
      data: { error: { code: status, message: `projects/${SECRET_PROJECT_NUMBER} denied` } },
    },
  });
}

/** Cloud Resource Manager refusing the project lookup google-auth-library makes. */
export function projectLookupRefused(status = 403): Error {
  return gaxiosError(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${SECRET_PROJECT_NUMBER}`,
    status,
  );
}

/**
 * A refused token exchange, as google-auth-library rethrows it: a plain `Error` whose message
 * starts with the OAuth error code, with the gaxios error's fields copied on.
 *
 * @param code - The OAuth error code, such as `invalid_grant`.
 * @returns The error.
 */
export function tokenExchangeRefused(code = "invalid_grant"): Error {
  return Object.assign(
    new Error(`Error code ${code}: The audience does not match; subject ${SECRET_CLAIM}`),
    {
      config: { url: new URL("https://sts.googleapis.com/v1/token") },
      status: 400,
      response: {
        status: 400,
        data: { error: code, error_description: `subject ${SECRET_CLAIM}` },
      },
    },
  );
}
