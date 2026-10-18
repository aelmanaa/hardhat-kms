import {
  catalogError,
  type ErrorEntry,
  kmsDebug,
  type TemplateParams,
} from "hardhat-kms/provider-utils";
import type {
  KeyDescription,
  KmsKeyAdapter,
  SignatureOutput,
  SignContext,
  TurnkeyKmsKeyConfig,
  TypedData,
} from "hardhat-kms/types";

import {
  type Activity,
  activityName,
  type FinalActivity,
  failureCode,
  type Problem,
  type RawSignature,
  readActivity,
  SIGN_RAW_PAYLOAD,
  SIGN_TRANSACTION,
  signatureOf,
  signedTransactionOf,
} from "./activity.ts";
import { defaultTransport, type Transport, TurnkeyClient } from "./client.ts";
import { ERRORS } from "./error-catalog.ts";
import {
  digestPayload,
  messagePayload,
  type PayloadParameters,
  type TransactionParameters,
  transactionPayload,
  typedDataPayload,
} from "./payload.ts";
import { apiKeyFromPrivateKey, samePublicKey } from "./stamp.ts";
import { readUnsigned, signatureOfSignedTransaction } from "./transaction.ts";

const SIGN_PATH = "/public/v1/submit/sign_raw_payload";
/**
 * Turnkey's `sign_transaction` submission: the path `@turnkey/http` 6.7.0's `signTransaction`
 * posts to (https://docs.turnkey.com/api-reference/activities/sign-transaction).
 */
const SIGN_TRANSACTION_PATH = "/public/v1/submit/sign_transaction";
const POLL_PATH = "/public/v1/query/get_activity";

/** The first wait before polling a pending activity, in milliseconds. */
export const FIRST_POLL_MS = 500;
/** The longest wait between two polls, in milliseconds. */
export const MAX_POLL_MS = 2000;

/** The status line shown once while the plugin polls a pending activity. */
export const WAITING_MESSAGE = "waiting for Turnkey to finish the activity";

const log = kmsDebug("turnkey");

/** The key's resolved credentials: read once, on the first signature. Never print or log them. */
interface Session {
  client: TurnkeyClient;
  organizationId: string;
}

/** One sign request: what the errors call it, where it goes, its parameters, and the 403 hint. */
interface SignRequest {
  operation: string;
  path: string;
  /** The activity type, which the answer's activity must have too. */
  type: string;
  parameters: PayloadParameters | TransactionParameters;
  forbiddenHint: string;
  /** Reads the signature from a completed activity's `result`. */
  read: (result: unknown) => RawSignature | Problem;
}

/** The request for a raw payload: `sign_raw_payload`, read from `signRawPayloadResult`. */
function rawPayloadRequest(
  operation: string,
  parameters: PayloadParameters,
  forbiddenHint: string,
): SignRequest {
  return {
    operation,
    path: SIGN_PATH,
    type: SIGN_RAW_PAYLOAD,
    parameters,
    forbiddenHint,
    read: signatureOf,
  };
}

/** Test-only settings of the adapter. Users cannot set them: the config has no such field. */
export interface TurnkeyAdapterOptions {
  /** Replaces Turnkey's API, `fetch`, the clock or the waits. */
  transport?: Partial<Transport>;
}

/**
 * The Turnkey adapter for one key.
 *
 * It signs transactions with Turnkey's `sign_transaction` activity, so that Turnkey's policies
 * can read their fields (`eth.tx.*`), and messages, typed data and digests with `sign_raw_payload`.
 * A key with `transactionSigning: "digest"` has no `signTransaction`: the core then signs each
 * transaction's digest with `signDigest`.
 * Both send the key's checksummed `address` as `signWith`, as alloy's Turnkey signer does. The core pins the key to that address and checks
 * every signature against it by recovery. The adapter reads the API keys on the first signature,
 * derives the API public key from the private key, and fails before any request when a configured
 * `apiPublicKey` differs.
 *
 * Each signature sends a new `timestampMs`, so the core's fresh attempt after an invalid
 * signature is a new activity. Retries of one request send the same body, so Turnkey answers the
 * same activity. A pending activity is polled with `get_activity` until it ends or the call's
 * signal aborts. An activity that needs approval fails at once, with its id.
 */
class TurnkeyKeyAdapter implements KmsKeyAdapter {
  readonly #key: TurnkeyKmsKeyConfig;
  readonly #transport: Transport;
  #session: Promise<Session> | undefined;
  #lastTimestamp = 0;

  /**
   * Set only when the key signs transactions through `sign_transaction`. With
   * `transactionSigning: "digest"` the adapter has no `signTransaction`, so the core signs each
   * transaction's digest with `signDigest`, as Foundry does.
   */
  declare public readonly signTransaction?: (
    request: { unsigned: Uint8Array; digest: Uint8Array; type: number; chainId: bigint },
    ctx: SignContext,
  ) => Promise<SignatureOutput>;

  public constructor(key: TurnkeyKmsKeyConfig, transport: Transport) {
    this.#key = key;
    this.#transport = transport;
    if (key.transactionSigning === "transaction") {
      this.signTransaction = async (request, ctx) => await this.#signTransaction(request, ctx);
    }
  }

  public describe(): KeyDescription {
    return { provider: "turnkey", pinnedId: this.#key.address, displayId: this.#key.displayId };
  }

  public async signDigest(
    request: { digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput> {
    return await this.#sign(
      rawPayloadRequest(
        "sign digest",
        digestPayload(request.digest),
        " (a digest, sent with HASH_FUNCTION_NO_OP and PAYLOAD_ENCODING_HEXADECIMAL: a policy that allows only SIGN_TRANSACTION, or only HASH_FUNCTION_KECCAK256, denies it)",
      ),
      ctx,
    );
  }

  public async signMessage(
    request: { message: Uint8Array; digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput> {
    return await this.#sign(
      rawPayloadRequest(
        "sign message",
        messagePayload(request.message),
        " (a message, sent with HASH_FUNCTION_KECCAK256 and PAYLOAD_ENCODING_HEXADECIMAL: a policy that allows only HASH_FUNCTION_NO_OP denies it)",
      ),
      ctx,
    );
  }

  public async signTypedData(
    request: { typedData: TypedData; digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput> {
    return await this.#sign(
      rawPayloadRequest(
        "sign typed data",
        typedDataPayload(request.typedData),
        " (typed data, sent with PAYLOAD_ENCODING_EIP712 and HASH_FUNCTION_NO_OP: a policy that allows only PAYLOAD_ENCODING_HEXADECIMAL denies it)",
      ),
      ctx,
    );
  }

  /**
   * Signs a transaction with `sign_transaction`. Turnkey returns the signed transaction; the
   * adapter checks that its type and fields are those of `unsigned`, and returns only `r`, `s`
   * and the parity. The core verifies them against its own digest and broadcasts its own bytes.
   */
  async #signTransaction(
    request: { unsigned: Uint8Array; digest: Uint8Array; type: number; chainId: bigint },
    ctx: SignContext,
  ): Promise<SignatureOutput> {
    const operation = "sign transaction";
    const expected = readUnsigned(request.unsigned, request.type, request.chainId);
    if (expected === undefined) {
      throw this.#error(operation, ERRORS.transactionUnsupported, { type: request.type });
    }
    return await this.#sign(
      {
        operation,
        path: SIGN_TRANSACTION_PATH,
        type: SIGN_TRANSACTION,
        parameters: transactionPayload(request.unsigned),
        forbiddenHint:
          " (a transaction, sent as ACTIVITY_TYPE_SIGN_TRANSACTION_V2: a policy that allows only SIGN_RAW_PAYLOAD denies it; to sign the transaction's hash instead, as Foundry does, set the key's transactionSigning to \"digest\")",
        read: (result) => {
          const signed = signedTransactionOf(result);
          return "kind" in signed ? signed : signatureOfSignedTransaction(signed, expected);
        },
      },
      ctx,
    );
  }

  async #sign(request: SignRequest, ctx: SignContext): Promise<SignatureOutput> {
    const session = await this.#sessionFor(request.operation);
    const body = JSON.stringify({
      type: request.type,
      timestampMs: String(this.#nextTimestamp()),
      organizationId: session.organizationId,
      parameters: { signWith: this.#key.address, ...request.parameters },
    });
    const requestContext = {
      signal: ctx.signal,
      operation: request.operation,
      requestId: ctx.requestId,
      forbiddenHint: request.forbiddenHint,
    };
    const answer = await session.client.send(request.path, body, requestContext);
    let activity = this.#activityOf(answer.body, session, undefined, request);
    log("%s: activity %s", ctx.requestId, activity.status);
    const poll = JSON.stringify({
      organizationId: session.organizationId,
      activityId: activity.id,
    });
    let wait = FIRST_POLL_MS;
    for (let polls = 0; ; polls++) {
      if (
        activity.status !== "ACTIVITY_STATUS_PENDING" &&
        activity.status !== "ACTIVITY_STATUS_CREATED"
      ) {
        return this.#outcome(activity, request);
      }
      if (polls === 1) {
        // Still running after the first poll: say why the call takes longer, once.
        await ctx.displayMessage(WAITING_MESSAGE);
      }
      await this.#transport.sleep(wait, ctx.signal);
      wait = Math.min(wait * 2, MAX_POLL_MS);
      const polled = await session.client.send(POLL_PATH, poll, requestContext);
      activity = this.#activityOf(polled.body, session, activity.id, request);
      log("%s: activity %s", ctx.requestId, activity.status);
    }
  }

  /** The signature of an activity that ended, or the error that explains why there is none. */
  #outcome(activity: FinalActivity, request: SignRequest): SignatureOutput {
    if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
      throw this.#failure(activity, request.operation);
    }
    const signature = request.read(activity.result);
    if ("kind" in signature) {
      throw this.#problem(signature, request.operation);
    }
    return signature;
  }

  /** The error for an activity that ended without a signature. */
  #failure(
    activity: Exclude<FinalActivity, { status: "ACTIVITY_STATUS_COMPLETED" }>,
    operation: string,
  ): Error {
    if (activity.status === "ACTIVITY_STATUS_REJECTED") {
      return this.#error(operation, ERRORS.activityRejected, {
        code: failureCode(activity.failure),
      });
    }
    if (activity.status === "ACTIVITY_STATUS_FAILED") {
      return this.#error(operation, ERRORS.activityFailed, {
        code: failureCode(activity.failure),
      });
    }
    return this.#error(operation, ERRORS.approvalNeeded, {
      activity: activityName(activity.id),
      need:
        activity.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED"
          ? "more approvals (ACTIVITY_STATUS_CONSENSUS_NEEDED)"
          : "another authenticator (ACTIVITY_STATUS_AUTHENTICATORS_NEEDED)",
    });
  }

  #activityOf(
    body: unknown,
    session: Session,
    id: string | undefined,
    request: SignRequest,
  ): Activity {
    const activity = readActivity(body, {
      organizationId: session.organizationId,
      type: request.type,
      id,
    });
    if ("kind" in activity) {
      throw this.#problem(activity, request.operation);
    }
    return activity;
  }

  #problem(problem: Problem, operation: string): Error {
    if (problem.kind === "malformed") {
      return this.#error(operation, ERRORS.malformed, { problem: problem.problem });
    }
    if (problem.kind === "mismatch") {
      return this.#error(operation, ERRORS.responseMismatch, { field: problem.field });
    }
    return this.#error(operation, ERRORS.transactionMismatch, { field: problem.field });
  }

  /** A `timestampMs` later than any this adapter sent, so two signatures never share a body. */
  #nextTimestamp(): number {
    this.#lastTimestamp = Math.max(this.#transport.now(), this.#lastTimestamp + 1);
    return this.#lastTimestamp;
  }

  /** Reads and checks the credentials once. A failure is not kept: the next call reads again. */
  async #sessionFor(operation: string): Promise<Session> {
    this.#session ??= this.#openSession(operation).catch((error: unknown) => {
      this.#session = undefined;
      throw error;
    });
    return await this.#session;
  }

  /** The core trims every identifier's value, so the adapter reads them as they come. */
  async #openSession(operation: string): Promise<Session> {
    const apiKey = apiKeyFromPrivateKey(await this.#key.apiPrivateKey.get());
    if (apiKey === undefined) {
      throw this.#error(operation, ERRORS.privateKeyFormat, {});
    }
    const configured = await this.#key.apiPublicKey?.get();
    if (configured !== undefined && !samePublicKey(configured, apiKey.publicKey)) {
      throw this.#error(operation, ERRORS.publicKeyMismatch, {});
    }
    const organizationId = await this.#key.organizationId.get();
    return {
      client: new TurnkeyClient(this.#transport, apiKey, this.#key.displayId),
      organizationId,
    };
  }

  #error<Template extends string>(
    operation: string,
    entry: ErrorEntry<Template, "error">,
    params: TemplateParams<Template>,
  ): Error {
    return catalogError(entry, params, {
      provider: "turnkey",
      operation,
      key: this.#key.displayId,
    });
  }
}

/**
 * Builds the adapter for a Turnkey key. It makes no request and reads no credential: both wait for
 * the first signature.
 *
 * @param key - The resolved key.
 * @param options - Test-only settings: another API URL, `fetch`, clock or waits.
 * @returns The adapter.
 */
export async function createTurnkeyKeyAdapter(
  key: TurnkeyKmsKeyConfig,
  options: TurnkeyAdapterOptions = {},
): Promise<KmsKeyAdapter> {
  return await Promise.resolve(
    new TurnkeyKeyAdapter(key, { ...defaultTransport(), ...options.transport }),
  );
}
