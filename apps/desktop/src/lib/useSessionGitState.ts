/* App-wide cache of per-session git state.

   Why a cache (not per-component subscribers): the sidebar lists 10+ sessions,
   the project gallery rolls up across MANY sessions, and the chat header reads
   one. Without a shared cache each pill would call `getSessionGitStatus()` on
   mount AND subscribe to `git-status` — N sockets for the same stream. Here:

   • ONE event subscription drives a single in-memory map (sessionId → status).
   • Hooks subscribe to the map via a tiny pub/sub — re-renders are scoped per
     session, so a streaming `git-status` for session A doesn't re-render the
     pill for session B.
   • `useSessionGitState(id)` lazy-fetches on first read and returns live
     updates. `useProjectRollup(projectIds)` returns the worst state per
     project for the gallery dot.

   The cache lives outside React (module-scope) so it spans navigations + mount
   churn. */

import React from 'react';
import { api, type ChatSession } from './api';
import type { SessionGitStatus, SessionGitState } from './git-types';
import { rollupSessionState } from './git-types';

type Listener = () => void;

const cache = new Map<string, SessionGitStatus>();
const listenersByKey = new Map<string, Set<Listener>>();
const lazyFetched = new Set<string>();
let liveStarted = false;
const unknown: SessionGitStatus = {
  sessionId: '',
  branch: null,
  base: null,
  local: { isRepo: false, ahead: 0, behind: 0, dirty: false, pushed: false },
  pr: null,
  state: 'no-repo',
  lastCheckedAt: 0,
};

function ensureLive(): void {
  if (liveStarted) return;
  liveStarted = true;
  // Live updates land here regardless of who's mounted; pills re-render only
  // when their own sessionId fires.
  api.subscribe({
    onGitStatus: (s) => {
      cache.set(s.sessionId, s);
      const ls = listenersByKey.get(s.sessionId);
      if (ls) for (const l of ls) l();
      // Project-rollup listeners watch a synthetic 'project:<id>' key.
      const proj = projectByStatus.get(s.sessionId);
      if (proj) {
        const pls = listenersByKey.get(`project:${proj}`);
        if (pls) for (const l of pls) l();
      }
    },
  });
}

/** Project id we should treat the status as belonging to — populated by the
    rollup hook so a session's status invalidates the right project. */
const projectByStatus = new Map<string, string>();

function subscribe(key: string, cb: Listener): () => void {
  ensureLive();
  let set = listenersByKey.get(key);
  if (!set) { set = new Set(); listenersByKey.set(key, set); }
  set.add(cb);
  return () => {
    const cur = listenersByKey.get(key);
    if (!cur) return;
    cur.delete(cb);
    if (!cur.size) listenersByKey.delete(key);
  };
}

/** Live status for ONE session. Lazy-fetches once per id, re-renders on each
    `git-status` event for that session. */
export function useSessionGitState(sessionId: string | null | undefined): SessionGitStatus | null {
  const id = sessionId ?? '';
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!id) return;
    const unsub = subscribe(id, force);
    if (!lazyFetched.has(id)) {
      lazyFetched.add(id);
      // `withPr:false` is fast (no network); the per-session poller upgrades
      // it with PR facts in the background.
      api.getSessionGitStatus(id, false).then(s => { cache.set(id, s); force(); }).catch(() => {});
    }
    return unsub;
  }, [id]);
  if (!id) return null;
  return cache.get(id) ?? null;
}

/** Just the SessionGitState — convenient for the pill dot. */
export function useSessionStateOnly(sessionId: string | null | undefined): SessionGitState | null {
  const s = useSessionGitState(sessionId);
  return s?.state ?? null;
}

/** Worst-state-wins rollup for a project's sessions. `sessions` is the
    project's chat list (whatever the caller already has); we register each
    one's status for invalidation. */
export function useProjectRollupState(projectId: string | null | undefined, sessionIds: string[]): SessionGitState | null {
  const key = projectId ? `project:${projectId}` : '';
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!projectId) return;
    // Map each session to its project so live invalidation knows whom to wake.
    for (const sid of sessionIds) projectByStatus.set(sid, projectId);
    // Also force a re-render whenever ANY of the session ids fires (in case
    // the project rollup listens before its sessions arrived).
    const unsubs = sessionIds.map(sid => subscribe(sid, force));
    const projUnsub = subscribe(key, force);
    // Lazy-fetch any uncached sessions in this project.
    for (const sid of sessionIds) {
      if (!lazyFetched.has(sid)) {
        lazyFetched.add(sid);
        api.getSessionGitStatus(sid, false).then(s => { cache.set(sid, s); force(); }).catch(() => {});
      }
    }
    return () => { unsubs.forEach(u => u()); projUnsub(); };
  }, [projectId, key, sessionIds.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!projectId) return null;
  const states: SessionGitState[] = [];
  for (const sid of sessionIds) {
    const st = cache.get(sid)?.state;
    if (st && st !== 'no-repo') states.push(st);
  }
  return rollupSessionState(states);
}

/* ── Session metadata cache (codename, title, archived…) ─────────────────
   Same idea as the git-state cache, but for ChatSession fields. The chat
   header reads the active session's codename/title/archived without prop
   drilling, and lazily fetches by listing the project's sessions. Live
   updates over `api.subscribe({ onSession })`. */

const sessionCache = new Map<string, ChatSession>();
const sessionListeners = new Map<string, Set<Listener>>();
let sessionLiveStarted = false;

function ensureSessionLive(): void {
  if (sessionLiveStarted) return;
  sessionLiveStarted = true;
  api.subscribe({
    onSession: (s) => {
      if (s.deleted) {
        sessionCache.delete(s.id);
      } else {
        sessionCache.set(s.id, s as ChatSession);
      }
      const ls = sessionListeners.get(s.id);
      if (ls) for (const l of ls) l();
    },
  });
}

function subscribeSession(id: string, cb: Listener): () => void {
  ensureSessionLive();
  let set = sessionListeners.get(id);
  if (!set) { set = new Set(); sessionListeners.set(id, set); }
  set.add(cb);
  return () => {
    const cur = sessionListeners.get(id);
    if (!cur) return;
    cur.delete(cb);
    if (!cur.size) sessionListeners.delete(id);
  };
}

const sessionLazyFetched = new Set<string>();

/** Live ChatSession by id. Fetches the session's project list on first read
    if needed, then keeps in sync with `session` events. */
export function useSession(sessionId: string | null | undefined, hintProjectId?: string | null): ChatSession | null {
  const id = sessionId ?? '';
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!id) return;
    const unsub = subscribeSession(id, force);
    if (!sessionLazyFetched.has(id)) {
      sessionLazyFetched.add(id);
      // Best path: list sessions for the hint project (cheap and cached on
      // the relay/IPC). Fall back to a global list.
      const fetchList = hintProjectId ? api.listSessions(hintProjectId) : api.listSessions();
      fetchList.then(ss => {
        for (const s of ss) sessionCache.set(s.id, s);
        force();
      }).catch(() => {});
    }
    return unsub;
  }, [id, hintProjectId]);
  if (!id) return null;
  return sessionCache.get(id) ?? null;
}

/** Test/dev seam: clear the cache. Not exported via the public api surface. */
export function _resetGitStateCacheForTests(): void {
  cache.clear();
  listenersByKey.clear();
  lazyFetched.clear();
  projectByStatus.clear();
  liveStarted = false;
}

/** Touch: the unknown sentinel exported for callers who want a value-shaped fallback. */
export const UNKNOWN_GIT_STATUS = unknown;
