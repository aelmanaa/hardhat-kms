// An in-process Log Analytics query endpoint for the real @azure/core-rest-pipeline: an HttpClient
// that answers `POST /v1/workspaces/{id}/query` with queued answers, so the pipeline's own
// policies (bearer token, user agent, retries) all run.
import {
  createHttpHeaders,
  type HttpClient,
  type PipelineRequest,
  type PipelineResponse,
} from "@azure/core-rest-pipeline";
import type { AccessToken, TokenCredential } from "@azure/identity";

/** A request the endpoint received. */
export interface QueryHttpRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  userAgent: string | undefined;
  prefer: string | undefined;
  body: unknown;
}

/** An answer to queue: a status, a JSON body, and headers such as `Retry-After`. */
export interface QueryHttpAnswer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** The endpoint and what it received. */
export interface LogAnalyticsHttp {
  httpClient: HttpClient;
  requests: QueryHttpRequest[];
  answers: QueryHttpAnswer[];
  /** The scopes the credential was asked for. */
  scopes: string[];
  credential: TokenCredential;
}

function respond(request: PipelineRequest, answer: QueryHttpAnswer): PipelineResponse {
  return {
    request,
    status: answer.status,
    headers: createHttpHeaders({ "content-type": "application/json", ...answer.headers }),
    bodyAsText: answer.body === undefined ? "" : JSON.stringify(answer.body),
  };
}

/**
 * Builds the endpoint and a credential that hands out a fake token.
 *
 * @returns The endpoint.
 */
export function logAnalyticsHttp(): LogAnalyticsHttp {
  const requests: QueryHttpRequest[] = [];
  const answers: QueryHttpAnswer[] = [];
  const scopes: string[] = [];
  const httpClient: HttpClient = {
    sendRequest: async (request) => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get("authorization"),
        userAgent: request.headers.get("user-agent"),
        prefer: request.headers.get("prefer"),
        body: typeof request.body === "string" ? JSON.parse(request.body) : undefined,
      });
      const answer = answers.shift();
      if (answer === undefined) {
        throw new Error("the fake Log Analytics endpoint has no answer left");
      }
      return await Promise.resolve(respond(request, answer));
    },
  };
  const credential: TokenCredential = {
    getToken: async (scope): Promise<AccessToken> => {
      scopes.push(...[scope].flat());
      return await Promise.resolve({
        token: "fake-log-analytics-token",
        expiresOnTimestamp: Date.now() + 3_600_000,
      });
    },
  };
  return { httpClient, requests, answers, scopes, credential };
}
