import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";

import * as kms from "@google-cloud/kms";
import { JWT } from "google-auth-library";
import gax from "google-gax";
import { crc32c } from "hardhat-kms/provider-utils";

import type { GaxModule, GcpClientOptions, GcpKmsSdk } from "../../src/internal/adapter.ts";
import { signDer, spkiPem } from "./fake-gcp-kms.ts";

/** A request the local KMS endpoint received. */
export interface KmsRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** Faults the server can inject, for the next answers. */
export interface ServerFaults {
  /** Answer this many sign requests with a wrong `signatureCrc32c`. */
  corruptSignatureCrc32c: number;
  /** Treat this many sign requests as if their digest arrived corrupted. */
  corruptDigest: number;
  /** Return these bytes instead of a DER signature, with a matching checksum. */
  signature?: Uint8Array | undefined;
  /** Answer every request with this error, as Cloud KMS reports one over REST. */
  error?: { http: number; status: string; message: string } | undefined;
}

/** A running local KMS endpoint. */
export interface KmsServer {
  port: number;
  requests: KmsRequest[];
  faults: ServerFaults;
  close(): Promise<void>;
}

/** Sends a JSON answer. */
function send(response: ServerResponse, status: number, answer: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(answer));
}

const PUBLIC_KEY = /^\/v1\/(projects\/.+\/cryptoKeyVersions\/\d+)\/publicKey$/;
const SIGN = /^\/v1\/(projects\/.+\/cryptoKeyVersions\/\d+):asymmetricSign$/;

/**
 * Serves the two Cloud KMS methods the adapter calls, GetPublicKey and AsymmetricSign, over the
 * REST protocol the real SDK speaks with `fallback: true`, for one secp256k1 key. Like the real
 * service, it checks `digestCrc32c`: a wrong checksum is refused with INVALID_ARGUMENT, and a
 * missing one gives `verifiedDigestCrc32c: false`. Every signature comes back high-S, which the
 * plugin must fold.
 *
 * @param secretKey - The key's private key.
 * @returns The server; close it when done.
 */
export async function startKmsServer(secretKey: Uint8Array): Promise<KmsServer> {
  const requests: KmsRequest[] = [];
  const faults: ServerFaults = { corruptSignatureCrc32c: 0, corruptDigest: 0 };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const parsed: unknown = text === "" ? {} : JSON.parse(text);
      const body = typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      requests.push({ method: request.method ?? "", path, headers: request.headers, body });
      if (faults.error !== undefined) {
        const { http, status, message } = faults.error;
        send(response, http, { error: { code: http, message, status } });
        return;
      }
      const publicKey = PUBLIC_KEY.exec(path);
      if (request.method === "GET" && publicKey !== null) {
        const pem = spkiPem(secretKey);
        send(response, 200, {
          name: publicKey[1],
          pem,
          // Numeric enums, as the SDK asks for with `$alt=json;enum-encoding=int`.
          algorithm: 31,
          pemCrc32c: String(crc32c(new TextEncoder().encode(pem))),
          protectionLevel: 2,
        });
        return;
      }
      const sign = SIGN.exec(path);
      if (request.method === "POST" && sign !== null) {
        const encoded: unknown = Reflect.get(Object(Reflect.get(body, "digest")), "sha256");
        const digest = Buffer.from(typeof encoded === "string" ? encoded : "", "base64");
        const sent: unknown = Reflect.get(body, "digestCrc32c");
        const checksum = typeof sent === "string" ? sent : undefined;
        // As if the digest had been corrupted on its way: the checksum no longer matches it.
        const corruptDigest = faults.corruptDigest > 0;
        faults.corruptDigest -= corruptDigest ? 1 : 0;
        if (checksum !== undefined && (corruptDigest || checksum !== String(crc32c(digest)))) {
          send(response, 400, {
            error: {
              code: 400,
              message:
                "The checksum in field digest_crc32c did not match the data in field digest.",
              status: "INVALID_ARGUMENT",
            },
          });
          return;
        }
        const signature = faults.signature ?? signDer(secretKey, digest, true);
        const corrupt = faults.corruptSignatureCrc32c > 0;
        faults.corruptSignatureCrc32c -= corrupt ? 1 : 0;
        send(response, 200, {
          name: sign[1],
          signature: Buffer.from(signature).toString("base64"),
          signatureCrc32c: String((crc32c(signature) ^ (corrupt ? 1 : 0)) >>> 0),
          verifiedDigestCrc32c: checksum !== undefined,
          protectionLevel: 2,
        });
        return;
      }
      send(response, 404, { error: { code: 404, message: "not found", status: "NOT_FOUND" } });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the server has no TCP address");
  }
  return {
    port: address.port,
    requests,
    faults,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/**
 * The real @google-cloud/kms, with every client pointed at a local server: plain HTTP, and a
 * throwaway service account whose self-signed tokens need no network. The adapter's own client
 * options, such as `fallback`, are kept.
 *
 * @param port - The local server's port.
 * @returns The SDK, to pass to the `kms` hook handlers.
 */
export function localSdk(port: number): GcpKmsSdk {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  class KeyManagementServiceClient extends kms.KeyManagementServiceClient {
    public constructor(options: GcpClientOptions, gaxModule?: GaxModule) {
      const authClient = new JWT({
        email: "hardhat-kms-test@example.iam.gserviceaccount.com",
        key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });
      super(
        { ...options, apiEndpoint: "127.0.0.1", port, protocol: "http", authClient },
        gaxModule,
      );
    }
  }
  return { KeyManagementServiceClient, gax };
}

/** Settings that would let a developer's or runner's Google Cloud setup change how the SDK connects. */
const CLEARED = [
  "GOOGLE_CLOUD_UNIVERSE_DOMAIN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
];

/**
 * Clears settings that would send the SDK's requests anywhere but the local server.
 *
 * @returns A function that restores the previous environment.
 */
export function isolateGcpEnvironment(): () => void {
  const saved = { ...process.env };
  for (const name of CLEARED) {
    Reflect.deleteProperty(process.env, name);
  }
  return () => {
    process.env = saved;
  };
}
