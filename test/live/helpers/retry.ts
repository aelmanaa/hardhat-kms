// Retries for reads that a lagging RPC backend can refuse. Public RPCs balance requests across
// nodes, so a read right after a receipt can reach a node that has not seen that block yet. The
// live tests pin such reads to the receipt's block: a lagging node then answers "header not found"
// or "block not found" instead of stale state, and the read is tried again.

/** The messages nodes give for a block they do not have yet (Geth, Erigon, Reth, Nethermind). */
const LAGGING = /header not found|block not found|unknown block|block .{0,80} not found/i;

/**
 * Whether an error, or any error in its `cause` chain, says the node lacks the requested block.
 *
 * @param error - The error a read threw.
 * @returns True for a lagging node's answer.
 */
export function isLaggingBlockError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 10; depth++) {
    if (typeof current === "string") {
      return LAGGING.test(current);
    }
    if (!(current instanceof Error)) {
      return false;
    }
    // viem keeps the node's own message in `details`.
    const details = "details" in current ? String(current.details) : "";
    if (LAGGING.test(current.message) || LAGGING.test(details)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** Options for {@link retryLagging}. */
export interface RetryOptions {
  /** Attempts in total. */
  tries?: number;
  /** Pause between attempts, in milliseconds. */
  delayMs?: number;
  /** Waits `ms` milliseconds; for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs `read`, and runs it again after a pause while it fails because the node lacks the block.
 * Any other error, and the last lagging one, is thrown as it is.
 *
 * @param read - The read, normally pinned to a receipt's block.
 * @param options - Attempts and pause; 10 attempts 2 seconds apart by default.
 * @returns What `read` returned.
 */
export async function retryLagging<T>(
  read: () => Promise<T>,
  { tries = 10, delayMs = 2000, sleep = defaultSleep }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= tries || !isLaggingBlockError(error)) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
