import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";

import { JWT } from "google-auth-library";

import type { ListEntries } from "../../src/internal/history.ts";
import { LOGGING_READ_SCOPE, loggingTransport } from "../../src/internal/logging-client.ts";

/** An `entries.list` request the local endpoint received. */
export interface LoggingRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

/** One answer: a JSON body with its HTTP status, or no answer until the connection closes. */
export type LoggingAnswer = { status: number; body: unknown } | "hang";

/** A running local Cloud Logging endpoint. */
export interface LoggingServer {
  endpoint: string;
  requests: LoggingRequest[];
  /** The answers to give, in order; past the last one, an empty page. */
  answers: LoggingAnswer[];
  close(): Promise<void>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/**
 * Serves `POST /v2/entries:list` as Cloud Logging's REST API does, from a list of answers, and
 * records each request with its headers and parsed body.
 *
 * @returns The server; close it when done.
 */
export async function startLoggingServer(): Promise<LoggingServer> {
  const requests: LoggingRequest[] = [];
  const answers: LoggingAnswer[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({
        path: request.url ?? "",
        headers: request.headers,
        body: text === "" ? undefined : JSON.parse(text),
      });
      if (request.method !== "POST" || request.url !== "/v2/entries:list") {
        send(response, 404, { error: { code: 404, status: "NOT_FOUND" } });
        return;
      }
      const answer = answers.shift() ?? { status: 200, body: {} };
      if (answer !== "hang") {
        send(response, answer.status, answer.body);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the server has no port");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    answers,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/**
 * A throwaway service account whose self-signed tokens need no network.
 *
 * @returns The auth client.
 */
export function localAuth(): JWT {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const auth = new JWT({
    email: "hardhat-kms-test@example.iam.gserviceaccount.com",
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    scopes: [LOGGING_READ_SCOPE],
  });
  // A self-signed token: the constructor does not take this setting, which keeps the client from
  // asking Google's token endpoint.
  auth.useJWTAccessWithScope = true;
  return auth;
}

/**
 * The real `entries.list` call, through google-auth-library and gaxios, pointed at a local server
 * and signed by {@link localAuth}.
 *
 * @param endpoint - The local server.
 * @returns A `logging` argument for `kmsHandlers`.
 */
export function localLogging(endpoint: string): (userAgent: string) => Promise<ListEntries> {
  const auth = localAuth();
  return async (userAgent) => await Promise.resolve(loggingTransport(auth, userAgent, endpoint));
}
