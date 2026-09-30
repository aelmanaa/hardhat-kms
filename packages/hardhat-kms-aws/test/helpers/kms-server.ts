import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";

import { secp256k1 } from "@noble/curves/secp256k1.js";

import { KEY_ARN, spkiDer } from "./fake-aws-kms.ts";

/** A request the local KMS endpoint received. */
export interface KmsRequest {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** A running local KMS endpoint. */
export interface KmsServer {
  url: string;
  requests: KmsRequest[];
  close(): Promise<void>;
}

/**
 * Serves the two KMS operations the adapter calls, GetPublicKey and Sign, over the AWS JSON 1.1
 * protocol the real SDK speaks, for one secp256k1 key.
 *
 * @param secretKey - The key's private key.
 * @returns The server; close it when done.
 */
export async function startKmsServer(secretKey: Uint8Array): Promise<KmsServer> {
  const requests: KmsRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const body = typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
      requests.push({ headers: request.headers, body });
      const target = request.headers["x-amz-target"];
      let answer: Record<string, unknown>;
      if (target === "TrentService.GetPublicKey") {
        answer = {
          KeyId: KEY_ARN,
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY",
          SigningAlgorithms: ["ECDSA_SHA_256"],
          PublicKey: Buffer.from(spkiDer(secretKey)).toString("base64"),
        };
      } else if (target === "TrentService.Sign") {
        const message: unknown = Reflect.get(body, "Message");
        const digest = Buffer.from(typeof message === "string" ? message : "", "base64");
        const signature = secp256k1.sign(digest, secretKey, { prehash: false, format: "der" });
        answer = {
          KeyId: Reflect.get(body, "KeyId"),
          SigningAlgorithm: Reflect.get(body, "SigningAlgorithm"),
          Signature: Buffer.from(signature).toString("base64"),
        };
      } else {
        response.writeHead(400, { "content-type": "application/x-amz-json-1.1" });
        response.end(JSON.stringify({ __type: "UnknownOperationException" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
      response.end(JSON.stringify(answer));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the server has no TCP address");
  }
  const { port } = address;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
