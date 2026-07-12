/* Pure helpers for the chat transcript's live `turns` array.

   A chat turn is a Job. The transcript is seeded from `listJobPage` and then
   patched by live `job` events. Both the seed response and the live events can
   arrive OUT OF ORDER relative to each other (an async RPC response vs a push
   event; a relay/phone reorder). The seed response in particular is a snapshot
   taken when the request was dispatched — possibly while the turn was still
   running — so if it lands AFTER the terminal `done` frame it would drag the
   composer back into a "streaming / Stop" state that never clears.

   These helpers encode the same invariant as useSessionRunning's reduceRun:
     • a TERMINAL turn (done/failed/cancelled) is never regressed to a
       non-terminal one, and
     • a fresher frame (higher `updatedAt`) is never replaced by a staler one.

   Kept pure + isolated from ProjectDetail so the precedence rules are unit
   tested without dragging in the whole chat screen. */

import type { Job, JobStatus } from './api';

export function compareTurnsOldestFirst(a: Job, b: Job): number {
  return (a.createdAt - b.createdAt) || (a.updatedAt - b.updatedAt) || a.id.localeCompare(b.id);
}

/** done/failed/cancelled are terminal (the turn is finished). */
export function isTerminalTurn(status: JobStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/** Merge job groups by id (LATER groups win for duplicate ids), sorted oldest
    first. Used by the load-older path: `mergeTurns(olderPage, currentTurns)`
    keeps the fresher current copy of any overlapping turn. */
export function mergeTurns(...groups: Job[][]): Job[] {
  const byId = new Map<string, Job>();
  for (const group of groups) for (const job of group) byId.set(job.id, job);
  return [...byId.values()].sort(compareTurnsOldestFirst);
}

/** Pick the frame that represents the real latest state of the SAME turn.
    TERMINAL DOMINATES — a done/failed/cancelled frame beats any non-terminal one
    regardless of `updatedAt` (terminal is final on the backend, so a "running"
    frame that looks newer can only be a stale/out-of-order snapshot). Otherwise
    the strictly-fresher `updatedAt` wins; exact ties keep `current`. */
function pickFresher(current: Job, incoming: Job): Job {
  const ct = isTerminalTurn(current.status);
  const it = isTerminalTurn(incoming.status);
  if (ct !== it) return ct ? current : incoming;
  return incoming.updatedAt > current.updatedAt ? incoming : current;
}

/** Live-event upsert: fold one job frame into the transcript. Appends a new
    turn (sorted), or replaces an existing one ONLY when the frame is genuinely
    fresher and doesn't un-finish a finished turn. Returns the same array
    reference when the frame is dropped as stale, so React can skip the re-render. */
export function upsertTurn(list: Job[], job: Job): Job[] {
  const i = list.findIndex(t => t.id === job.id);
  if (i === -1) return [...list, job].sort(compareTurnsOldestFirst);
  const winner = pickFresher(list[i], job);
  if (winner === list[i]) return list; // stale / would regress terminal
  const next = list.slice();
  next[i] = winner;
  return next;
}

/** Seed reconcile: build the transcript from an authoritative `listJobPage`
    result, but keep any live copy already in `prev` that is FRESHER than the
    page snapshot (the page may have been captured before the turn finished).
    Starts from `pageJobs` so ordering, pagination and set membership are exactly
    the page's — live copies only swap in per id; nothing extra leaks in. */
export function reconcileSeededTurns(pageJobs: Job[], prev: Job[]): Job[] {
  if (!prev.length) return pageJobs;
  const liveById = new Map(prev.map(t => [t.id, t]));
  return pageJobs.map(j => {
    const live = liveById.get(j.id);
    return live ? pickFresher(j, live) : j;
  });
}
