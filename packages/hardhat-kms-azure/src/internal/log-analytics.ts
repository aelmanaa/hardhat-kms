// The query call of the history reader: the Log Analytics query REST API, sent through
// @azure/core-rest-pipeline, which @azure/keyvault-keys already installs, with the plugin's
// credential chain. The Log Analytics client library would add a package for this one call.
import {
  bearerTokenAuthenticationPolicy,
  createDefaultHttpClient,
  createHttpHeaders,
  createPipelineFromOptions,
  createPipelineRequest,
  type HttpClient,
} from "@azure/core-rest-pipeline";
import type { TokenCredential } from "@azure/identity";

import type { QueryWorkspace } from "./history.ts";

/** The Log Analytics query endpoint of Azure's public cloud. */
const LOG_ANALYTICS_ENDPOINT = "https://api.loganalytics.io";

/** The token scope that Log Analytics queries need. */
export const LOG_ANALYTICS_SCOPE = "https://api.loganalytics.io/.default";

/**
 * How often the pipeline repeats a throttled (429, honouring `Retry-After`), failed (5xx) or
 * unanswered call before the reader reports it.
 */
const MAX_RETRIES = 2;

/** Builds the query call; tests pass an `httpClient` that answers in process. */
export interface LogAnalyticsOptions {
  httpClient?: HttpClient;
}

/**
 * Builds the Log Analytics query call: an authorized POST to
 * `/v1/workspaces/{workspaceId}/query` with the query as its JSON body.
 *
 * @param credential - The plugin's credential chain.
 * @param userAgent - The plugin's user-agent tag, such as `hardhat-kms/1.0.0`.
 * @param options - The HTTP client; by default the SDK's own.
 * @returns The call.
 */
export function logAnalyticsQuery(
  credential: TokenCredential,
  userAgent: string,
  options: LogAnalyticsOptions = {},
): QueryWorkspace {
  const pipeline = createPipelineFromOptions({
    userAgentOptions: { userAgentPrefix: userAgent },
    retryOptions: { maxRetries: MAX_RETRIES },
  });
  pipeline.addPolicy(bearerTokenAuthenticationPolicy({ credential, scopes: LOG_ANALYTICS_SCOPE }));
  const httpClient = options.httpClient ?? createDefaultHttpClient();
  return async (workspaceId, query, signal) => {
    const response = await pipeline.sendRequest(
      httpClient,
      createPipelineRequest({
        url: `${LOG_ANALYTICS_ENDPOINT}/v1/workspaces/${encodeURIComponent(workspaceId)}/query`,
        method: "POST",
        headers: createHttpHeaders({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
        body: JSON.stringify(query),
        abortSignal: signal,
      }),
    );
    return { status: response.status, body: parseJson(response.bodyAsText) };
  };
}

/** The parsed JSON body, or `undefined` when there is none or it is not JSON. */
function parseJson(text: string | null | undefined): unknown {
  if (text === undefined || text === null || text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
