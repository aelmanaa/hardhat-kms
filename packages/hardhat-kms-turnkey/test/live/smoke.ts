// The Turnkey smoke test's harness, shared by `turnkey.live.test.ts` and its offline tests:
//
// - `LiveRecorder` wraps `fetch`. It counts every sign submission by its body (a retry sends the
//   same body, which Turnkey answers with the same activity), refuses to send the one past the cap,
//   spaces requests for the Free plan's rate limit, notes a used-up quota, and records what each
//   answer looked like: statuses, error codes, the form of `r`, `s`, `v` and of a signed
//   transaction, whether `s` was high, and the latency. It records no value.
// - `runCase` runs one case and turns its failure into a redacted message, or into "quota used up"
//   once Turnkey has refused a signature for the monthly quota.
// - `liveRedactor` removes the API key, the organization id, the other two accounts, activity ids
//   and any long hex from a message.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { fromRlp, type Hex, parseTransaction } from "viem";

/** At most this many sign requests per run: the 12th is never sent. */
export const SIGNATURE_CAP = 11;

/** Turnkey's two sign submissions. Every new body sent to one counts as a signature. */
export const SIGN_PATHS: ReadonlySet<string> = new Set([
  "/public/v1/submit/sign_raw_payload",
  "/public/v1/submit/sign_transaction",
]);

/** The 429 code of a used-up monthly signing quota. */
const QUOTA_CODE = "SIGNING_QUOTA_EXCEEDED";

/** The Free plan allows 1 request a second; the recorder starts requests this far apart. */
export const REQUEST_GAP_MS = 1100;

const HALF_ORDER = secp256k1.Point.CURVE().n / 2n;

/** Thrown instead of sending the sign request past the cap. */
export class SignatureCapReached extends Error {
  public override readonly name = "SignatureCapReached";
}

/** What one raw-payload signature or signed transaction looked like. No value is kept. */
export interface SignFinding {
  kind: "raw-payload" | "transaction";
  /** Hex characters of `r` and `s` as Turnkey wrote them (raw payloads only). */
  rLength?: number;
  sLength?: number;
  /** `v` as Turnkey wrote it, such as `00` or `1b` (raw payloads only, one byte). */
  v?: string;
  /** Whether `r`, `s` or `signedTransaction` came back with `0x`. */
  prefixed: boolean;
  /** Whether `s` was above n/2 before the core normalized it. */
  highS: boolean;
  /** The signed transaction's type, as viem names it (transactions only). */
  transactionType?: string;
  /** A legacy transaction's `v`: EIP-155 (chainId * 2 + 35 + parity), 27/28, or other. */
  legacyV?: "eip155" | "27/28" | "other";
}

/** One request and its answer. */
export interface Exchange {
  case: string;
  /** The last part of the path, such as `sign_raw_payload`. */
  path: string;
  /** The HTTP status, or `not sent` for a request the cap refused. */
  status: number | "not sent";
  /** From the start of the request to the end of the answer's body, in milliseconds. */
  ms: number;
  /** Turnkey's `turnkeyErrorCode`, for an error answer. */
  code?: string;
  /** The activity's status, for an activity answer. */
  activity?: string;
  finding?: SignFinding;
}

/** A case's result. */
export type CaseOutcome =
  | { kind: "passed"; note?: string }
  | { kind: "skipped"; reason: string }
  | { kind: "quota" }
  | { kind: "failed"; message: string };

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/** A JSON body, or `undefined`. */
function jsonOf(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

/** The first safe `turnkeyErrorCode` of an error answer or of a failed activity. */
function codeOf(details: unknown): string | undefined {
  if (!Array.isArray(details)) {
    return undefined;
  }
  for (const detail of details) {
    const code = field(detail, "turnkeyErrorCode");
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
      return code;
    }
  }
  return undefined;
}

/** Strings that name a Turnkey enum, which a scrubbed answer keeps. */
const ENUM_PREFIXES = [
  "ACTIVITY_",
  "PAYLOAD_ENCODING_",
  "HASH_FUNCTION_",
  "TRANSACTION_TYPE_",
  "SIGNATURE_SCHEME_",
  "API_KEY_CURVE_",
  "CURVE_",
  "ADDRESS_FORMAT_",
  "PATH_FORMAT_",
];

/**
 * An answer's shape with every value replaced, to tighten the stub: objects keep their keys,
 * arrays their first element's shape, enum strings stay, other strings become `<string:N>`,
 * numbers `<number>`.
 *
 * @param value - A parsed answer.
 * @returns Its scrubbed shape.
 */
export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [scrub(value[0])];
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
  }
  if (typeof value === "string") {
    return /^[A-Z][A-Z0-9_]*$/.test(value) &&
      ENUM_PREFIXES.some((prefix) => value.startsWith(prefix))
      ? value
      : `<string:${value.length}>`;
  }
  if (typeof value === "number") {
    return "<number>";
  }
  return value;
}

/** What a completed raw-payload result looked like. */
function rawPayloadFinding(result: unknown): SignFinding | undefined {
  const signature = field(result, "signRawPayloadResult");
  const r = field(signature, "r");
  const s = field(signature, "s");
  const v = field(signature, "v");
  if (typeof r !== "string" || typeof s !== "string" || typeof v !== "string") {
    return undefined;
  }
  const sHex = s.replace(/^0x/i, "");
  const highS = /^[0-9a-fA-F]{1,64}$/.test(sHex) && BigInt(`0x${sHex}`) > HALF_ORDER;
  return {
    kind: "raw-payload",
    rLength: r.length,
    sLength: s.length,
    v: /^[0-9a-fA-F]{1,4}$/.test(v) ? v : "other",
    prefixed: r.startsWith("0x") || s.startsWith("0x"),
    highS,
  };
}

/** What a completed sign_transaction result looked like. */
function transactionFinding(result: unknown): SignFinding | undefined {
  const signed = field(field(result, "signTransactionResult"), "signedTransaction");
  if (typeof signed !== "string") {
    return undefined;
  }
  const prefixed = signed.startsWith("0x");
  const hex = prefixed ? signed.slice(2) : signed;
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) {
    return { kind: "transaction", prefixed, highS: false, transactionType: "not hex" };
  }
  try {
    const parsed = parseTransaction(`0x${hex}`);
    const s = parsed.s === undefined ? 0n : BigInt(parsed.s);
    const finding: SignFinding = {
      kind: "transaction",
      prefixed,
      highS: s > HALF_ORDER,
      transactionType: parsed.type ?? "unknown",
    };
    if (parsed.type === "legacy" && parsed.chainId !== undefined) {
      finding.legacyV = legacyV(`0x${hex}`, parsed.chainId);
    }
    return finding;
  } catch {
    return { kind: "transaction", prefixed, highS: false, transactionType: "unparsed" };
  }
}

/**
 * The form of a signed legacy transaction's `v`, read from its RLP: EIP-155 (chainId * 2 + 35 +
 * parity), 27/28, or other.
 *
 * @param raw - The signed legacy transaction.
 * @param chainId - The chain it was signed for.
 * @returns The form.
 */
export function legacyV(raw: Hex, chainId: number): "eip155" | "27/28" | "other" {
  const fields = fromRlp(raw, "hex");
  const v = Array.isArray(fields) ? fields[6] : undefined;
  if (typeof v !== "string") {
    return "other";
  }
  const value = v === "0x" ? 0n : BigInt(v);
  const base = BigInt(chainId) * 2n + 35n;
  if (value === base || value === base + 1n) {
    return "eip155";
  }
  return value === 27n || value === 28n ? "27/28" : "other";
}

/** Options of the recorder; tests shorten the gap and replace the clock. */
export interface RecorderOptions {
  cap?: number;
  gapMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Wraps `fetch` for a smoke run: the signature cap, the request gap and the findings. */
export class LiveRecorder {
  /** The case the next requests belong to. */
  public current = "setup";
  public readonly exchanges: Exchange[] = [];
  /** One scrubbed answer per activity status and per error status, first seen. */
  public readonly shapes: Map<string, unknown> = new Map();
  /** Set once Turnkey answers 429 SIGNING_QUOTA_EXCEEDED. */
  public quotaUsedUp = false;
  /** Sign requests the cap refused. */
  public refused = 0;
  public readonly cap: number;
  readonly #inner: typeof fetch;
  readonly #bodies = new Set<string>();
  readonly #gapMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #lastStart = Number.NEGATIVE_INFINITY;

  public constructor(inner: typeof fetch, options: RecorderOptions = {}) {
    this.#inner = inner;
    this.cap = options.cap ?? SIGNATURE_CAP;
    this.#gapMs = options.gapMs ?? REQUEST_GAP_MS;
    this.#now = options.now ?? (() => performance.now());
    this.#sleep =
      options.sleep ??
      (async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
  }

  /** Sign requests sent so far: distinct bodies sent to a sign submission. */
  public get signatures(): number {
    return this.#bodies.size;
  }

  /** The wrapped `fetch`. */
  public readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? init.body : "";
    const path = url.pathname.split("/").at(-1) ?? "";
    if (SIGN_PATHS.has(url.pathname) && !this.#bodies.has(body)) {
      if (this.#bodies.size >= this.cap) {
        this.refused++;
        this.exchanges.push({ case: this.current, path, status: "not sent", ms: 0 });
        throw new SignatureCapReached(
          `the run already sent ${this.#bodies.size} sign requests, the cap; the next one was not sent`,
        );
      }
      this.#bodies.add(body);
    }
    const wait = this.#lastStart + this.#gapMs - this.#now();
    if (wait > 0) {
      await this.#sleep(wait);
    }
    const started = this.#now();
    this.#lastStart = started;
    const response = await this.#inner(input, init);
    const text = await response.clone().text();
    const ms = Math.round(this.#now() - started);
    this.#record(path, response.status, ms, jsonOf(text));
    return response;
  };

  #record(path: string, status: number, ms: number, json: unknown): void {
    const exchange: Exchange = { case: this.current, path, status, ms };
    if (status < 200 || status >= 300) {
      const code = codeOf(field(json, "details"));
      if (code !== undefined) {
        exchange.code = code;
      }
      if (status === 429 && code === QUOTA_CODE) {
        this.quotaUsedUp = true;
      }
      this.#shape(`HTTP ${status}`, json);
    }
    const activity = field(json, "activity");
    const activityStatus = field(activity, "status");
    if (typeof activityStatus === "string") {
      exchange.activity = activityStatus;
      this.#shape(
        `${field(activity, "type") === undefined ? "" : String(field(activity, "type"))} ${activityStatus}`,
        json,
      );
      const failed = codeOf(field(field(activity, "failure"), "details"));
      if (failed !== undefined) {
        exchange.code = failed;
      }
      const result = field(activity, "result");
      const finding = rawPayloadFinding(result) ?? transactionFinding(result);
      if (finding !== undefined) {
        exchange.finding = finding;
      }
    }
    this.exchanges.push(exchange);
  }

  #shape(key: string, json: unknown): void {
    if (json !== undefined && !this.shapes.has(key)) {
      this.shapes.set(key, scrub(json));
    }
  }
}

/** The messages of an error and of its causes, one per line. */
export function errorText(error: unknown): string {
  const lines: string[] = [];
  for (let cause: unknown = error; cause !== undefined;) {
    if (cause instanceof Error) {
      lines.push(`${cause.name}: ${cause.message}`);
      cause = cause.cause;
    } else {
      lines.push(typeof cause === "string" ? cause : JSON.stringify(cause));
      cause = undefined;
    }
  }
  return lines.join("\n");
}

/** The variables the smoke test reads. */
export const VARIABLES = {
  apiPrivateKey: "TURNKEY_API_PRIVATE_KEY",
  organizationId: "TURNKEY_ORGANIZATION_ID",
  address: "HARDHAT_KMS_LIVE_TURNKEY_ADDRESS",
  denied: "HARDHAT_KMS_LIVE_TURNKEY_DENIED_ADDRESS",
  consensus: "HARDHAT_KMS_LIVE_TURNKEY_CONSENSUS_ADDRESS",
} as const;

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Builds the redaction of the smoke test's failures and logs. It removes, by value and in any
 * case, the API private key, the organization id and the denied and consensus accounts (with and
 * without `0x`), and extra values such as the derived API public key; then any UUID (activity and
 * user ids), and any run of 64 or more hex characters, with or without `0x` (keys, `r` and `s`,
 * signed transactions). The pinned account stays: errors name it on purpose.
 *
 * @param env - The environment, normally `process.env`.
 * @param extra - More values to remove, such as the derived API public key.
 * @returns The redaction.
 */
export function liveRedactor(
  env: Readonly<Record<string, string | undefined>>,
  extra: readonly string[] = [],
): (text: string) => string {
  const value = (name: string): string => env[name]?.trim() ?? "";
  const accounts = [value(VARIABLES.denied), value(VARIABLES.consensus)].flatMap((account) =>
    account === "" ? [] : [account, account.replace(/^0x/i, "")],
  );
  const secrets = [
    value(VARIABLES.apiPrivateKey),
    value(VARIABLES.organizationId),
    ...accounts,
    ...extra,
  ]
    .filter((item) => item.length >= 8)
    .toSorted((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const secret of secrets) {
      out = out.replaceAll(new RegExp(escapeRegExp(secret), "gi"), "<redacted>");
    }
    return out
      .replaceAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
      .replaceAll(/(?:0x)?[0-9a-f]{64,}/gi, "<hex>");
  };
}

/**
 * Runs one case. A failure becomes its redacted text, or "quota used up" once Turnkey has refused a
 * signature for the monthly quota; after that, every case is skipped without sending anything.
 *
 * @param recorder - The run's recorder, which knows whether the quota is used up.
 * @param name - The case's name, for the recorder.
 * @param redact - The run's redaction.
 * @param step - The case; it returns a note, or `{ skip }` when it chose not to run.
 * @returns The outcome.
 */
export async function runCase(
  recorder: LiveRecorder,
  name: string,
  redact: (text: string) => string,
  step: () => Promise<string | { skip: string } | undefined>,
): Promise<CaseOutcome> {
  if (recorder.quotaUsedUp) {
    return { kind: "quota" };
  }
  recorder.current = name;
  try {
    const note = await step();
    if (typeof note === "object") {
      return { kind: "skipped", reason: note.skip };
    }
    return note === undefined ? { kind: "passed" } : { kind: "passed", note };
  } catch (error) {
    if (recorder.quotaUsedUp) {
      return { kind: "quota" };
    }
    const capped =
      recorder.refused > 0
        ? ` (the run refused a sign request past the cap of ${recorder.cap})`
        : "";
    return { kind: "failed", message: redact(`${errorText(error)}${capped}`) };
  } finally {
    recorder.current = "between cases";
  }
}
