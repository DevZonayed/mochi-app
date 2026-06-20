/* Persisted key/value for the mobile app.

   Backed by AsyncStorage (works on native AND Expo web), fronted by a synchronous
   in-memory cache so the rest of the app can read settings without awaiting. Call
   `hydrate()` once at startup (App.tsx gates render on it) to load the cache; after
   that, reads are sync and writes are write-through (cache + async persist). */

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'maestro.mobile.';
const cache = new Map<string, string>();

/** Load all persisted keys into the cache. Resolves even if storage is unavailable. */
export async function hydrate(): Promise<void> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
    if (keys.length) {
      const pairs = await AsyncStorage.multiGet(keys);
      for (const [k, v] of pairs) if (v != null) cache.set(k, v);
    }
  } catch {
    /* storage unavailable — run with an empty cache */
  }
}

export function getFlag(key: string): boolean {
  return cache.get(key) === '1';
}

export function setFlag(key: string, val: boolean): void {
  setStr(key, val ? '1' : '0');
}

export const ONBOARDED = 'maestro.mobile.onboarded';
/** Legacy pairing-code token (kept only so old installs can be migrated/cleared). */
export const PAIR_TOKEN = 'maestro.mobile.token';
/** Account session token (Better Auth) — sent as `Authorization: Bearer` on /api/*
    and `?token=` on the /ws/remote stream. Replaces the pairing code. */
export const SESSION_TOKEN = 'maestro.mobile.sessionToken';
/** The currently-selected host (Mac) this phone is controlling — its device id.
    All sync/commands/live-stream are scoped to this host. */
export const ACTIVE_HOST = 'maestro.mobile.activeHost';
/** Stable per-install device id (minted once) so the account can list + manage THIS device. */
export const DEVICE_ID = 'maestro.mobile.deviceId';
/** Which AppEvent kinds surface in the Activity feed (per-category toggles). */
export const NOTIF_PREFS = 'maestro.mobile.notifPrefs';
/** Require device biometrics (Face ID / fingerprint) before approving a gate. */
export const BIOMETRIC_GATE = 'maestro.mobile.biometricGate';
/** This device's last-registered Expo push token. */
export const PUSH_TOKEN = 'maestro.mobile.pushToken';
/** Delta-sync watermark — server `at` from the last successful /api/sync pull.
    Drives the next pull's `?since=` so the relay only returns the delta. */
export const LAST_SYNC = 'maestro.mobile.lastSync';

export function getStr(key: string): string {
  return cache.get(key) ?? '';
}
export function setStr(key: string, val: string): void {
  cache.set(key, val);
  void AsyncStorage.setItem(key, val).catch(() => {});
}

/** Persisted JSON (falls back to `dflt` when missing or unparseable). */
export function getJSON<T>(key: string, dflt: T): T {
  const raw = cache.get(key);
  if (!raw) return dflt;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return dflt;
  }
}
export function setJSON(key: string, val: unknown): void {
  setStr(key, JSON.stringify(val));
}

/* ── Data cache (projects, sessions, chats) ───────────────────────────────
   Cache-then-network: screens read the cache for an instant render, then
   refresh from the relay and write back. Survives restarts; cleared only on
   unpair (clearCache) — i.e. "logout", or uninstalling clears it with the app. */
const CACHE_PREFIX = `${PREFIX}cache.`;

export function cacheGet<T>(key: string, dflt: T): T {
  return getJSON(CACHE_PREFIX + key, dflt);
}
export function cacheSet(key: string, val: unknown): void {
  setJSON(CACHE_PREFIX + key, val);
}

/* ── Session "live" cache ─────────────────────────────────────────────────
   The persistent cacheGet/cacheSet pair is great for cold-start UX but is the
   wrong source on re-mount: AsyncStorage can hold the user's projects from a
   previous Mac state (renamed/deleted/imported) and flash that ghost set
   between the new mount's first paint and the live `load()` resolving. This
   in-memory mirror is seeded by `liveSet()` whenever a fresh API response
   lands, so subsequent screen mounts inside the same session read REAL data
   instead of the disk's snapshot. Cleared on app cold-start and on unpair. */
const live = new Map<string, unknown>();

/** Read the most-recently-loaded value for `key` if we have one this session,
    otherwise fall back to the persisted cache. */
export function liveGet<T>(key: string, dflt: T): T {
  if (live.has(key)) return live.get(key) as T;
  return cacheGet(key, dflt);
}

/** Persist a fresh API response to both the in-memory session mirror and the
    on-disk cache. Screens that previously called `cacheSet` should call this
    instead so re-mounts see the new value instead of the disk snapshot. */
export function liveSet(key: string, val: unknown): void {
  live.set(key, val);
  cacheSet(key, val);
}

/** Wipe all cached data (called on unpair). Keeps non-cache prefs intact.
    Also resets the unified SyncStore + delta cursor so a fresh pairing can't
    inherit the prior account's slice. */
export async function clearCache(): Promise<void> {
  live.clear();
  const keys = [...cache.keys()].filter((k) => k.startsWith(CACHE_PREFIX));
  for (const k of keys) cache.delete(k);
  try { await AsyncStorage.multiRemove(keys); } catch { /* ignore */ }
  // Reset the delta cursor (in-memory + persisted).
  cache.delete(LAST_SYNC);
  try { await AsyncStorage.removeItem(LAST_SYNC); } catch { /* ignore */ }
  // Forget the active host so a fresh sign-in re-picks from the new account's hosts.
  cache.delete(ACTIVE_HOST);
  try { await AsyncStorage.removeItem(ACTIVE_HOST); } catch { /* ignore */ }
  // Drop the unified store (project/sessions/jobs/approvals/assets/events).
  // Done lazily to avoid an import cycle with syncStore → storage.
  try {
    const mod = await import('./syncStore');
    await mod.resetSyncStore();
  } catch { /* syncStore not loaded yet */ }
}
