// A stand-in for Turnkey's API. It checks each request's X-Stamp against the configured API
// public key, signs with a secp256k1 test key as Turnkey would, and keeps one activity per body, as
// Turnkey's fingerprint does. Unit tests call it as `fetch`; integration tests serve it over HTTP
// with `listen()`. Tests queue other answers with `answer()`.
import { createServer, type Server } from "node:http";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { typedDataDigest } from "../../../hardhat-kms/src/internal/crypto/digests.ts";
import { STAMP_HEADER, verifyStamp } from "../../src/internal/stamp.ts";

export const SIGN_PATH = "/public/v1/submit/sign_raw_payload";
export const POLL_PATH = "/public/v1/query/get_activity";
export const SIGN_TYPE = "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2";

const CURVE_ORDER = secp256k1.Point.CURVE().n;

/** One request the stub received. */
export interface StubRequest {
  path: string;
  body: string;
  stamp: string | undefined;
  /** The stamp verified against the configured API public key. */
  stamped: boolean;
  redirect: string | undefined;
}

/** An answer: a status and a JSON body, or a body that is not JSON. */
export interface StubAnswer {
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/** What the stub does with a signing request it answers itself. */
export type SignMode =
  /** A low-s signature from the configured key, with the right `v`. */
  | "good"
  /** The same signature with s replaced by n - s, and `v` flipped to match. */
  | "high-s"
  /** The right signature with the wrong `v`. */
  | "wrong-v"
  /** A signature from another key. */
  | "foreign";

export interface StubOptions {
  organizationId: string;
  /** The compressed API public key every stamp must verify with. */
  apiPublicKey: string;
  /** The secp256k1 key the stub signs with. */
  secretKey: Uint8Array;
}

function hexBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/** A Turnkey error answer, in Turnkey's shape. */
export function turnkeyError(status: number, code?: string, message = "an error"): StubAnswer {
  return {
    status,
    json: {
      code: 3,
      message,
      details:
        code === undefined
          ? []
          : [
              {
                "@type": "type.googleapis.com/errors.v1.TurnkeyErrorDetail",
                turnkeyErrorCode: code,
              },
            ],
    },
  };
}

/** The digest Turnkey signs for a sign_raw_payload request, as it reads the parameters. */
function digestOf(parameters: unknown): Uint8Array {
  const payload = field(parameters, "payload");
  const encoding = field(parameters, "encoding");
  const hashFunction = field(parameters, "hashFunction");
  if (typeof payload !== "string") {
    throw new Error("no payload");
  }
  if (encoding === "PAYLOAD_ENCODING_EIP712" && hashFunction === "HASH_FUNCTION_NO_OP") {
    const parsed: unknown = JSON.parse(payload);
    const types = field(parsed, "types");
    const primaryType = field(parsed, "primaryType");
    const domain = field(parsed, "domain");
    const message = field(parsed, "message");
    if (
      typeof types !== "object" ||
      types === null ||
      typeof primaryType !== "string" ||
      typeof domain !== "object" ||
      domain === null ||
      typeof message !== "object" ||
      message === null
    ) {
      throw new Error("not typed data");
    }
    return typedDataDigest({
      types: Object.fromEntries(Object.entries(types)),
      primaryType,
      domain: Object.fromEntries(Object.entries(domain)),
      message: Object.fromEntries(Object.entries(message)),
    });
  }
  if (encoding !== "PAYLOAD_ENCODING_HEXADECIMAL" || !/^(?:[0-9a-f]{2})+$/.test(payload)) {
    throw new Error("not hex");
  }
  if (hashFunction === "HASH_FUNCTION_KECCAK256") {
    return keccak_256(hexBytes(payload));
  }
  if (hashFunction === "HASH_FUNCTION_NO_OP" && payload.length === 64) {
    return hexBytes(payload);
  }
  throw new Error("unknown hash function");
}

/** A stand-in for Turnkey's API. */
export class TurnkeyStub {
  readonly requests: StubRequest[] = [];
  /** How the stub signs the requests it answers itself. */
  mode: SignMode = "good";
  /** How many polls an activity stays pending, when `pending` is set. */
  pendingPolls = 0;
  /** The status the stub's own submissions answer with first: COMPLETED unless set. */
  firstStatus = "ACTIVITY_STATUS_COMPLETED";
  readonly #options: StubOptions;
  readonly #queue: Array<StubAnswer | ((request: StubRequest) => StubAnswer)> = [];
  readonly #activities = new Map<string, { id: string; body: unknown; polls: number }>();
  #server: Server | undefined;
  #nextId = 1;

  public constructor(options: StubOptions) {
    this.#options = options;
  }

  /** Queues answers for the next requests, in order; later requests get the stub's own. */
  public answer(...answers: Array<StubAnswer | ((request: StubRequest) => StubAnswer)>): void {
    this.#queue.push(...answers);
  }

  /** The parsed bodies of the requests to a path. */
  public bodies(path: string = SIGN_PATH): unknown[] {
    return this.requests
      .filter((request) => request.path === path)
      .map((request): unknown => JSON.parse(request.body));
  }

  /** Answers one request. */
  public handle(
    path: string,
    body: string,
    stamp: string | undefined,
    redirect?: string,
  ): StubAnswer {
    const request: StubRequest = {
      path,
      body,
      stamp,
      stamped: stamp !== undefined && verifyStamp(stamp, body, this.#options.apiPublicKey),
      redirect,
    };
    this.requests.push(request);
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return typeof queued === "function" ? queued(request) : queued;
    }
    if (!request.stamped) {
      return turnkeyError(401, "SIGNATURE_INVALID");
    }
    const parsed: unknown = JSON.parse(body);
    if (field(parsed, "organizationId") !== this.#options.organizationId) {
      return turnkeyError(404, "ORGANIZATION_NOT_FOUND");
    }
    if (path === POLL_PATH) {
      return this.#poll(parsed);
    }
    if (path !== SIGN_PATH || field(parsed, "type") !== SIGN_TYPE) {
      return turnkeyError(400, "REQUEST_INVALID");
    }
    // One activity per body, as Turnkey's fingerprint keeps it.
    let activity = this.#activities.get(body);
    if (activity === undefined) {
      activity = {
        id: `00000000-0000-4000-8000-${String(this.#nextId++).padStart(12, "0")}`,
        body: parsed,
        polls: 0,
      };
      this.#activities.set(body, activity);
    }
    return { status: 200, json: this.#activityJson(activity, this.firstStatus) };
  }

  #poll(parsed: unknown): StubAnswer {
    const id = field(parsed, "activityId");
    const activity = [...this.#activities.values()].find((entry) => entry.id === id);
    if (activity === undefined) {
      return turnkeyError(404, "NOT_FOUND");
    }
    activity.polls++;
    const status =
      activity.polls > this.pendingPolls ? "ACTIVITY_STATUS_COMPLETED" : "ACTIVITY_STATUS_PENDING";
    return { status: 200, json: this.#activityJson(activity, status) };
  }

  #activityJson(activity: { id: string; body: unknown }, status: string): unknown {
    const base = {
      id: activity.id,
      organizationId: this.#options.organizationId,
      status,
      type: SIGN_TYPE,
      fingerprint: "sha256:0000",
    };
    if (status !== "ACTIVITY_STATUS_COMPLETED") {
      return { activity: base };
    }
    return {
      activity: {
        ...base,
        result: { signRawPayloadResult: this.#sign(field(activity.body, "parameters")) },
      },
    };
  }

  #sign(parameters: unknown): { r: string; s: string; v: string } {
    const digest = digestOf(parameters);
    const key = this.mode === "foreign" ? hexBytes("11".repeat(32)) : this.#options.secretKey;
    const signature = secp256k1.Signature.fromBytes(
      secp256k1.sign(digest, key, { prehash: false, lowS: true, format: "recovered" }),
      "recovered",
    );
    let { s } = signature;
    let parity = signature.recovery ?? 0;
    if (this.mode === "high-s") {
      s = CURVE_ORDER - s;
      parity ^= 1;
    }
    if (this.mode === "wrong-v") {
      parity ^= 1;
    }
    return {
      r: signature.r.toString(16).padStart(64, "0"),
      s: s.toString(16).padStart(64, "0"),
      v: parity === 0 ? "00" : "01",
    };
  }

  /** The stub as `fetch`, for unit tests. It honours the request's signal. */
  public readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? init.body : "";
    const stamp = new Headers(init?.headers).get(STAMP_HEADER) ?? undefined;
    const answer = this.handle(url.pathname, body, stamp, init?.redirect);
    return new Response(answer.text ?? JSON.stringify(answer.json), {
      status: answer.status,
      ...(answer.headers === undefined ? {} : { headers: answer.headers }),
    });
  };

  /** Serves the stub over HTTP on 127.0.0.1, and returns its base URL. */
  public async listen(): Promise<string> {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const stamp = request.headers["x-stamp"];
        const answer = this.handle(
          request.url ?? "",
          Buffer.concat(chunks).toString("utf8"),
          typeof stamp === "string" ? stamp : undefined,
        );
        response.writeHead(answer.status, {
          "content-type": "application/json",
          ...answer.headers,
        });
        response.end(answer.text ?? JSON.stringify(answer.json));
      });
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("no port");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  public async close(): Promise<void> {
    const server = this.#server;
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
