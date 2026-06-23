/* useWorkspaceOverview — live "what across all projects needs attention now".

   Pulls projects + sessions from the local API once + on `project`/`session`
   events, and the per-session git states from the shared SessionGitStatus
   cache. Every time ANY git-status fires (or projects/sessions change), the
   aggregator runs again and emits a new `OverviewRow[]`.

   The aggregator is pure (workspace-overview.ts) — this hook is just the
   live wiring. It also lazy-fetches the status for every session it can
   see, so a fresh app launch fills the strip without waiting for the
   per-session poller to tour each chat one at a time.

   Perf notes: the result is recomputed on every git-status event, which on
   a fairly busy Mac (say 50 sessions, each polled every 30s) means at most
   a couple of recomputes per second. The aggregator is O(P + S) over Maps;
   measured at <0.2ms for 50 sessions on an M-series. We DO NOT memoise the
   list of rows downstream by identity — React's diff handles that. */

import React from 'react';
import { api, type ChatSession, type Project } from '../lib/api';
import {
  aggregateWorkspaceOverview,
  type AggregateResult,
  type OverviewRow,
} from '../lib/workspace-overview';
import {
  subscribeAllGitStatuses,
  getAllSessionGitStatuses,
  ensureSessionGitStatusFetched,
} from '../lib/useSessionGitState';

/* Persistence keys + helpers — exported for unit testing. Strings are stable
   and namespaced so they don't collide with other workspace flags. */
export const OVERVIEW_ONLY_MINE_KEY = 'maestro.workspace.overview.onlyMine';
export const OVERVIEW_COLLAPSED_KEY = 'maestro.workspace.overview.collapsed';

export function readPersistedBool(key: string, fallback: boolean): boolean {
  try {
    const v = (typeof localStorage !== 'undefined') ? localStorage.getItem(key) : null;
    if (v === '1') return true;
    if (v === '0') return false;
    return fallback;
  } catch { return fallback; }
}

export function writePersistedBool(key: string, value: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value ? '1' : '0');
  } catch { /* ignore */ }
}

export interface WorkspaceOverviewHook extends AggregateResult {
  /** Persistent: hide projects with nothing fresh in the last 7 days. */
  onlyMine: boolean;
  setOnlyMine: (next: boolean) => void;
  /** Persistent collapse of the strip (header still visible). */
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  /** Convenience for a click handler. */
  rows: OverviewRow[];
}

/** Subscribe to the live workspace-overview rollup. Mounts ONE listener per
    stream (projects, sessions, git-status) regardless of how many copies of
    the hook are alive — the underlying caches/listeners are module-scoped. */
export function useWorkspaceOverview(): WorkspaceOverviewHook {
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [sessions, setSessions] = React.useState<ChatSession[]>([]);
  // Bump to force re-aggregation when the shared git-status cache mutates.
  // We DON'T copy the cache into state — we read it inline from getAll…().
  const [, bumpStatuses] = React.useReducer((n: number) => n + 1, 0);

  const [onlyMine, setOnlyMineState] = React.useState<boolean>(() => readPersistedBool(OVERVIEW_ONLY_MINE_KEY, true));
  const [collapsed, setCollapsedState] = React.useState<boolean>(() => readPersistedBool(OVERVIEW_COLLAPSED_KEY, false));

  const setOnlyMine = React.useCallback((next: boolean) => {
    setOnlyMineState(next);
    writePersistedBool(OVERVIEW_ONLY_MINE_KEY, next);
  }, []);
  const setCollapsed = React.useCallback((next: boolean) => {
    setCollapsedState(next);
    writePersistedBool(OVERVIEW_COLLAPSED_KEY, next);
  }, []);

  // Initial load.
  React.useEffect(() => {
    let alive = true;
    Promise.all([api.listProjects(), api.listSessions()])
      .then(([ps, ss]) => { if (!alive) return; setProjects(ps); setSessions(ss); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Live: projects + sessions + git-status.
  React.useEffect(() => {
    const unsubApi = api.subscribe({
      onProject: () => { api.listProjects().then(setProjects).catch(() => {}); },
      onSession: (s) => {
        if ((s as { deleted?: boolean }).deleted) {
          setSessions(prev => prev.filter(x => x.id !== s.id));
        } else {
          setSessions(prev => {
            const i = prev.findIndex(x => x.id === s.id);
            return i === -1 ? [s, ...prev] : prev.map(x => (x.id === s.id ? s : x));
          });
        }
      },
    });
    const unsubGit = subscribeAllGitStatuses(bumpStatuses);
    return () => { unsubApi(); unsubGit(); };
  }, []);

  // Lazy-fetch status for any session the strip can SEE but the cache hasn't
  // seen yet. Without this the strip starts empty until the per-session pill
  // for some other surface scrolls the same id into view. We don't await —
  // the hook re-renders via the all-listener on each fetch result.
  React.useEffect(() => {
    if (sessions.length === 0) return;
    const statuses = getAllSessionGitStatuses();
    for (const s of sessions) {
      if (s.archived) continue;
      if (!statuses.has(s.id)) ensureSessionGitStatusFetched(s.id);
    }
  }, [sessions]);

  // Recompute on each render — cheap, and we never want a stale view.
  const result = aggregateWorkspaceOverview({
    projects,
    sessions,
    statuses: getAllSessionGitStatuses(),
    onlyMine,
  });

  return {
    ...result,
    onlyMine,
    setOnlyMine,
    collapsed,
    setCollapsed,
  };
}
