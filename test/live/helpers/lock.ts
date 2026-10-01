// A shared/exclusive lock for the fork run. The providers run their cases in parallel on one
// anvil node; the replacement cases turn automine off, which would stall every other provider's
// sends, and a stalled send's `evm_mine` nudge would mine the transaction a replacement case is
// about to replace. So each case holds the lock shared, and a replacement case holds it alone.

/** A lock that many holders can share, or one can hold exclusively. */
export class SharedLock {
  #shared = 0;
  #exclusive = false;
  /** Holders waiting, in arrival order. An exclusive waiter blocks later shared ones. */
  #queue: { exclusive: boolean; wake: () => void }[] = [];

  /** Runs `step` while holding the lock shared. */
  async shared<T>(step: () => Promise<T>): Promise<T> {
    await this.#acquire(false);
    try {
      return await step();
    } finally {
      this.#shared--;
      this.#drain();
    }
  }

  /** Runs `step` while no one else holds the lock. */
  async exclusive<T>(step: () => Promise<T>): Promise<T> {
    await this.#acquire(true);
    try {
      return await step();
    } finally {
      this.#exclusive = false;
      this.#drain();
    }
  }

  #free(exclusive: boolean): boolean {
    return exclusive ? !this.#exclusive && this.#shared === 0 : !this.#exclusive;
  }

  async #acquire(exclusive: boolean): Promise<void> {
    if (this.#queue.length === 0 && this.#free(exclusive)) {
      this.#take(exclusive);
      return;
    }
    await new Promise<void>((resolve) => {
      this.#queue.push({ exclusive, wake: resolve });
    });
  }

  #take(exclusive: boolean): void {
    if (exclusive) {
      this.#exclusive = true;
    } else {
      this.#shared++;
    }
  }

  #drain(): void {
    for (let next = this.#queue[0]; next !== undefined; next = this.#queue[0]) {
      if (!this.#free(next.exclusive)) {
        return;
      }
      this.#queue.shift();
      this.#take(next.exclusive);
      next.wake();
    }
  }
}
