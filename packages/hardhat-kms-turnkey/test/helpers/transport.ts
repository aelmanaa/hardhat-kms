// A transport for unit tests: the stub as `fetch`, waits that return at once and are recorded,
// and a clock that the test sets.
import type { Transport } from "../../src/internal/client.ts";
import type { TurnkeyStub } from "./turnkey-stub.ts";

export const BASE_URL = "https://turnkey.test";

export interface TestTransport extends Transport {
  /** Every wait asked for, in milliseconds. */
  waits: number[];
  /** The clock's value; `now()` returns it. */
  time: number;
}

/**
 * Builds the transport.
 *
 * @param stub - The stub that answers.
 * @param options - `random` for the jitter; `onWait` runs inside each wait.
 * @returns The transport.
 */
export function testTransport(
  stub: TurnkeyStub,
  options: { random?: number; onWait?: (ms: number) => void } = {},
): TestTransport {
  const transport: TestTransport = {
    baseUrl: BASE_URL,
    fetch: stub.fetch,
    waits: [],
    time: 1_760_000_000_000,
    random: () => options.random ?? 0.5,
    now: () => transport.time,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      transport.waits.push(ms);
      options.onWait?.(ms);
      signal.throwIfAborted();
      await Promise.resolve();
    },
  };
  return transport;
}
