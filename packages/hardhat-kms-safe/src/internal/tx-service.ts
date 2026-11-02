import { catalogError } from "hardhat-kms/provider-utils";
import type { Address, Hex } from "viem";

import { ERRORS } from "./error-catalog.ts";
import type { SafeTransaction } from "./safe-tx.ts";

/** How long a request to the service may take, unless `timeoutMs` says otherwise. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** How to reach a Transaction Service. */
export interface TransactionServiceOptions {
  /**
   * The service's root, without `/api`: `https://api.safe.global/tx-service/<shortName>` for
   * Safe's hosted service, or the root of a self-hosted one.
   */
  url: string;
  /** The API key, sent as `Authorization: Bearer <key>` and nowhere else. */
  apiKey?: string | undefined;
  /** How long each request may take, in milliseconds; 30000 by default. */
  timeoutMs?: number | undefined;
  /** The `fetch` to call; the global one by default. */
  fetch?: typeof globalThis.fetch | undefined;
}

/**
 * The body of `POST /api/v2/safes/{safe}/multisig-transactions/`, as Safe's api-kit 5.0.4 sends
 * it: the `SafeTransactionData` fields in the order protocol-kit 8 builds them
 * (`standardizeSafeTransactionData`), then the hash, the sender, the signature and the origin.
 * Amounts are decimal strings and the nonce is a number, as in `SafeTransactionData`.
 */
export interface ProposalBody {
  to: Address;
  value: string;
  data: Hex;
  operation: number;
  baseGas: string;
  gasPrice: string;
  gasToken: Address;
  refundReceiver: Address;
  nonce: number;
  safeTxGas: string;
  contractTransactionHash: Hex;
  sender: Address;
  signature: Hex;
  origin?: string;
}

/**
 * Builds the proposal body.
 *
 * @param tx - The signed transaction.
 * @param hash - Its SafeTx hash.
 * @param sender - The owner that signed, checksummed.
 * @param signature - The owner's signature.
 * @param origin - A label the Safe app shows with the transaction; left out when `undefined`.
 * @returns The body.
 */
export function proposalBody(
  tx: SafeTransaction,
  hash: Hex,
  sender: Address,
  signature: Hex,
  origin: string | undefined,
): ProposalBody {
  return {
    to: tx.to,
    value: tx.value.toString(),
    data: tx.data,
    operation: tx.operation,
    baseGas: tx.baseGas.toString(),
    gasPrice: tx.gasPrice.toString(),
    gasToken: tx.gasToken,
    refundReceiver: tx.refundReceiver,
    nonce: Number(tx.nonce),
    safeTxGas: tx.safeTxGas.toString(),
    contractTransactionHash: hash,
    sender,
    signature,
    ...(origin === undefined ? {} : { origin }),
  };
}

/**
 * Whether a service URL is one the client sends to: https, or http on localhost or 127.0.0.1, with
 * no user name, password, query or fragment.
 *
 * @param url - The URL.
 * @returns Whether it is acceptable.
 */
export function isServiceUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  return (
    (parsed.protocol === "https:" || (parsed.protocol === "http:" && local)) &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    !url.includes("?") &&
    !url.includes("#")
  );
}

/** Printable ASCII, so a reason the service sends cannot add lines or terminal escapes. */
function printable(text: string, max: number): string {
  const cleaned = text.replace(/[^\x20-\x7e]/g, "?").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/**
 * The reasons of a 400 or 422, from allow-listed fields only: `nonFieldErrors` and `message`,
 * cut to printable text, and the names of the fields the service refused, without their text.
 *
 * @param body - The parsed answer.
 * @returns The reasons, joined; `no reason given` when there is none.
 */
export function refusalReasons(body: unknown): string {
  const reasons: string[] = [];
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const nonField: unknown = Reflect.get(body, "nonFieldErrors");
    if (Array.isArray(nonField)) {
      for (const reason of nonField.slice(0, 3)) {
        if (typeof reason === "string") {
          reasons.push(printable(reason, 300));
        }
      }
    }
    const message: unknown = Reflect.get(body, "message");
    if (typeof message === "string") {
      reasons.push(printable(message, 120));
    }
    const fields = Object.keys(body).filter(
      (key) =>
        key !== "nonFieldErrors" &&
        key !== "message" &&
        /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) &&
        Array.isArray(Reflect.get(body, key)),
    );
    if (fields.length > 0) {
      reasons.push(`refused fields: ${fields.slice(0, 10).join(", ")}`);
    }
  }
  return reasons.length === 0 ? "no reason given" : reasons.join("; ");
}

/** A request the client makes, with the words the errors use for it. */
interface ServiceRequest {
  method: "GET" | "POST";
  path: string;
  what: string;
  /** Whether the key signed before this request: the errors then say what became of the proposal. */
  signed: boolean;
  body?: ProposalBody;
}

/** What an error adds about the signature: nothing was signed yet, or what became of it. */
function signedNote(request: ServiceRequest, mayBeStored: boolean): string {
  if (!request.signed) {
    return ". Nothing was signed";
  }
  return mayBeStored
    ? ". The key signed the SafeTx; check the Safe app before you propose it again"
    : ". The key signed the SafeTx, and the service did not store it";
}

/**
 * A client for the two calls the proposer makes to a Safe Transaction Service: the highest queued
 * nonce and the proposal. It uses the global `fetch` with a timeout, never follows a redirect, and
 * puts neither the API key nor the service's answer in an error, apart from the allow-listed
 * reasons of a 400 or 422.
 */
export class TransactionServiceClient {
  readonly #url: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  /**
   * @param options - Where the service is and how to reach it.
   */
  public constructor(options: TransactionServiceOptions) {
    if (!isServiceUrl(options.url)) {
      throw catalogError(ERRORS.badServiceUrl, {});
    }
    this.#url = options.url.replace(/\/+$/, "");
    this.#apiKey = options.apiKey === "" ? undefined : options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** The service's root, without a trailing slash. */
  public get url(): string {
    return this.#url;
  }

  async #send(request: ServiceRequest, signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.#apiKey !== undefined) {
      headers.Authorization = `Bearer ${this.#apiKey}`;
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${this.#url}${request.path}`, {
        method: request.method,
        headers,
        // A redirect would carry the API key and the signed proposal to another host.
        redirect: "manual",
        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      text = await response.text();
    } catch (error) {
      throw catalogError(ERRORS.unreachable, {
        request: request.what,
        why: timeout.aborted ? ` within ${this.#timeoutMs} ms` : failureCode(error),
        signed: signedNote(request, true),
      });
    }
    const { status } = response;
    if (status >= 200 && status <= 299) {
      if (text === "") {
        return undefined;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        return parsed;
      } catch {
        return undefined;
      }
    }
    if (status === 401 || status === 403) {
      throw catalogError(ERRORS.unauthorized, {
        status,
        request: request.what,
        signed: signedNote(request, false),
      });
    }
    if (status === 400 || status === 422) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      throw catalogError(ERRORS.rejected, {
        status,
        request: request.what,
        reasons: refusalReasons(parsed),
        signed: signedNote(request, false),
      });
    }
    if (status === 429) {
      throw catalogError(ERRORS.rateLimited, {
        request: request.what,
        signed: signedNote(request, false),
      });
    }
    if (status >= 500) {
      throw catalogError(ERRORS.serverError, {
        status,
        request: request.what,
        signed: signedNote(request, true),
      });
    }
    throw catalogError(ERRORS.unexpectedStatus, {
      status,
      request: request.what,
      signed: signedNote(request, status < 400),
    });
  }

  /**
   * The highest nonce among the Safe's queued transactions from `fromNonce` on, as api-kit's
   * `getPendingTransactions` asks for them, sorted so that the first one is the highest.
   *
   * @param safe - The Safe, checksummed.
   * @param fromNonce - The Safe's on-chain nonce: lower nonces have run.
   * @param signal - Stops the request.
   * @returns The highest queued nonce, or `undefined` when nothing is queued.
   */
  public async highestQueuedNonce(
    safe: Address,
    fromNonce: bigint,
    signal?: AbortSignal,
  ): Promise<bigint | undefined> {
    const request: ServiceRequest = {
      method: "GET",
      path: `/api/v2/safes/${safe}/multisig-transactions/?executed=false&nonce__gte=${fromNonce}&ordering=-nonce&limit=1`,
      what: "the list of queued transactions",
      signed: false,
    };
    const page = await this.#send(request, signal);
    const results: unknown =
      typeof page === "object" && page !== null ? Reflect.get(page, "results") : undefined;
    if (!Array.isArray(results)) {
      throw catalogError(ERRORS.badResponse, { request: request.what });
    }
    if (results.length === 0) {
      return undefined;
    }
    const first: unknown = results[0];
    const nonce: unknown =
      typeof first === "object" && first !== null ? Reflect.get(first, "nonce") : undefined;
    if (typeof nonce === "number" && Number.isSafeInteger(nonce) && nonce >= 0) {
      return BigInt(nonce);
    }
    if (typeof nonce === "string" && /^\d{1,78}$/.test(nonce)) {
      return BigInt(nonce);
    }
    throw catalogError(ERRORS.badResponse, { request: request.what });
  }

  /**
   * Posts a signed proposal. The service answers 201 with an empty body.
   *
   * @param safe - The Safe, checksummed.
   * @param body - The proposal, as `proposalBody` builds it.
   * @param signal - Stops the request.
   */
  public async propose(safe: Address, body: ProposalBody, signal?: AbortSignal): Promise<void> {
    await this.#send(
      {
        method: "POST",
        path: `/api/v2/safes/${safe}/multisig-transactions/`,
        what: "the proposal",
        signed: true,
        body,
      },
      signal,
    );
  }
}

/**
 * A short code for a failed `fetch`, such as ` (ECONNREFUSED)`, from the error's `cause.code` when
 * it looks like a system error code. Nothing else of the error is shown: its text can carry the
 * URL.
 *
 * @param error - What `fetch` threw.
 * @returns The code in parentheses with a leading space, or an empty string.
 */
function failureCode(error: unknown): string {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code: unknown =
    typeof cause === "object" && cause !== null ? Reflect.get(cause, "code") : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? ` (${code})` : "";
}
