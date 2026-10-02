// An in-process Azure Key Vault for the real @azure/keyvault-keys: an HttpClient that answers the
// requests the SDK's pipeline would send over the network. It speaks the Key Vault REST API
// (`GET /keys/{name}[/{version}]`, `POST /keys/{name}/{version}/sign`) and its challenge-based
// authentication, so the SDK's own request building, auth policy and response parsing all run.
import {
  createHttpHeaders,
  type HttpClient,
  type PipelineRequest,
  type PipelineResponse,
} from "@azure/core-rest-pipeline";
import type { AccessToken, TokenCredential } from "@azure/identity";
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { signCompact } from "./fake-key-vault.ts";

export const TENANT_ID = "00000000-0000-4000-8000-000000000001";
export const TOKEN = "fake-access-token";

/** A request the fake vault received. */
export interface VaultRequest {
  method: string;
  /** The URL path, without the query. */
  path: string;
  apiVersion: string | null;
  authorization: string | undefined;
  /** The `User-Agent` header, as the SDK's pipeline set it. */
  userAgent: string | undefined;
  body: Record<string, unknown> | undefined;
}

/** How the fake vault behaves; defaults are a healthy P-256K key. */
export interface KeyVaultHttpOptions {
  secretKey: Uint8Array;
  vaultUrl: string;
  keyName: string;
  /** The current version, which an unversioned GET returns. */
  currentVersion: string;
  /** The `kid` sign responses carry; by default the requested version's. */
  signKid?: string;
  /** Return the high-S twin of every signature. */
  highS?: boolean;
  /** Return this many bytes instead of the 64-byte signature. */
  signatureLength?: number;
}

/** The fake vault and what it received. */
export interface KeyVaultHttp {
  httpClient: HttpClient;
  requests: VaultRequest[];
}

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

function parseBody(body: PipelineRequest["body"]): Record<string, unknown> | undefined {
  if (typeof body !== "string") {
    return undefined;
  }
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === "object" && parsed !== null
    ? Object.fromEntries(Object.entries(parsed))
    : undefined;
}

/** A JSON response from the fake vault. */
function respond(
  request: PipelineRequest,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): PipelineResponse {
  return {
    request,
    status,
    headers: createHttpHeaders({ "content-type": "application/json", ...headers }),
    bodyAsText: JSON.stringify(body),
  };
}

/**
 * Builds the fake vault.
 *
 * @param options - The key and how to answer.
 * @returns The HttpClient to pass in the SDK's client options, and the requests it saw.
 */
export function keyVaultHttp(options: KeyVaultHttpOptions): KeyVaultHttp {
  const requests: VaultRequest[] = [];
  const point = secp256k1.getPublicKey(options.secretKey, false);
  const keyUrl = (version: string) => `${options.vaultUrl}/keys/${options.keyName}/${version}`;

  const httpClient: HttpClient = {
    sendRequest: async (request) => {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization");
      const body = parseBody(request.body);
      requests.push({
        method: request.method,
        path: url.pathname,
        apiVersion: url.searchParams.get("api-version"),
        authorization,
        userAgent: request.headers.get("user-agent"),
        body,
      });
      if (url.origin !== options.vaultUrl) {
        return respond(request, 404, { error: { code: "NotFound", message: "no such vault" } });
      }
      if (authorization === undefined) {
        // Key Vault's challenge: the SDK asks the credential for a token for this resource.
        return respond(
          request,
          401,
          { error: { code: "Unauthorized", message: "AKV10000: Request is missing a Bearer" } },
          {
            "www-authenticate": `Bearer authorization="https://login.microsoftonline.com/${TENANT_ID}", resource="https://vault.azure.net"`,
          },
        );
      }
      if (authorization !== `Bearer ${TOKEN}`) {
        return respond(request, 401, { error: { code: "Unauthorized", message: "bad token" } });
      }
      const [, collection, name, version, action] = url.pathname.split("/");
      if (collection !== "keys" || name !== options.keyName) {
        return respond(request, 404, { error: { code: "KeyNotFound", message: "no such key" } });
      }
      if (request.method === "GET" && action === undefined) {
        // The SDK asks for `/keys/{name}/` when no version is given.
        const kid = keyUrl(
          version === undefined || version === "" ? options.currentVersion : version,
        );
        return respond(request, 200, {
          key: {
            kid,
            kty: "EC",
            crv: "P-256K",
            key_ops: ["sign", "verify"],
            x: base64url(point.slice(1, 33)),
            y: base64url(point.slice(33)),
          },
          attributes: {
            enabled: true,
            created: 1_700_000_000,
            updated: 1_700_000_000,
            recoveryLevel: "Recoverable+Purgeable",
          },
        });
      }
      if (request.method === "POST" && action === "sign" && version !== undefined) {
        const value = body?.value;
        if (body?.alg !== "ES256K" || typeof value !== "string") {
          return respond(request, 400, { error: { code: "BadParameter", message: "bad sign" } });
        }
        const digest = new Uint8Array(Buffer.from(value, "base64url"));
        let signature = signCompact(options.secretKey, digest, options.highS === true);
        if (options.signatureLength !== undefined) {
          const resized = new Uint8Array(options.signatureLength);
          resized.set(signature.slice(0, options.signatureLength));
          signature = resized;
        }
        return respond(request, 200, {
          kid: options.signKid ?? keyUrl(version),
          value: base64url(signature),
        });
      }
      return respond(request, 400, { error: { code: "BadParameter", message: "unexpected" } });
    },
  };
  return { httpClient, requests };
}

/** A credential that returns a fixed token, and counts the calls. */
export function staticCredential(): TokenCredential & { scopes: string[]; tenants: string[] } {
  const scopes: string[] = [];
  const tenants: string[] = [];
  return {
    scopes,
    tenants,
    getToken: async (scope, options): Promise<AccessToken> => {
      scopes.push(...[scope].flat());
      tenants.push(options?.tenantId ?? "");
      return await Promise.resolve({ token: TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 });
    },
  };
}
