/* Run-mode guard for parallel sessions. Pure so it unit-tests freely.

   Conductor's `scripts.run_mode` decides whether multiple workspaces may run their
   dev server / app at the same time. We apply the same guard to background runs:
   a `concurrent` project lets every session start its own dev server (each on its
   isolated MOCHI_PORT block); a `nonconcurrent` project depends on a single shared
   resource (one fixed port, one local DB, one Docker stack) and so allows only one
   session to have a live background run at a time. */

export type RunMode = 'concurrent' | 'nonconcurrent';

export const DEFAULT_RUN_MODE: RunMode = 'concurrent';

/** Coerce an arbitrary stored value into a valid RunMode (default concurrent). */
export function normalizeRunMode(v: unknown): RunMode {
  return v === 'nonconcurrent' ? 'nonconcurrent' : 'concurrent';
}

/** Decide whether `sessionId` may START a background run, given the project's mode
    and the sessions of the SAME project that already have a live background
    process. Concurrent → always. Nonconcurrent → only if no OTHER session is live
    (the same session may start additional processes of its own). */
export function canStartBackgroundRun(opts: {
  mode: RunMode;
  sessionId: string | null;
  activeSessionIds: Iterable<string>;
}): { allowed: boolean; blockedBy: string | null } {
  if (opts.mode === 'concurrent') return { allowed: true, blockedBy: null };
  for (const other of opts.activeSessionIds) {
    if (other && other !== opts.sessionId) return { allowed: false, blockedBy: other };
  }
  return { allowed: true, blockedBy: null };
}
