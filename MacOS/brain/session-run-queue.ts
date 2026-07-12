/* Per-session FIFO of agent turns parked behind a session's active turn.

   Enforces "one active agent turn per session": when engine.run() is asked to
   start a turn on a session that already has a live one, the new job is parked
   here and drained one-at-a-time as the active turn ends. Kept as a pure data
   structure (no engine/store deps) so the serialization behaviour — ordering,
   cancel-while-parked, skipping dead jobs on drain — is unit tested in isolation.

   The engine owns the "is the session free?" and "is this job still pending?"
   decisions (they need live run + store state) and passes them in. */

import type { Effort, EngineId, RoleChoice } from './store.js';

/** Options for a single agent turn (engine.run), remembered so a drained job
    replays with the exact same run configuration. */
export type RunOpts = { effort?: Effort; engine?: EngineId; model?: string; reviewer?: RoleChoice | 'off'; plan?: boolean; goal?: boolean; browser?: boolean };

export class SessionRunQueue {
  private q = new Map<string, string[]>();
  private opts = new Map<string, RunOpts>();

  /** Park a job behind its session's active turn (FIFO, deduped). */
  park(sessionId: string, jobId: string, opts: RunOpts): void {
    const list = this.q.get(sessionId) ?? [];
    if (!list.includes(jobId)) list.push(jobId);
    this.q.set(sessionId, list);
    this.opts.set(jobId, opts);
  }

  /** True if the job is currently parked (queued, not yet running). */
  isParked(jobId: string): boolean {
    return this.opts.has(jobId);
  }

  /** Remove a job from its queue (e.g. it was cancelled while parked). Returns
      true if it was actually parked. */
  unpark(jobId: string): boolean {
    let found = this.opts.delete(jobId);
    for (const [sid, list] of this.q) {
      const i = list.indexOf(jobId);
      if (i !== -1) {
        list.splice(i, 1);
        if (list.length) this.q.set(sid, list); else this.q.delete(sid);
        found = true;
        break;
      }
    }
    return found;
  }

  /** Pop the next runnable parked job for a session. Skips (and forgets) jobs
      that are no longer pending — cancelled or otherwise settled while parked —
      per the caller's `isPending` predicate. Returns null when nothing is left
      to run. Never returns a job that isn't pending. */
  next(sessionId: string, isPending: (jobId: string) => boolean): { jobId: string; opts: RunOpts } | null {
    const list = this.q.get(sessionId);
    if (!list || list.length === 0) { this.q.delete(sessionId); return null; }
    let picked: string | undefined;
    while (list.length) {
      const id = list.shift()!;
      if (isPending(id)) { picked = id; break; }
      this.opts.delete(id); // settled while parked — drop it
    }
    if (list.length) this.q.set(sessionId, list); else this.q.delete(sessionId);
    if (!picked) return null;
    const opts = this.opts.get(picked) ?? {};
    this.opts.delete(picked);
    return { jobId: picked, opts };
  }

  /** Total parked jobs across all sessions (for tests / diagnostics). */
  size(): number {
    let n = 0;
    for (const list of this.q.values()) n += list.length;
    return n;
  }
}
