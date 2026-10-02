import type {
  KmsHistoryEvent,
  KmsHistoryRequest,
  KmsHistoryResult,
  KmsHooks,
} from "../../src/types.ts";

/** Obvious placeholders for ids a real log holds. No test output may show them by default. */
export const PLACEHOLDERS = {
  keyArn: "arn:aws:kms:eu-west-1:111122223333:key/PLACEHOLDER-KEY-ID",
  accessKeyId: "AKIAPLACEHOLDERACCESS",
  errorMessage: "User arn:aws:iam::111122223333:user/PLACEHOLDER is not authorized",
} as const;

/**
 * A logged sign event, with every field set. Pass overrides for the fields a test needs.
 *
 * @param overrides - Fields to replace.
 * @returns The event.
 */
export function historyEvent(overrides: Partial<KmsHistoryEvent> = {}): KmsHistoryEvent {
  return {
    time: "2026-10-02T09:14:03.512Z",
    operation: "Sign",
    outcome: "success",
    errorCode: null,
    errorMessage: null,
    principal: "arn:aws:iam::111122223333:role/deployer",
    sourceIp: "203.0.113.7",
    userAgent: "aws-sdk-js/3.0.0 hardhat-kms/0.0.0",
    requestId: "11111111-2222-3333-4444-555555555555",
    keyVersion: null,
    digest: null,
    keyResource: PLACEHOLDERS.keyArn,
    extra: { readOnly: true },
    extraIds: { accessKeyId: PLACEHOLDERS.accessKeyId },
    ...overrides,
  };
}

/**
 * A reader result shaped like AWS CloudTrail event history: no key version, no digest, always on,
 * 90 days of retention and about 5 minutes of delay.
 *
 * @param overrides - Fields to replace.
 * @returns The result.
 */
export function historyResult(overrides: Partial<KmsHistoryResult> = {}): KmsHistoryResult {
  return {
    source: "fake-audit-log",
    notLogged: ["keyVersion", "digest"],
    events: [historyEvent()],
    truncated: false,
    loggingAlwaysOn: true,
    deliveryDelayMinutes: 5,
    retentionDays: 90,
    ...overrides,
  };
}

/** A fake reader and the requests it received. */
export interface FakeHistoryReader {
  handlers: Partial<KmsHooks>;
  requests: KmsHistoryRequest[];
}

/**
 * A `kms` hook handler that reads the history of one provider's keys, as a provider plugin would,
 * and passes every other key to `next`.
 *
 * @param provider - The provider id it reads.
 * @param answer - What it returns or throws for a request; it may return any value, to test the
 * result checks.
 * @returns The handlers to register, and the requests they received.
 */
export function fakeHistoryReader(
  provider: string,
  answer: (request: KmsHistoryRequest) => unknown,
): FakeHistoryReader {
  const requests: KmsHistoryRequest[] = [];
  return {
    requests,
    handlers: {
      readSignHistory: async (context, request, next) => {
        if (request.key.provider !== provider) {
          return await next(context, request);
        }
        requests.push(request);
        // The answer is checked by the plugin, like a third-party reader's; a test may return
        // anything to exercise those checks.
        const result: unknown = await answer(request);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately unchecked
        return result as KmsHistoryResult;
      },
    },
  };
}
