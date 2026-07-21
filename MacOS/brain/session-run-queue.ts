/* SessionRunQueue — the AUTHORITATIVE single-writer decision logic for a chat
   session's turns.

   THE PROBLEM: direct user messages, localApi/createAndRunJob, cron/schedules/
   retries, WhatsApp/remote injection, and autopilot continuations all reach
   `engine.run(jobId)` for the SAME session concurrently. Two turns racing the
   same worktree/branch/sdkSessionId corrupt each other. Renderer-side queuing is
   advisory only. This module is the backend's single source of truth: at most ONE
   active writer (the "lease owner") per session, everyone else FIFO-queued, with
   idempotent enqueue and restart-safe recovery. Concurrency ACROSS sessions is
   preserved (each session has its own independent lease).

   This file is PURE (no I/O, no time source of its own) so every transition is
   deterministic + unit-tested. The Store persists the record and applies these
   transitions under its cross-process write lock (short compare-and-set); the
   engine calls the Store at the single `engine.run` choke point. */

/** The persisted per-session lease + FIFO wait list. `owner` is the jobId
    currently allowed to execute; `waiters` are jobIds queued behind it in
    enqueue order. `heartbeatAt` is refreshed by the live owner so a crashed
    owner's lease can be reclaimed after it goes stale. */
export interface SessionLeaseRecord {
  owner: string | null;
  ownerToken?: string | null;
  acquiredAt: number;
  heartbeatAt: number;
  waiters: string[];
}

/** A lease with no live owner and no waiters is considered absent. */
export function emptyLease(): SessionLeaseRecord {
  return { owner: null, ownerToken: null, acquiredAt: 0, heartbeatAt: 0, waiters: [] };
}

/** How long after its last heartbeat an owner's lease is presumed dead (the
    owning process crashed/hung) and may be reclaimed by the next acquirer. Well
    above any single checkpoint cadence so a live-but-busy owner is never evicted. */
export const LEASE_STALE_MS = 120_000;

const norm = (rec: SessionLeaseRecord | undefined | null): SessionLeaseRecord =>
  rec ? { owner: rec.owner ?? null, ownerToken: rec.ownerToken ?? null, acquiredAt: rec.acquiredAt ?? 0, heartbeatAt: rec.heartbeatAt ?? 0, waiters: [...(rec.waiters ?? [])] } : emptyLease();

/** True when a lease is held by a LIVE owner (owner set + heartbeat within the
    stale window). A stale or ownerless lease is reclaimable. */
export function isOwnerLive(rec: SessionLeaseRecord | undefined | null, now: number, staleMs = LEASE_STALE_MS): boolean {
  const r = norm(rec);
  return !!r.owner && (now - r.heartbeatAt) <= staleMs;
}

export type AcquireOutcome = 'acquired' | 'owned' | 'queued' | 'contended';

/** Decide what `jobId` may do against the current lease. Idempotent:
    - already the owner → 'owned' (heartbeat refreshed);
    - lease free → 'acquired' (jobId becomes owner);
    - stale owner → the FIFO-earliest waiter is promoted before any newcomer,
      preserving queued turn order;
    - held by a live, different owner → 'queued' (jobId appended to waiters
      exactly once — a duplicate request never double-enqueues). */
export function acquire(rec: SessionLeaseRecord | undefined | null, jobId: string, now: number, staleMs = LEASE_STALE_MS, ownerToken?: string | null): { rec: SessionLeaseRecord; outcome: AcquireOutcome; promoted?: string | null } {
  const cur = norm(rec);
  if (cur.owner === jobId) {
    if (!cur.ownerToken || cur.ownerToken === ownerToken || (now - cur.heartbeatAt) > staleMs) {
      return { rec: { ...cur, ownerToken: ownerToken ?? cur.ownerToken ?? null, heartbeatAt: now }, outcome: (now - cur.heartbeatAt) > staleMs ? 'acquired' : 'owned' };
    }
    return { rec: cur, outcome: 'contended' };
  }
  if (!cur.owner) {
    return { rec: { owner: jobId, ownerToken: ownerToken ?? null, acquiredAt: now, heartbeatAt: now, waiters: cur.waiters.filter(w => w !== jobId) }, outcome: 'acquired' };
  }
  if ((now - cur.heartbeatAt) > staleMs) {
    const [next, ...rest] = cur.waiters;
    if (!next || next === jobId) {
      return { rec: { owner: jobId, ownerToken: ownerToken ?? null, acquiredAt: now, heartbeatAt: now, waiters: rest.filter(w => w !== jobId) }, outcome: 'acquired' };
    }
    const waiters = rest.includes(jobId) ? rest : [...rest, jobId];
    return { rec: { owner: next, ownerToken: null, acquiredAt: now, heartbeatAt: now, waiters }, outcome: 'queued', promoted: next };
  }
  const waiters = cur.waiters.includes(jobId) ? cur.waiters : [...cur.waiters, jobId];
  return { rec: { ...cur, waiters }, outcome: 'queued' };
}

/** Release the lease held by `jobId` and promote the FIFO-earliest waiter to
    owner (so there is never a gap in which two acquirers could both win). Returns
    the promoted jobId (to be dispatched) or null when the queue is empty. A
    non-owner release is defensive: it only removes `jobId` from the wait list. */
export function release(rec: SessionLeaseRecord | undefined | null, jobId: string, now: number, ownerToken?: string | null): { rec: SessionLeaseRecord; next: string | null } {
  const cur = norm(rec);
  if (cur.owner !== jobId || (cur.ownerToken && cur.ownerToken !== ownerToken)) {
    return { rec: { ...cur, waiters: cur.waiters.filter(w => w !== jobId) }, next: null };
  }
  const [next, ...rest] = cur.waiters;
  if (next) return { rec: { owner: next, ownerToken: null, acquiredAt: now, heartbeatAt: now, waiters: rest }, next };
  return { rec: emptyLease(), next: null };
}

/** Remove a QUEUED (not-owner) jobId from the wait list — the transition for
    cancelling a job while it is still queued. Never touches the owner or promotes
    anyone (the active turn keeps running). No-op if jobId isn't a waiter. */
export function dequeue(rec: SessionLeaseRecord | undefined | null, jobId: string): SessionLeaseRecord {
  const cur = norm(rec);
  if (cur.owner === jobId) return cur; // owner cancellation goes through release()
  return { ...cur, waiters: cur.waiters.filter(w => w !== jobId) };
}

/** Refresh the owner's heartbeat (proof of life) — called periodically by the
    live owner so recovery never reclaims a lease from a healthy long turn. No-op
    unless `jobId` is the current owner. */
export function heartbeat(rec: SessionLeaseRecord | undefined | null, jobId: string, now: number, ownerToken?: string | null): SessionLeaseRecord {
  const cur = norm(rec);
  return cur.owner === jobId && (!cur.ownerToken || cur.ownerToken === ownerToken) ? { ...cur, ownerToken: ownerToken ?? cur.ownerToken ?? null, heartbeatAt: now } : cur;
}

/** Restart/orphan recovery for ONE session lease, run ONCE at boot AFTER
    settleOrphanedRuns() has terminalized every crashed RUNNING owner. `isTerminal`
    reports done/failed/cancelled/missing. Boot semantics (nothing runs in-process
    yet), so the owner's state is decisive:
    - TERMINAL owner (a crashed running owner, now failed): promote the FIFO-earliest
      LIVE waiter and dispatch IT — the terminal (partially-run) owner is NEVER re-run.
    - NON-TERMINAL owner (a PENDING job that was promoted to owner but whose process
      died before it started — the crash-window in release→dispatch): dispatch the
      OWNER exactly once (it never ran); waiters stay queued behind it. This is what
      keeps a promoted-but-never-started turn from being dropped/stalled.
    - No owner: promote the earliest live waiter, or clear an empty lease.
    Terminal waiters are always pruned. Idempotent: re-running on the healed record
    only re-dispatches an owner that is STILL non-terminal (still never-started). */
export function recover(
  rec: SessionLeaseRecord | undefined | null,
  isTerminal: (jobId: string) => boolean,
  now: number,
  ownerToken?: string | null,
): { rec: SessionLeaseRecord; next: string | null } {
  const cur = norm(rec);
  const liveWaiters = cur.waiters.filter(w => !isTerminal(w));
  if (cur.owner && !isTerminal(cur.owner)) {
    // Promoted-but-never-started owner → re-dispatch the owner exactly once.
    return { rec: { owner: cur.owner, ownerToken: ownerToken ?? null, acquiredAt: cur.acquiredAt || now, heartbeatAt: now, waiters: liveWaiters }, next: cur.owner };
  }
  // Owner terminal/missing → promote the FIFO-earliest live waiter.
  const [next, ...rest] = liveWaiters;
  if (next) return { rec: { owner: next, ownerToken: ownerToken ?? null, acquiredAt: now, heartbeatAt: now, waiters: rest }, next };
  return { rec: emptyLease(), next: null };
}

/** True when the record can be dropped from the persisted map entirely (no owner,
    no waiters) — keeps the store from accumulating empty session entries. */
export function isEmpty(rec: SessionLeaseRecord | undefined | null): boolean {
  const r = norm(rec);
  return !r.owner && r.waiters.length === 0;
}
