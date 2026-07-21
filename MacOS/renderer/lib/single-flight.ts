/* Single-flight coordinator — coalesces concurrent identical async work behind
   one shared promise, keyed by a string.

   Why: a rapid double right-click (or the ⌘⌥C shortcut fired twice) on the same
   chat tab would otherwise kick off two `listJobs` fetches + two pasteboard
   writes for the same session+mode before the first resolved. Routing the copy
   through `run(key, fn)` means every caller with the same key shares ONE
   in-flight promise (one fetch, one format, one pasteboard write) and all of
   them settle from it. Distinct keys (different session or mode) stay fully
   independent. The slot is released as soon as the work settles — success OR
   failure — so the next action starts fresh rather than replaying a stale
   result. */

export interface SingleFlight<T> {
  /** Run `fn` under `key`, or return the in-flight promise if one already exists. */
  run(key: string, fn: () => Promise<T>): Promise<T>;
  /** Number of currently in-flight keys (for tests / diagnostics). */
  readonly size: number;
}

export function createSingleFlight<T>(): SingleFlight<T> {
  const inflight = new Map<string, Promise<T>>();
  return {
    run(key: string, fn: () => Promise<T>): Promise<T> {
      const existing = inflight.get(key);
      if (existing) return existing;
      // Invoke `fn` EAGERLY (synchronously) so the in-flight entry is observable
      // to a duplicate `run` fired in the same tick — that is what coalesces a
      // rapid double-click. A synchronous throw inside `fn` becomes a rejection.
      let started: Promise<T>;
      try {
        started = Promise.resolve(fn());
      } catch (e) {
        started = Promise.reject(e);
      }
      const tracked = started.finally(() => {
        // Only clear if we're still the owner (a later run for the same key
        // after settle installs a new promise we must not evict).
        if (inflight.get(key) === tracked) inflight.delete(key);
      });
      inflight.set(key, tracked);
      return tracked;
    },
    get size() {
      return inflight.size;
    },
  };
}
