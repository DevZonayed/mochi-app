/* Deterministic derivation of the composer's control state for a chat session.

   THE INVARIANT: session activity + the Abort/steer target derive from ALL
   active agent jobs in the session — never from the chronologically latest
   (selected) turn. A later turn that has already completed (e.g. an injected
   monitor / scheduled-check turn) must not make the session look idle while an
   EARLIER real agent job is still working, and Abort must target that earlier
   job's id, not the completed latest turn's.

   Three states are kept strictly independent (they must never masquerade as one
   another): the selected transcript turn (the last-by-createdAt job — used only
   for reading the thread), the active agent job(s) (this module), and long-lived
   background processes (the separate `bg` channel / BgTasksPanel).

   Inputs:
   • `turns`         — the loaded transcript jobs, oldest-first by createdAt.
   • `cacheActiveIds`— live job ids for the session from the app-wide cache
     (useSessionActiveJobs), oldest-first — covers active jobs that scrolled out
     of the loaded page.

   Pure + isolated so the exact ordering matrix is unit tested without React. */

import type { Job } from './api';
import { isLiveRun } from './jobStatus';

export interface SessionControl {
  /** Any agent job in the session is a live run. */
  sessionActive: boolean;
  /** All live job ids, oldest-first (union of loaded turns + cache). */
  activeJobIds: string[];
  /** The job Stop/steer/queue must control: the latest turn if it is itself the
      active run, else the OLDEST still-running job (the stranded one). */
  controlJobId: string | null;
  /** True when the latest (selected) turn is itself the active run — the normal
      case where the inline Stop button already covers it. */
  latestActive: boolean;
  /** An active job that is NOT the latest turn — i.e. an earlier task stranded
      behind a newer, already-finished turn. Drives the session-active banner.
      null when there's no such stranded job. */
  strandedActiveId: string | null;
}

/** Compute the composer control state. Deterministic; order-independent w.r.t.
    which frame/seed arrived first (the cache already reconciled that). */
export function deriveSessionControl(turns: Job[], cacheActiveIds: string[] = []): SessionControl {
  // Oldest-first union: active jobs visible in the transcript, then any active
  // job known only to the cache (scrolled out of the page).
  const seen = new Set<string>();
  const activeJobIds: string[] = [];
  for (const t of turns) {
    if (isLiveRun(t) && !seen.has(t.id)) { seen.add(t.id); activeJobIds.push(t.id); }
  }
  for (const id of cacheActiveIds) {
    if (!seen.has(id)) { seen.add(id); activeJobIds.push(id); }
  }

  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const lastTurnId = lastTurn?.id ?? null;
  const latestActive = lastTurnId != null && seen.has(lastTurnId);
  const sessionActive = activeJobIds.length > 0;
  const controlJobId = !sessionActive
    ? null
    : latestActive
      ? lastTurnId
      : activeJobIds[0];
  const strandedActiveId = activeJobIds.find(id => id !== lastTurnId) ?? null;

  return { sessionActive, activeJobIds, controlJobId, latestActive, strandedActiveId };
}
