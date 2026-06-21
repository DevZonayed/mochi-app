/* Unified persistent store for the mobile app — single source of truth fed by
   delta-sync (GET /api/sync?since=<ts>) for catch-up and SSE for live updates.
   Replaces the per-screen cache-then-network pattern that caused ghost data and
   inconsistent payloads.

   Design:
   - One in-memory state object holds projects + sessions + jobs + approvals +
     assets + events. Each entity is upserted by id; tombstones remove ids.
   - `lastSync` (the server `at` from the last successful pull) is the cursor
     for the next pull's `?since=` query and the SSE stream's `?since=`.
   - State is persisted to AsyncStorage debounced 500 ms so a cold-start opens
     immediately to the previous slice while a fresh `pullSync()` is in flight.
   - Screens subscribe via `useSyncStore(selector)` (React 19's
     `useSyncExternalStore`). The selector picks the slice the screen needs;
     re-renders only fire when its value changes by `Object.is`.
   - `applyLiveEvent` and `pullSync` share the same upsert path so the SSE
     stream and the REST delta can't drift.

   Concurrency: there's a single `pullSync` in flight at a time (re-entrant
   calls await the same promise). SSE events that arrive during a pull are
   merged after — they only bump entities we already have or are about to. */

import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  api, snapshotToDelta,
  type Project, type ChatSession, type Job, type Approval, type Asset, type AppEvent,
  type SyncDelta, type LiveEventName, type SnapshotShape,
} from './api';
import { getJSON, getStr, setStr, LAST_SYNC } from './storage';
import { getActiveHost } from './auth';
import { classifySyncError, type SyncErrorKind } from './syncErrors';

/* ── State shape ───────────────────────────────────────────────────────── */

export interface SyncState {
  projects: Project[];
  sessions: ChatSession[];
  jobs: Job[];
  approvals: Approval[];
  assets: Asset[];
  events: AppEvent[];
  /** Server `at` from the last successful /api/sync. 0 = never synced. */
  lastSync: number;
  /** Mac connectivity, learned from the most recent sync or SSE `host` event. */
  hostOnline: boolean;
  /** True once we've completed at least one SUCCESSFUL sync this session. Drives
      the "showing last known state" affordance and the empty-vs-data decision. */
  bootstrapped: boolean;
  /** True once at least one sync ATTEMPT has settled (success OR failure). This
      is what flips screens out of the skeleton — a failed first attempt must not
      leave them spinning forever; they fall through to a reconnect/empty state. */
  settled: boolean;
  /** Set when the last sync attempt failed; null after any success. Lets screens
      show a precise, actionable message (re-pair / Mac offline / retry) instead
      of an endless spinner when the phone is on a stale or disconnected deck. */
  syncError: SyncErrorKind | null;
  /** True while a `pullSync()` is in flight (drives the small header spinner). */
  syncing: boolean;
}

const EMPTY_STATE: SyncState = {
  projects: [], sessions: [], jobs: [], approvals: [], assets: [], events: [],
  lastSync: 0, hostOnline: false, bootstrapped: false, settled: false, syncError: null, syncing: false,
};

/* ── Persistence (keyed by active host) ─────────────────────────────────────
   Each host (Mac) gets its OWN persisted slice so switching the active host
   shows that Mac's data cleanly, with no bleed-through from the previous one. */

const STORAGE_PREFIX = 'maestro.mobile.syncStore.v2.';
function storageKey(): string { return STORAGE_PREFIX + (getActiveHost() || 'none'); }

interface PersistShape {
  projects: Project[]; sessions: ChatSession[]; jobs: Job[];
  approvals: Approval[]; assets: Asset[]; events: AppEvent[];
  lastSync: number;
}

function loadFromStorage(): SyncState {
  const persisted = getJSON<PersistShape | null>(storageKey(), null);
  const ls = Number(getStr(LAST_SYNC)) || 0;
  if (!persisted) return { ...EMPTY_STATE, lastSync: ls };
  return {
    projects: persisted.projects ?? [],
    sessions: persisted.sessions ?? [],
    jobs: persisted.jobs ?? [],
    approvals: persisted.approvals ?? [],
    assets: persisted.assets ?? [],
    events: persisted.events ?? [],
    lastSync: persisted.lastSync ?? ls,
    hostOnline: false,
    bootstrapped: false,
    settled: false,
    syncError: null,
    syncing: false,
  };
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persist(): void {
  if (persistTimer) return; // already scheduled
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot: PersistShape = {
      projects: state.projects, sessions: state.sessions, jobs: state.jobs,
      approvals: state.approvals, assets: state.assets, events: state.events,
      lastSync: state.lastSync,
    };
    void AsyncStorage.setItem(storageKey(), JSON.stringify(snapshot)).catch(() => { /* storage full / unmount — try next time */ });
    if (state.lastSync) setStr(LAST_SYNC, String(state.lastSync));
  }, 500);
}

/* ── Subscription wiring (useSyncExternalStore) ────────────────────────── */

let state: SyncState = loadFromStorage();
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) { try { cb(); } catch { /* ignore broken listener */ } }
}
function subscribe(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }
function getSnapshot(): SyncState { return state; }

/** Subscribe to a slice of the sync store. Re-renders the calling component
    only when the selector's return value changes by `Object.is`.

    Uses `useSyncExternalStoreWithSelector` (not the bare `useSyncExternalStore`)
    so the selection is MEMOIZED per snapshot: the selector only re-runs when the
    underlying `state` reference actually changes. This makes derived selectors —
    `(s) => s.jobs.filter(...).sort(...)` — safe. With the bare hook those return
    a fresh array on every call, which React reads as "store changed" on every
    render → "The result of getSnapshot should be cached" → "Maximum update depth
    exceeded". Memoizing here removes that whole class of bug for every screen. */
export function useSyncStore<T>(selector: (s: SyncState) => T): T {
  return useSyncExternalStoreWithSelector(subscribe, getSnapshot, getSnapshot, selector);
}

/** Read the current state outside of a React component (for one-shot uses
    inside callbacks, schedulers, etc.). */
export function readSyncStore(): SyncState { return state; }

/* ── Upsert / delete helpers ───────────────────────────────────────────── */

type IdEntity = { id: string };

/** Merge an incoming list into a current list by `id`. Newer items (in
    `incoming`) take precedence over current items with the same id. Items not
    present in either side keep their position; new ids are appended. Stable
    enough that screens can apply their own sort on top. */
function upsertById<T extends IdEntity>(current: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return current;
  const byId = new Map<string, T>();
  for (const c of current) byId.set(c.id, c);
  for (const i of incoming) byId.set(i.id, i);
  return [...byId.values()];
}

function removeIds<T extends IdEntity>(list: T[], ids: string[]): T[] {
  if (ids.length === 0) return list;
  const drop = new Set(ids);
  return list.filter((x) => !drop.has(x.id));
}

/* ── pullSync — REST catch-up ──────────────────────────────────────────── */

let inflightPull: Promise<void> | null = null;

/** Pull the delta since the last sync and merge it into the store. Re-entrant:
    calls during an in-flight pull share the same promise. */
export function pullSync(): Promise<void> {
  if (inflightPull) return inflightPull;
  state = { ...state, syncing: true };
  notify();
  inflightPull = (async () => {
    try {
      const delta: SyncDelta = await api.sync(state.lastSync);
      applyDelta(delta);
    } catch (e) {
      // Network / 503 (Mac offline) / 401 (token rejected) — keep current state
      // (screens still render from the persisted snapshot) but RECORD the failure
      // and mark the attempt settled, so a failed first sync flips screens out of
      // the skeleton into an actionable reconnect/offline state instead of an
      // endless spinner. A 401 separately bounces to re-pair (see api.req).
      console.warn('[sync] pull failed:', e instanceof Error ? e.message : e);
      state = { ...state, settled: true, syncError: classifySyncError(e) };
      notify();
    } finally {
      state = { ...state, syncing: false };
      notify();
      inflightPull = null;
    }
  })();
  return inflightPull;
}

/** Pull only when our cached snapshot is older than `maxAgeMs` AND we're not
    already pulling. Wired into screen focus effects so flipping back to a tab
    we visited 200 ms ago doesn't re-trigger /api/sync (the live WS already kept
    the store fresh) — that's what caused the constant "loading" spinner flash
    on Projects / ProjectSessions. The first call (cold-start, `bootstrapped`
    false) always goes through. Returns the same promise as `pullSync` when it
    actually fires, else a resolved no-op. */
export function pullSyncIfStale(maxAgeMs = 8000): Promise<void> {
  if (inflightPull) return inflightPull;
  // Cold start, host switch, or never-synced — always pull.
  if (!state.bootstrapped || !state.lastSync) return pullSync();
  if (Date.now() - state.lastSync < maxAgeMs) return Promise.resolve();
  return pullSync();
}

/** Apply a delta envelope (REST or — in the future — a stitched SSE batch). */
function applyDelta(delta: SyncDelta): void {
  const c = delta.changed;
  const d = delta.deleted;
  let projects = upsertById(state.projects, c.projects);
  let sessions = upsertById(state.sessions, c.sessions);
  let jobs = upsertById(state.jobs, c.jobs);
  let approvals = upsertById(state.approvals, c.approvals);
  let assets = upsertById(state.assets, c.assets);
  let events = upsertById(state.events, c.events);
  projects = removeIds(projects, d.projects);
  sessions = removeIds(sessions, d.sessions);
  jobs = removeIds(jobs, d.jobs);
  approvals = removeIds(approvals, d.approvals);
  assets = removeIds(assets, d.assets);
  // Cap events to the last 200 so the persistent slice doesn't grow unbounded.
  events = events.sort((a, b) => b.ts - a.ts).slice(0, 200);
  state = {
    ...state,
    projects, sessions, jobs, approvals, assets, events,
    lastSync: delta.at,
    hostOnline: delta.host.online,
    bootstrapped: true,
    settled: true,
    syncError: null, // a successful pull clears any prior failure
  };
  persist();
  notify();
}

/* ── Live events — SSE plumbing into the same upsert path ──────────────── */

/** Drop an SSE/P2P event into the store. Recognises the same event names the
    Mac emits + the relay's one-shot `replay` frames. */
export function applyLiveEvent(name: LiveEventName, data: unknown): void {
  // The /ws/remote `hello` frame carries the active host's FULL snapshot — apply
  // it as a delta (full upsert + tombstones) so a fresh connect catches up
  // immediately, and mark the host online (it just spoke to us). Mirrors pullSync.
  if (name === 'hello') {
    applyDelta(snapshotToDelta('', (data as SnapshotShape | null) ?? null));
    if (!state.hostOnline) { state = { ...state, hostOnline: true }; notify(); }
    return;
  }
  if (data === null || typeof data !== 'object') return;
  let touched = false;
  if (name === 'job') {
    const j = data as Job;
    if (j.id) { state = { ...state, jobs: upsertById(state.jobs, [j]) }; touched = true; }
  } else if (name === 'session') {
    const s = data as ChatSession;
    if (s.id) { state = { ...state, sessions: upsertById(state.sessions, [s]) }; touched = true; }
  } else if (name === 'approval') {
    const a = data as Approval;
    if (a.id) { state = { ...state, approvals: upsertById(state.approvals, [a]) }; touched = true; }
  } else if (name === 'asset') {
    const a = data as Asset;
    if (a.id) { state = { ...state, assets: upsertById(state.assets, [a]) }; touched = true; }
  } else if (name === 'host') {
    const h = data as { online?: boolean };
    if (typeof h.online === 'boolean') { state = { ...state, hostOnline: h.online }; touched = true; }
  } else if (name === 'replay') {
    // Replay frames are AppEvents from the Mac's log. Add to events feed;
    // they don't carry entity data, so we trigger a deferred `pullSync` to
    // resolve the underlying state (a single API round-trip catches up).
    const e = data as AppEvent;
    if (e.id && typeof e.ts === 'number') {
      const events = upsertById(state.events, [e]).sort((a, b) => b.ts - a.ts).slice(0, 200);
      state = { ...state, events };
      touched = true;
      schedulePullSoon();
    }
  }
  // Bump the cursor opportunistically — guards against losing events whose
  // updatedAt > lastSync but didn't fire a `replay` (rare, e.g. live updates
  // during a normal session).
  const ts = bumpFromPayload(data);
  if (ts && ts > state.lastSync) { state = { ...state, lastSync: ts }; touched = true; }
  if (touched) { persist(); notify(); }
}

function bumpFromPayload(data: unknown): number {
  if (!data || typeof data !== 'object') return 0;
  const o = data as { updatedAt?: number; ts?: number };
  return o.updatedAt ?? o.ts ?? 0;
}

/* Deferred pull coalescer — multiple SSE events back-to-back collapse into a
   single REST sync so we don't hammer the relay during a live burst. */
let pullSoonTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePullSoon(): void {
  if (pullSoonTimer) return;
  pullSoonTimer = setTimeout(() => { pullSoonTimer = null; void pullSync(); }, 800);
}

/* ── Host switch ───────────────────────────────────────────────────────────
   When the user picks a different Mac, swap the in-memory state to that host's
   persisted slice (instant render of its last-known data) and kick a fresh pull.
   Call AFTER setActiveHost() so storageKey() resolves to the new host. */
export function reloadForActiveHost(): void {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  state = loadFromStorage(); // reads the new host's slice (or EMPTY_STATE if none)
  notify();
  void pullSync();
}

/* ── Reset (called on sign-out / clearCache) ───────────────────────────── */

/** Wipe the store + cursor. Call from `clearCache()` on sign-out so a new
    account/host can't inherit the old data. Clears ALL host slices. */
export async function resetSyncStore(): Promise<void> {
  state = { ...EMPTY_STATE };
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(STORAGE_PREFIX));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  } catch { /* ignore */ }
  setStr(LAST_SYNC, '');
  notify();
}
