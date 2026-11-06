// Retries for reads and sends that a lagging RPC backend can refuse. Public RPCs balance requests
// across nodes, so a request right after a receipt can reach a node that has not seen that block
// yet. The live tests pin such reads to the receipt's block: a lagging node then answers "header
// not found" or "block not found" instead of stale state, and the read is tried again. Such a node
// also still counts the receipt's transaction as pending, and refuses a send from a delegated
// account, or one carrying an authorization by it, under its pool's limits (#685).

/** The messages nodes give for a block they do not have yet (Geth, Erigon, Reth, Nethermind). */
const LAGGING = /header not found|block not found|unknown block|block .{0,80} not found/i;

/**
 * Geth's refusals of a send while the pool holds another transaction for the same account: a
 * delegated account may have one pending transaction, and an authorization's authority none.
 */
const POOL_REFUSAL =
  /in-flight transaction limit reached for delegated accounts|authority already reserved/i;

/** Whether `error`, its `details` or any error in its `cause` chain matches `pattern`. */
function errorMatches(error: unknown, pattern: RegExp): boolean {
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 10; depth++) {
    if (typeof current === "string") {
      return pattern.test(current);
    }
    if (!(current instanceof Error)) {
      return false;
    }
    // viem keeps the node's own message in `details`.
    const details = "details" in current ? String(current.details) : "";
    if (pattern.test(current.message) || pattern.test(details)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Whether an error, or any error in its `cause` chain, says the node lacks the requested block.
 *
 * @param error - The error a read threw.
 * @returns True for a lagging node's answer.
 */
export function isLaggingBlockError(error: unknown): boolean {
  return errorMatches(error, LAGGING);
}

/**
 * Whether an error, or any error in its `cause` chain, is the pool refusing a send because it
 * still holds another transaction for the account. Nothing was broadcast.
 *
 * @param error - The error a send threw.
 * @returns True for one of geth's pool refusals.
 */
export function isPoolRefusal(error: unknown): boolean {
  return errorMatches(error, POOL_REFUSAL);
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

/** Options for {@link retryPoolRefusal}. */
export interface SendRetryOptions extends RetryOptions {
  /** Called before each new attempt, with the refusal; for a diagnostic. */
  onRetry?: (error: unknown, attempt: number) => void;
}

/**
 * Runs `send`, and runs it again after a pause while the pool refuses it because it still holds
 * another transaction for the account. A refused send broadcast nothing, and the plugin keeps no
 * nonce for it, so the next attempt fills the same one. Any other error, and the last refusal, is
 * thrown as it is.
 *
 * @param send - The send; it must sign and fill again on each call.
 * @param options - Attempts and pause; 10 attempts 6 seconds apart by default, about a minute,
 *   which covers several Sepolia blocks.
 * @returns What `send` returned.
 */
export async function retryPoolRefusal<T>(
  send: () => Promise<T>,
  { tries = 10, delayMs = 6000, sleep = defaultSleep, onRetry }: SendRetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= tries || !isPoolRefusal(error)) {
        throw error;
      }
      onRetry?.(error, attempt);
      await sleep(delayMs);
    }
  }
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
