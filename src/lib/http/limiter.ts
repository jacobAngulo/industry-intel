// The per-host concurrency limit of SafeHttp (specification §11.1): at most
// `limit` requests to one host at one time. Other requests wait in a queue
// (first in, first out). The wait stops when the signal aborts.

export type Release = () => void;

export class HostLimiter {
  readonly limit: number;
  readonly #active = new Map<string, number>();
  readonly #waiting = new Map<string, Array<() => void>>();

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("HostLimiter: the limit must be a positive integer.");
    this.limit = limit;
  }

  /** The number of requests that hold a slot for this host now. */
  active(key: string): number {
    return this.#active.get(key) ?? 0;
  }

  /** The number of requests that wait for a slot for this host now. */
  waiting(key: string): number {
    return this.#waiting.get(key)?.length ?? 0;
  }

  /**
   * Waits for a slot. The returned function gives the slot back; a second
   * call does nothing. Rejects with `signal.reason` when the signal aborts
   * before a slot is free.
   */
  acquire(key: string, signal: AbortSignal): Promise<Release> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const count = this.active(key);
    if (count < this.limit) {
      this.#active.set(key, count + 1);
      return Promise.resolve(this.#releaser(key));
    }
    return new Promise<Release>((resolve, reject) => {
      let queue = this.#waiting.get(key);
      if (!queue) {
        queue = [];
        this.#waiting.set(key, queue);
      }
      const grant = (): void => {
        signal.removeEventListener("abort", onAbort);
        resolve(this.#releaser(key));
      };
      const onAbort = (): void => {
        const current = this.#waiting.get(key);
        if (current) {
          const index = current.indexOf(grant);
          if (index >= 0) current.splice(index, 1);
          if (current.length === 0) this.#waiting.delete(key);
        }
        reject(signal.reason);
      };
      queue.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  #releaser(key: string): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const queue = this.#waiting.get(key);
      const next = queue?.shift();
      if (queue && queue.length === 0) this.#waiting.delete(key);
      if (next) {
        // The slot goes to the next request: the count does not change.
        next();
        return;
      }
      const count = this.active(key) - 1;
      if (count <= 0) this.#active.delete(key);
      else this.#active.set(key, count);
    };
  }
}
