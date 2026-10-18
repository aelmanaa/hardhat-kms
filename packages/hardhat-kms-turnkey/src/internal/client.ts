import { setTimeout as delay } from "node:timers/promises";

import {
  catalogError,
  type ErrorEntry,
  kmsDebug,
  type TemplateParams,
} from "hardhat-kms/provider-utils";

import { SAFE_CODE } from "./activity.ts";
import { ERRORS } from "./error-catalog.ts";
import { type ApiKey, STAMP_HEADER, stampBody } from "./stamp.ts";

/*
 * Turnkey's HTTP API, on `fetch`, for one key. Turnkey's own client (`@turnkey/http` 6.7.0,
 * `TurnkeyClient.request`) takes no AbortSignal and does not retry, so the plugin sends the
 * requests itself:
 *
 * - Every request and every wait between attempts takes the call's signal, so the key's
 *   `timeoutMs` bounds the whole sign. No request starts after the signal aborts.
 * - `redirect: "manual"`, and any 3xx fails: the stamp covers the body, which must reach Turnkey
 *   and nothing else. `@turnkey/http` refuses redirects the same way.
 * - Retries resend the same body. A submission's body carries its `timestampMs`, and Turnkey
 *   hashes the body into a fingerprint and answers the same activity for the same fingerprint
 *   (https://docs.turnkey.com/api-reference/activities/overview, "idempotent"), so a retry never
 *   makes a second signature. Each attempt gets a new stamp, which the fingerprint does not cover.
 * - Turnkey sends no `Retry-After` (https://docs.turnkey.com/reference/rate-limits), so the
 *   plugin backs off on its own.
 * - Errors carry the HTTP status and Turnkey's `turnkeyErrorCode`, from `details`
 *   (https://docs.turnkey.com/api-reference/overview/errors), never Turnkey's `message`: it can
 *   name organizations.
 */

/** Turnkey's API. Users cannot change it; tests pass another one to the adapter factory. */
export const TURNKEY_API_URL = "https://api.turnkey.com";

/** At most this many attempts per request: the first and three retries. */
export const MAX_ATTEMPTS = 4;

/** The wait before the first retry, in milliseconds. It doubles before each later retry. */
export const FIRST_BACKOFF_MS = 250;

/** The 429 code for a monthly signing quota that is used up: never retried. */
const QUOTA_CODE = "SIGNING_QUOTA_EXCEEDED";

/** The 429 code for a rate limit: retried, as is a 429 without a code. */
const RATE_LIMIT_CODE = "RATE_LIMIT_EXCEEDED";

const log = kmsDebug("turnkey");

/** What the client needs from its environment. Tests replace each part. */
export interface Transport {
  /** Where Turnkey's API is, without a trailing slash. */
  baseUrl: string;
  fetch: typeof fetch;
  /** Waits `ms`, and rejects with the signal's reason when it aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** A number in [0, 1), for the backoff's jitter. */
  random(): number;
  /** The current time in milliseconds, for timings and `timestampMs`. */
  now(): number;
}

/** The transport the plugin uses: Turnkey's API, the global `fetch` and the system clock. */
export function defaultTransport(): Transport {
  return {
    baseUrl: TURNKEY_API_URL,
    fetch: globalThis.fetch,
    sleep: async (ms, signal) => {
      // node:timers rejects with its own AbortError; the call fails with the signal's reason.
      await delay(ms, undefined, { signal }).catch(() => {
        signal.throwIfAborted();
      });
    },
    random: Math.random,
    now: Date.now,
  };
}

/** One request's context. */
export interface RequestContext {
  signal: AbortSignal;
  /** What the request is for, such as `sign message`, for errors. */
  operation: string;
  /** The plugin's id for the call, for debug lines. */
  requestId: string;
  /** Text the 403 error adds after "with this address", naming what the request sent. */
  forbiddenHint: string;
  /**
   * Called right before each attempt's request leaves, after its stamp is made and the signal was
   * checked, so that the core knows Turnkey may have the request (`SignContext.requestSent`).
   */
  sent?: (() => void) | undefined;
}

/** Turnkey's error code from an error answer's `details`, when it is safe to show. */
function errorCode(body: unknown): string | undefined {
  const details: unknown =
    typeof body === "object" && body !== null ? Reflect.get(body, "details") : undefined;
  if (!Array.isArray(details)) {
    return undefined;
  }
  for (const detail of details) {
    const code: unknown =
      typeof detail === "object" && detail !== null
        ? Reflect.get(detail, "turnkeyErrorCode")
        : undefined;
    if (typeof code === "string" && SAFE_CODE.test(code)) {
      return code;
    }
  }
  return undefined;
}

/**
 * Whether an error answer refuses the request's time. Turnkey documents no code for it, only that
 * its message says the timestamp is not current or in the future. The message is read for this
 * test only, and never shown.
 */
function refusesTimestamp(body: unknown, code: string | undefined): boolean {
  if (code?.includes("TIMESTAMP") === true) {
    return true;
  }
  const message: unknown =
    typeof body === "object" && body !== null ? Reflect.get(body, "message") : undefined;
  return typeof message === "string" && /timestamp/i.test(message);
}

/** Why a request got no answer: the error's code, such as `ECONNREFUSED`, or its class name. */
function failureReason(error: unknown): string {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code: unknown =
    typeof cause === "object" && cause !== null ? Reflect.get(cause, "code") : undefined;
  if (typeof code === "string" && SAFE_CODE.test(code)) {
    return code;
  }
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "Error";
}

/** Whether an answer is a redirect, which the client refuses without reading its body. */
function isRedirect(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

/** A complete body as JSON, or `undefined` when it is not JSON. */
function jsonOf(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

/** The answer to one request: a 2xx status and its body, `undefined` when it is not JSON. */
export interface Answer {
  status: number;
  body: unknown;
}

/** Sends stamped requests to Turnkey for one key. */
export class TurnkeyClient {
  readonly #transport: Transport;
  readonly #apiKey: ApiKey;
  readonly #displayId: string;

  /**
   * @param transport - Where and how to send.
   * @param apiKey - The API key that stamps each request.
   * @param displayId - The key's display id, for errors.
   */
  public constructor(transport: Transport, apiKey: ApiKey, displayId: string) {
    this.#transport = transport;
    this.#apiKey = apiKey;
    this.#displayId = displayId;
  }

  /**
   * Sends a body to a path, retrying what may succeed on a second try with the same body.
   *
   * @param path - The API path, such as `/public/v1/submit/sign_raw_payload`.
   * @param body - The exact JSON body; every attempt sends these bytes.
   * @param ctx - The call's signal, id and 403 hint.
   * @returns The 2xx answer.
   * @throws The signal's reason once it aborts; otherwise a `turnkey.service.*` error.
   */
  public async send(path: string, body: string, ctx: RequestContext): Promise<Answer> {
    const { signal } = ctx;
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      const started = this.#transport.now();
      let response: Response;
      // `undefined` for a redirect, whose body the client never reads.
      let text: string | undefined;
      const stamp = stampBody(body, this.#apiKey);
      // Nothing between this and fetch awaits, so the signal cannot abort before the request
      // starts: once the core hears of it, the request may be at Turnkey.
      ctx.sent?.();
      try {
        response = await this.#transport.fetch(`${this.#transport.baseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [STAMP_HEADER]: stamp,
          },
          body,
          redirect: "manual",
          signal,
        });
        // A connection that breaks while the body arrives is a lost answer too: the attempt is
        // retried like one that got no headers, with the same bytes.
        text = isRedirect(response) ? undefined : await response.text();
      } catch (error) {
        signal.throwIfAborted();
        const reason = failureReason(error);
        log("%s %s: no answer (%s), attempt %d", ctx.requestId, path, reason, attempt);
        if (attempt < MAX_ATTEMPTS) {
          await this.#backOff(attempt, signal);
          continue;
        }
        throw this.#error(ctx.operation, ERRORS.unreachable, { attempts: attempt, reason });
      }
      const { status } = response;
      const elapsed = this.#transport.now() - started;
      if (text === undefined) {
        log("%s %s: HTTP %d in %d ms, a redirect", ctx.requestId, path, status, elapsed);
        throw this.#error(ctx.operation, ERRORS.redirected, {
          status: status === 0 ? "3xx" : String(status),
        });
      }
      const answer = jsonOf(text);
      if (response.ok) {
        log("%s %s: HTTP %d in %d ms", ctx.requestId, path, status, elapsed);
        return { status, body: answer };
      }
      const code = errorCode(answer);
      log(
        "%s %s: HTTP %d%s in %d ms",
        ctx.requestId,
        path,
        status,
        code === undefined ? "" : ` ${code}`,
        elapsed,
      );
      const shown = { status: code === undefined ? String(status) : `${status} ${code}` };
      const rateLimited = status === 429 && (code === undefined || code === RATE_LIMIT_CODE);
      if (status >= 500 || rateLimited) {
        if (attempt < MAX_ATTEMPTS) {
          await this.#backOff(attempt, signal);
          continue;
        }
        if (rateLimited) {
          throw this.#error(ctx.operation, ERRORS.throttled, { ...shown, attempts: attempt });
        }
        throw this.#error(ctx.operation, ERRORS.answered, shown);
      }
      throw this.#explain(status, code, answer, shown, ctx);
    }
  }

  /** The error for a final answer that no retry can change. */
  #explain(
    status: number,
    code: string | undefined,
    answer: unknown,
    shown: { status: string },
    ctx: RequestContext,
  ): Error {
    if ((status === 400 || status === 401) && refusesTimestamp(answer, code)) {
      return this.#error(ctx.operation, ERRORS.timestamp, shown);
    }
    switch (status) {
      case 400:
        return this.#error(ctx.operation, ERRORS.badRequest, shown);
      case 401:
        return this.#error(ctx.operation, ERRORS.unauthenticated, shown);
      case 403:
        return this.#error(ctx.operation, ERRORS.forbidden, {
          ...shown,
          request: ctx.forbiddenHint,
        });
      case 404:
        return this.#error(ctx.operation, ERRORS.notFound, shown);
      case 429:
        return code === QUOTA_CODE
          ? this.#error(ctx.operation, ERRORS.quota, shown)
          : this.#error(ctx.operation, ERRORS.answered, shown);
      default:
        return this.#error(ctx.operation, ERRORS.answered, shown);
    }
  }

  /** Waits before the next attempt: 250 ms, doubling, each wait between half and all of it. */
  async #backOff(attempt: number, signal: AbortSignal): Promise<void> {
    const base = FIRST_BACKOFF_MS * 2 ** (attempt - 1);
    await this.#transport.sleep(
      Math.round(base / 2 + (this.#transport.random() * base) / 2),
      signal,
    );
  }

  #error<Template extends string>(
    operation: string,
    entry: ErrorEntry<Template, "error">,
    params: TemplateParams<Template>,
  ): Error {
    return catalogError(entry, params, { provider: "turnkey", operation, key: this.#displayId });
  }
}
