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
export const PAIR_TOKEN = 'maestro.mobile.token';
/** Which AppEvent kinds surface in the Activity feed (per-category toggles). */
export const NOTIF_PREFS = 'maestro.mobile.notifPrefs';
/** Require device biometrics (Face ID / fingerprint) before approving a gate. */
export const BIOMETRIC_GATE = 'maestro.mobile.biometricGate';
/** This device's last-registered Expo push token. */
export const PUSH_TOKEN = 'maestro.mobile.pushToken';

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

/** Wipe all cached data (called on unpair). Keeps non-cache prefs intact. */
export async function clearCache(): Promise<void> {
  const keys = [...cache.keys()].filter((k) => k.startsWith(CACHE_PREFIX));
  for (const k of keys) cache.delete(k);
  try { await AsyncStorage.multiRemove(keys); } catch { /* ignore */ }
}
