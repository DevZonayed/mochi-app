/* Timer bag — an unmount-safe wrapper around setTimeout/clearTimeout.

   Why: the Workspace copy UI schedules delayed state updates (clear the "Copied"
   toast after 1.7s, close the tab menu 620ms after a check). If the component
   unmounts while one is pending, the callback would call setState on a dead
   component. A bag tracks every timer it schedules and, on `dispose()`, clears
   them all AND flips a guard so any callback that still slips through becomes a
   no-op. After dispose, `set()` refuses to schedule anything. The scheduler is
   injected so the logic is testable with a deterministic fake. */

export interface TimerScheduler {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface TimerBag {
  /** Schedule `fn` after `ms`. Returns the timer id, or -1 if the bag is disposed. */
  set(fn: () => void, ms: number): number;
  /** Cancel a specific timer. */
  clear(id: number): void;
  /** Clear all pending timers and block any future scheduling/firing. Idempotent. */
  dispose(): void;
  /** Count of currently pending timers. */
  readonly active: number;
  /** Whether the bag has been disposed. */
  readonly disposed: boolean;
}

export function createTimerBag(scheduler: TimerScheduler): TimerBag {
  const ids = new Set<number>();
  let disposed = false;
  return {
    set(fn: () => void, ms: number): number {
      if (disposed) return -1;
      const id = scheduler.setTimeout(() => {
        ids.delete(id);
        if (!disposed) fn(); // second guard: never fire after dispose
      }, ms);
      ids.add(id);
      return id;
    },
    clear(id: number): void {
      scheduler.clearTimeout(id);
      ids.delete(id);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const id of ids) scheduler.clearTimeout(id);
      ids.clear();
    },
    get active() {
      return ids.size;
    },
    get disposed() {
      return disposed;
    },
  };
}
