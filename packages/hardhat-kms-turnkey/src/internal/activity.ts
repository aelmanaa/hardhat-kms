/*
 * Reads Turnkey's activity answers strictly, and fails closed. The shapes are `v1ActivityResponse`
 * and `v1Activity` of Turnkey's API (`@turnkey/http` 6.7.0, `public_api.types.d.ts`): an
 * `activity` with `id`, `organizationId`, `status`, `type`, `result.signRawPayloadResult.{r,s,v}`
 * and, when it failed, `failure.details[].turnkeyErrorCode`. The statuses are those of
 * `v1ActivityStatus` (https://docs.turnkey.com/api-reference/activities/overview).
 */

/** The activity type of a raw-payload signature. */
export const SIGN_RAW_PAYLOAD = "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2";

/** An activity id the plugin shows: a UUID, as Turnkey writes ids. */
const ACTIVITY_ID = /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

/** A Turnkey error code, as the plugin shows one. Anything else is not shown. */
export const SAFE_CODE: RegExp = /^[A-Z][A-Z0-9_]{0,63}$/;

/** `r` or `s`: a hex number of 1 to 32 bytes, without a prefix. */
const SCALAR_HEX = /^[0-9a-fA-F]{1,64}$/;

/** `v` as Turnkey may write the recovery id, with the parity each form means. */
const PARITY: ReadonlyMap<string, 0 | 1> = new Map([
  ["00", 0],
  ["01", 1],
  ["1b", 0],
  ["1c", 1],
]);

/** The statuses that end an activity, or keep it waiting. */
type Status =
  | "ACTIVITY_STATUS_CREATED"
  | "ACTIVITY_STATUS_PENDING"
  | "ACTIVITY_STATUS_COMPLETED"
  | "ACTIVITY_STATUS_FAILED"
  | "ACTIVITY_STATUS_REJECTED"
  | "ACTIVITY_STATUS_CONSENSUS_NEEDED"
  | "ACTIVITY_STATUS_AUTHENTICATORS_NEEDED";

/** Each status by its name, so that a string from an answer is looked up, not trusted. */
const STATUSES: ReadonlyMap<string, Status> = new Map(
  (
    [
      "ACTIVITY_STATUS_CREATED",
      "ACTIVITY_STATUS_PENDING",
      "ACTIVITY_STATUS_COMPLETED",
      "ACTIVITY_STATUS_FAILED",
      "ACTIVITY_STATUS_REJECTED",
      "ACTIVITY_STATUS_CONSENSUS_NEEDED",
      "ACTIVITY_STATUS_AUTHENTICATORS_NEEDED",
    ] as const
  ).map((status) => [status, status]),
);

/** What every activity has, whatever its status. */
interface ActivityFields {
  id: string;
  organizationId: string;
  type: string;
  /** The `result` or `failure` object, kept for the step that reads it. */
  result: unknown;
  failure: unknown;
}

/** An activity, as far as the plugin reads it, told apart by its status. */
export type Activity = { [S in Status]: ActivityFields & { status: S } }[Status];

/** An activity that has ended: the adapter polls the others. */
export type FinalActivity = Exclude<
  Activity,
  { status: "ACTIVITY_STATUS_PENDING" | "ACTIVITY_STATUS_CREATED" }
>;

/** What went wrong reading an answer. Fixed texts: no value from the answer is in them. */
export type Problem =
  | { kind: "malformed"; problem: string }
  | { kind: "mismatch"; field: "organization" | "activity type" | "activity" };

/** What the request expects the answer's activity to be. */
export interface Expected {
  /** The configured organization id. Turnkey ids are UUIDs, compared in any case. */
  organizationId: string;
  /** The activity id, when polling for one. */
  id?: string | undefined;
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/**
 * Reads the activity of an answer and checks that it is the one the request asked for.
 *
 * @param body - The answer's JSON body.
 * @param expected - The organization and, when polling, the activity id.
 * @returns The activity, or what is wrong with the answer.
 */
export function readActivity(body: unknown, expected: Expected): Activity | Problem {
  const activity = field(body, "activity");
  const id = field(activity, "id");
  const organizationId = field(activity, "organizationId");
  const type = field(activity, "type");
  const status = field(activity, "status");
  if (
    typeof id !== "string" ||
    typeof organizationId !== "string" ||
    typeof type !== "string" ||
    typeof status !== "string"
  ) {
    return {
      kind: "malformed",
      problem: "the answer has no activity with an id, an organization, a type and a status",
    };
  }
  if (organizationId.toLowerCase() !== expected.organizationId.toLowerCase()) {
    return { kind: "mismatch", field: "organization" };
  }
  if (type !== SIGN_RAW_PAYLOAD) {
    return { kind: "mismatch", field: "activity type" };
  }
  if (expected.id !== undefined && id !== expected.id) {
    return { kind: "mismatch", field: "activity" };
  }
  const known = STATUSES.get(status);
  if (known === undefined) {
    return { kind: "malformed", problem: "the activity has a status this plugin does not know" };
  }
  const fields: ActivityFields = {
    id,
    organizationId,
    type,
    result: field(activity, "result"),
    failure: field(activity, "failure"),
  };
  return { ...fields, status: known };
}

/** The signature of a completed activity, with the parity Turnkey reported. */
export interface RawSignature {
  r: bigint;
  s: bigint;
  yParity: 0 | 1;
}

/**
 * Reads the signature of a completed raw-payload activity. `r` and `s` must be 1 to 64 hex
 * characters, as the core range-checks them after; `v` must be `00`, `01`, `1b` or `1c`. The core
 * ignores the parity and finds it by recovery.
 *
 * @param result - The activity's `result`.
 * @returns The signature, or what is wrong with it.
 */
export function signatureOf(result: unknown): RawSignature | Problem {
  const signature = field(result, "signRawPayloadResult");
  const r = field(signature, "r");
  const s = field(signature, "s");
  const v = field(signature, "v");
  if (typeof r !== "string" || typeof s !== "string" || typeof v !== "string") {
    return { kind: "malformed", problem: "the completed activity has no r, s and v" };
  }
  if (!SCALAR_HEX.test(r)) {
    return { kind: "malformed", problem: "r is not 1 to 64 hex characters" };
  }
  if (!SCALAR_HEX.test(s)) {
    return { kind: "malformed", problem: "s is not 1 to 64 hex characters" };
  }
  const yParity = PARITY.get(v.toLowerCase());
  if (yParity === undefined) {
    return { kind: "malformed", problem: "v is not 00, 01, 1b or 1c" };
  }
  return { r: BigInt(`0x${r}`), s: BigInt(`0x${s}`), yParity };
}

/**
 * The failure code of a failed or rejected activity, from `failure.details[].turnkeyErrorCode`.
 *
 * @param failure - The activity's `failure`.
 * @returns The first code that matches the safe pattern, or `no code`.
 */
export function failureCode(failure: unknown): string {
  const details = field(failure, "details");
  if (Array.isArray(details)) {
    for (const detail of details) {
      const code = field(detail, "turnkeyErrorCode");
      if (typeof code === "string" && SAFE_CODE.test(code)) {
        return code;
      }
    }
  }
  return "no code";
}

/**
 * How the approval-needed error names the activity: by its id when the id is a UUID, so that a
 * user can find it in the dashboard; otherwise without it, since an unexpected value could be
 * anything.
 *
 * @param id - The activity's id.
 * @returns The words for the message.
 */
export function activityName(id: string): string {
  return ACTIVITY_ID.test(id) ? `activity ${id}` : "the activity (its id is not shown)";
}
