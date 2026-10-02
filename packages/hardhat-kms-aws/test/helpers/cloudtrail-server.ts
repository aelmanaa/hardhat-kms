import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";

/** A request the local endpoint received. */
export interface AuditRequest {
  operation: "LookupEvents" | "GetCallerIdentity" | "other";
  headers: IncomingHttpHeaders;
  body: string;
}

/** A page the local CloudTrail returns: `CloudTrailEvent` JSON strings and the next token. */
export interface AuditPage {
  events: string[];
  nextToken?: string;
}

/** How the local endpoint answers; tests change it between runs. */
export interface AuditBehaviour {
  /** Pages in order: the first without a token, page `n` for the token `page-n`. */
  pages: AuditPage[];
  /** The account STS returns. */
  account: string;
  /** An AWS error code to fail every `LookupEvents` call with, such as `AccessDeniedException`. */
  lookupError?: string | undefined;
}

/** A running local CloudTrail and STS endpoint. */
export interface AuditServer {
  url: string;
  requests: AuditRequest[];
  behaviour: AuditBehaviour;
  close(): Promise<void>;
}

/**
 * Serves CloudTrail `LookupEvents` over the AWS JSON 1.1 protocol and STS `GetCallerIdentity` over
 * the AWS query protocol, as the real SDKs speak them, so `kms history` runs the real SDKs end to
 * end. Point the SDKs at it with `AWS_ENDPOINT_URL_CLOUDTRAIL` and `AWS_ENDPOINT_URL_STS`.
 *
 * @param behaviour - How it answers at first.
 * @returns The server; close it when done.
 */
export async function startAuditServer(behaviour: AuditBehaviour): Promise<AuditServer> {
  const requests: AuditRequest[] = [];
  const state: AuditServer["behaviour"] = behaviour;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const target = String(request.headers["x-amz-target"] ?? "");
      if (target.endsWith(".LookupEvents")) {
        requests.push({ operation: "LookupEvents", headers: request.headers, body });
        if (state.lookupError !== undefined) {
          response.writeHead(400, { "content-type": "application/x-amz-json-1.1" });
          response.end(JSON.stringify({ __type: state.lookupError, message: "refused" }));
          return;
        }
        const parsed: unknown = JSON.parse(body);
        const token: unknown =
          typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "NextToken") : null;
        const index = typeof token === "string" ? Number(token.replace("page-", "")) : 0;
        const page = state.pages[index] ?? { events: [] };
        response.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
        response.end(
          JSON.stringify({
            Events: page.events.map((event) => ({ EventName: "Sign", CloudTrailEvent: event })),
            ...(page.nextToken === undefined ? {} : { NextToken: page.nextToken }),
          }),
        );
        return;
      }
      if (body.includes("Action=GetCallerIdentity")) {
        requests.push({ operation: "GetCallerIdentity", headers: request.headers, body });
        response.writeHead(200, { "content-type": "text/xml" });
        response.end(
          `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::${state.account}:user/deployer</Arn><UserId>AIDAEXAMPLEPRINCIPAL1</UserId><Account>${state.account}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>01234567-89ab-4cde-8f01-23456789abcd</RequestId></ResponseMetadata></GetCallerIdentityResponse>`,
        );
        return;
      }
      requests.push({ operation: "other", headers: request.headers, body });
      response.writeHead(400, { "content-type": "application/x-amz-json-1.1" });
      response.end(JSON.stringify({ __type: "UnknownOperationException" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the server has no TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    behaviour: state,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
