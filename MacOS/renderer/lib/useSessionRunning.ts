/* App-wide cache of which sessions have an agent job ACTIVELY running.

   The git-state dot (<SessionStateDot/>) reflects PR/branch state, not whether
   the agent is mid-run. This module adds the missing signal — a live per-session
   "running" boolean (+ the set of active job ids) — so session/project icons can
   show a loader while an agent is working, and the composer can keep an Abort
   control wired to the REAL active job.

   ── The model (two bugs this file has had) ──
   A session can hold MANY jobs. "Is the session running?" is **ANY job is a live
   run**, NOT "the newest job is running". The earlier single-entry, newest-
   createdAt-wins cache broke catastrophically when a LATER turn (e.g. an injected
   monitor/scheduled check) completed while an EARLIER real agent job was still
   working: the newest (done) turn overwrote the session entry → the pill went
   idle and the composer lost its Abort while a job was genuinely running and
   racing the same worktree. So the cache now tracks a per-jobId map per session.

   Ordering within a single job is still defended (the original OpenMontage
   "running forever" bug): TERMINAL (done/failed/cancelled) is PERMANENT for a
   job — no later non-terminal frame (a relay/native-bridge reorder, or a stale
   async `listJobs` seed captured mid-run) can regress it; same-job frames are
   ordered by the monotonic per-write `updatedAt`.

   Background tasks NEVER reach this cache — it is driven purely by `job` events,
   so a live server can never, by itself, make a session look like it's running. */

import React from 'react';
import { api, type Job } from './api';
import { isLiveRun, isTerminalStatus } from './jobStatus';

export { isLiveRun, isTerminalStatus };

type Listener = () => void;

/** What we remember about ONE job. */
export interface RunEntry {
  jobId: string;
  createdAt: number;
  /** updatedAt of the last frame we applied — the monotonic same-job clock. */
  updatedAt: number;
  /** Reached a terminal status? Then `running` is frozen false for this job. */
  terminal: boolean;
  running: boolean;
}

/** The subset of a Job the reducer reads. */
type RunInput = Pick<Job, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'pausedUntil'>;

/** Cap on jobs retained per session — the map keeps every ACTIVE job plus recent
    terminal ones (so a late stale frame can be rejected by the terminal latch);
    older terminal entries are pruned. Comfortably above any realistic live turn
    count for one session. */
const MAX_PER_SESSION = 128;

/** sessionId → (jobId → entry). */
const bySession = new Map<string, Map<string, RunEntry>>();
const sessionListeners = new Map<string, Set<Listener>>();
const projectListeners = new Map<string, Set<Listener>>();
const projectOf = new Map<string, string>();
const lazyFetchedSession = new Set<string>();
const lazyFetchedProject = new Set<string>();
let liveStarted = false;

/** PURE. Fold one frame of a SINGLE job into its prior entry. Returns `prev`
    (same reference) when the frame is stale/ignored. Terminal is permanent;
    same-job frames are ordered by `updatedAt`. */
export function reduceRun(prev: RunEntry | undefined, j: RunInput): RunEntry {
  const incoming: RunEntry = {
    jobId: j.id,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    terminal: isTerminalStatus(j.status),
    running: isLiveRun(j),
  };
  if (!prev) return incoming;
  if (prev.terminal) return prev;            // terminal is permanent — never regress
  if (j.updatedAt < prev.updatedAt) return prev; // stale / out-of-order frame
  return incoming;
}

/** Active (live-running) job ids for a session map, OLDEST first. */
function activeIdsOf(m: Map<string, RunEntry> | undefined): string[] {
  if (!m) return [];
  const active = [...m.values()].filter(e => e.running);
  active.sort((a, b) => (a.createdAt - b.createdAt) || a.jobId.localeCompare(b.jobId));
  return active.map(e => e.jobId);
}

/** Bound memory: drop the oldest TERMINAL entries once a session exceeds the cap.
    Active entries are never pruned. */
function pruneTerminal(m: Map<string, RunEntry>): void {
  if (m.size <= MAX_PER_SESSION) return;
  const terminals = [...m.values()].filter(e => e.terminal).sort((a, b) => a.updatedAt - b.updatedAt);
  let excess = m.size - MAX_PER_SESSION;
  for (const e of terminals) { if (excess <= 0) break; m.delete(e.jobId); excess--; }
}

function notifySession(sessionId: string): void {
  const ls = sessionListeners.get(sessionId);
  if (ls) for (const cb of ls) cb();
}
function notifyProject(sessionId: string): void {
  const proj = projectOf.get(sessionId);
  if (!proj) return;
  const pls = projectListeners.get(proj);
  if (pls) for (const cb of pls) cb();
}

/** Apply one `job` event/snapshot. The SINGLE entry point for the live
    subscription AND the async `listJobs` seed, so the seed can never clobber a
    fresher live frame (shared `reduceRun` ordering). Wakes subscribers only when
    the session's ACTIVE job set actually changes. */
export function applyJobEvent(j: Job): void {
  if (!j.sessionId) return;
  projectOf.set(j.sessionId, j.projectId);
  let m = bySession.get(j.sessionId);
  if (!m) { m = new Map(); bySession.set(j.sessionId, m); }
  const prev = m.get(j.id);
  const next = reduceRun(prev, j);
  if (next === prev) return; // stale/ignored — nothing changed
  const before = activeIdsOf(m).join('|');
  const beforeRunning = before.length > 0;
  m.set(j.id, next);
  pruneTerminal(m);
  const afterIds = activeIdsOf(m);
  const after = afterIds.join('|');
  if (after === before) return; // active set unchanged — no re-render needed
  notifySession(j.sessionId);
  if ((afterIds.length > 0) !== beforeRunning) notifyProject(j.sessionId);
}

/** True if the session has ANY live agent job. */
export function getSessionRunning(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const m = bySession.get(sessionId);
  if (!m) return false;
  for (const e of m.values()) if (e.running) return true;
  return false;
}

/** All live agent job ids for the session, OLDEST first (the oldest is the one
    most likely stranded behind a newer, already-finished turn). */
export function getSessionActiveJobIds(sessionId: string | null | undefined): string[] {
  if (!sessionId) return [];
  return activeIdsOf(bySession.get(sessionId));
}

/** True if ANY of the given sessions has a live agent job. */
export function getProjectRunning(sessionIds: string[]): boolean {
  for (const sid of sessionIds) if (getSessionRunning(sid)) return true;
  return false;
}

function ensureLive(): void {
  if (liveStarted) return;
  liveStarted = true;
  api.subscribe({ onJob: (j) => applyJobEvent(j) });
}

function subscribeSession(sessionId: string, cb: Listener): () => void {
  ensureLive();
  let set = sessionListeners.get(sessionId);
  if (!set) { set = new Set(); sessionListeners.set(sessionId, set); }
  set.add(cb);
  return () => { set?.delete(cb); };
}

function subscribeProject(projectId: string, cb: Listener): () => void {
  ensureLive();
  let set = projectListeners.get(projectId);
  if (!set) { set = new Set(); projectListeners.set(projectId, set); }
  set.add(cb);
  return () => { set?.delete(cb); };
}

/** Seed the cache for one session from the server's job list — covers EVERY job
    (not just the latest) so an older still-running turn is represented. */
function ensureSessionFetched(sessionId: string): void {
  if (lazyFetchedSession.has(sessionId)) return;
  lazyFetchedSession.add(sessionId);
  api.listJobs(undefined, sessionId).then(js => {
    for (const j of js) applyJobEvent(j);
  }).catch(() => { lazyFetchedSession.delete(sessionId); });
}

/** Seed the cache for a whole project (every session under it). */
function ensureProjectFetched(projectId: string): void {
  if (lazyFetchedProject.has(projectId)) return;
  lazyFetchedProject.add(projectId);
  api.listJobs(projectId).then(js => {
    for (const j of js) applyJobEvent(j);
  }).catch(() => { lazyFetchedProject.delete(projectId); });
}

/** True if the session has any live agent job. Re-renders when that flips. */
export function useSessionRunning(sessionId: string | null | undefined): boolean {
  const id = sessionId ?? '';
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!id) return;
    const unsub = subscribeSession(id, force);
    ensureSessionFetched(id);
    return unsub;
  }, [id]);
  return getSessionRunning(id);
}

/** The session's live agent job ids (oldest first). Stable array reference while
    the set is unchanged, so effects keyed on it don't churn. */
export function useSessionActiveJobs(sessionId: string | null | undefined): string[] {
  const id = sessionId ?? '';
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!id) return;
    const unsub = subscribeSession(id, force);
    ensureSessionFetched(id);
    return unsub;
  }, [id]);
  const ids = getSessionActiveJobIds(id);
  const key = ids.join('|');
  const ref = React.useRef<{ key: string; arr: string[] }>({ key: '', arr: [] });
  if (ref.current.key !== key) ref.current = { key, arr: ids };
  return ref.current.arr;
}

/** True if ANY of the project's sessions has a live agent job. Re-renders on any
    flip within the project. */
export function useProjectRunning(projectId: string | null | undefined, sessionIds: string[]): boolean {
  const pid = projectId ?? '';
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!pid) return;
    const unsubs = sessionIds.map(sid => { projectOf.set(sid, pid); return subscribeSession(sid, force); });
    const projUnsub = subscribeProject(pid, force);
    ensureProjectFetched(pid);
    return () => { unsubs.forEach(u => u()); projUnsub(); };
  }, [pid, sessionIds.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pid) return false;
  return getProjectRunning(sessionIds);
}

/** Test/dev seam: clear the cache between tests. */
export function _resetRunningCacheForTests(): void {
  bySession.clear();
  sessionListeners.clear();
  projectListeners.clear();
  projectOf.clear();
  lazyFetchedSession.clear();
  lazyFetchedProject.clear();
  liveStarted = false;
}
