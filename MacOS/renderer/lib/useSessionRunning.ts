/* App-wide cache of which sessions have a job ACTIVELY running.

   The git-state dot (<SessionStateDot/>) reflects PR/branch state, not whether
   the agent is mid-run. This module adds the missing signal — a live per-session
   "running" boolean — so session/project icons can show a smooth loader while an
   agent is working, and drop back to the git-state dot the instant it finishes.

   Same shape as useSessionGitState: ONE event subscription drives a single
   module-scope map (sessionId → running). Hooks subscribe via a tiny pub/sub so
   a running-state flip for session A re-renders only A's pill. The cache lives
   outside React so it spans navigation + mount churn. */

import React from 'react';
import { api, type Job } from './api';

type Listener = () => void;

/** sessionId → is the session's latest job actively running? */
const running = new Map<string, boolean>();
/** sessionId → createdAt of the job that last set the running flag, so a stale
    out-of-order event for an older job can't clobber the newest job's state. */
const latestAt = new Map<string, number>();
/** sessionId → listener set, for per-session subscribers. */
const sessionListeners = new Map<string, Set<Listener>>();
/** project:<id> → listener set, for the project rollup (any session running). */
const projectListeners = new Map<string, Set<Listener>>();
/** sessionId → projectId, so a job event knows which project rollup to wake. */
const projectOf = new Map<string, string>();
const lazyFetchedSession = new Set<string>();
const lazyFetchedProject = new Set<string>();
let liveStarted = false;

/** A paused-on-wakeup job (SDK iterator dormant) is NOT "running" for UI
    purposes — it presents as "session closed, auto-resumes later". */
function isLiveRun(j: Job): boolean {
  if (j.status !== 'running' && j.status !== 'pending') return false;
  if (j.pausedUntil && j.pausedUntil > Date.now()) return false;
  return true;
}

function setRunning(sessionId: string, value: boolean, at: number): void {
  const prev = latestAt.get(sessionId) ?? -1;
  if (at < prev) return; // stale event for an older job — ignore
  latestAt.set(sessionId, at);
  if (running.get(sessionId) === value && prev === at) return;
  running.set(sessionId, value);
  const ls = sessionListeners.get(sessionId);
  if (ls) for (const cb of ls) cb();
  const proj = projectOf.get(sessionId);
  if (proj) {
    const pls = projectListeners.get(proj);
    if (pls) for (const cb of pls) cb();
  }
}

function ensureLive(): void {
  if (liveStarted) return;
  liveStarted = true;
  api.subscribe({
    onJob: (j) => {
      if (!j.sessionId) return;
      projectOf.set(j.sessionId, j.projectId);
      setRunning(j.sessionId, isLiveRun(j), j.createdAt);
    },
  });
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

/** Seed the cache for one session from the server's job list (the latest job
    decides its running state). Cheap + only runs once per session id. */
function ensureSessionFetched(sessionId: string): void {
  if (lazyFetchedSession.has(sessionId)) return;
  lazyFetchedSession.add(sessionId);
  api.listJobs(undefined, sessionId).then(js => {
    if (!js.length) return;
    js.sort((a, b) => b.createdAt - a.createdAt);
    const latest = js[0];
    if (latest?.sessionId) setRunning(latest.sessionId, isLiveRun(latest), latest.createdAt);
  }).catch(() => {});
}

/** Seed the cache for a whole project (covers every session under it so the
    project-icon rollup is correct without N per-session fetches). */
function ensureProjectFetched(projectId: string): void {
  if (lazyFetchedProject.has(projectId)) return;
  lazyFetchedProject.add(projectId);
  api.listJobs(projectId).then(js => {
    for (const j of js) if (j.sessionId) setRunning(j.sessionId, isLiveRun(j), j.createdAt);
  }).catch(() => {});
}

/** True if the session's latest job is actively running. Re-renders on flip. */
export function useSessionRunning(sessionId: string | null | undefined): boolean {
  const id = sessionId ?? '';
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!id) return;
    const unsub = subscribeSession(id, force);
    ensureSessionFetched(id);
    return unsub;
  }, [id]);
  if (!id) return false;
  return running.get(id) === true;
}

/** True if ANY of the project's sessions is actively running. Re-renders on any
    flip within the project. Pass the live sessionIds list (whatever the caller
    already tracks) so new sessions are covered as they're created. */
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
  for (const sid of sessionIds) if (running.get(sid) === true) return true;
  return false;
}

/** Test/dev seam: clear the cache between tests. */
export function _resetRunningCacheForTests(): void {
  running.clear();
  latestAt.clear();
  sessionListeners.clear();
  projectListeners.clear();
  projectOf.clear();
  lazyFetchedSession.clear();
  lazyFetchedProject.clear();
  liveStarted = false;
}
