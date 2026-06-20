/* Expo push registration — the CLOSED-app notification path.

   alerts.ts only fires while the app is alive (it reacts to the SSE stream, which
   the OS tears down when the app is backgrounded/killed). This registers the
   phone's Expo push token with the relay; the relay then mirrors the Mac's
   job/approval/schedule events to Expo's push service, so a closed app still gets
   a real OS notification.

   Requirements (one-time, account-level — cannot be done from code):
   - An EAS project id in app config (`extra.eas.projectId`, e.g. via `eas init`).
   - A dev or production build (remote push is NOT available in Expo Go on SDK 53+).
   When the project id is missing, registration logs a hint and no-ops — the
   in-app SSE alerts keep working, only the closed-app path is disabled.

   This module also tracks a live `PushState` so Settings can show the user
   exactly why closed-app pushes are or aren't working without them having to
   read the console. */

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { api, getPairToken } from './api';
import { getStr, setStr } from './storage';

const PUSH_TOKEN = 'maestro.mobile.pushToken';

/** Why closed-app push is or isn't working, surfaced in Settings. */
export type PushPermission = 'granted' | 'denied' | 'undetermined' | 'unknown';
export interface PushState {
  /** EAS project id from app.json/extra.eas.projectId. Required by Expo to mint a token. */
  projectId: string | null;
  /** OS-level notification permission. 'unknown' = haven't queried yet. */
  permission: PushPermission;
  /** Current Expo push token (or last known) — null if not minted. */
  token: string | null;
  /** Confirmed by the relay (it has our token in its persistent store). */
  registered: boolean;
  /** Last failure message, useful when the user asks "why no push". */
  lastError: string | null;
  /** Last time we ran a status check (ms epoch). */
  lastCheckedAt: number;
}

let state: PushState = {
  projectId: projectIdFromConfig(),
  permission: 'unknown',
  token: getStr(PUSH_TOKEN) || null,
  registered: false,
  lastError: null,
  lastCheckedAt: 0,
};

type Listener = (s: PushState) => void;
const listeners = new Set<Listener>();

function emit() {
  for (const cb of listeners) {
    try { cb(state); } catch { /* listener errors must not break push */ }
  }
}

function update(patch: Partial<PushState>): void {
  state = { ...state, ...patch, lastCheckedAt: Date.now() };
  emit();
}

/** The EAS project id required to mint an Expo push token. */
function projectIdFromConfig(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId ?? null;
}

/** Current cached push state. Use refreshPushState() to actively re-check. */
export function getPushState(): PushState {
  return state;
}

/** Subscribe to push state changes; returns an unsubscribe. */
export function subscribePush(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Register (or refresh) this phone's Expo push token with the relay. Idempotent,
    safe to call on every launch and on foreground. Never throws. */
export async function registerForPush(): Promise<void> {
  try {
    if (!getPairToken()) {
      update({ lastError: 'not paired' });
      return; // not paired yet — nothing to register against
    }
    const pid = projectIdFromConfig();
    if (!pid) {
      const msg = 'no EAS projectId — set extra.eas.projectId and use a dev/prod build to enable closed-app notifications';
      console.warn('[push]', msg);
      update({ projectId: null, lastError: msg });
      return;
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    update({ projectId: pid, permission: toPermission(status) });
    if (status !== 'granted') {
      update({ lastError: 'permission denied' });
      return;
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: pid });
    if (!token) {
      update({ lastError: 'Expo did not return a token' });
      return;
    }
    // Always re-register on the relay even if the token is unchanged — the relay's
    // persistent store needs the last_seen bump, and a redeploy might have lost
    // our token (in-memory fallback) even when the local cache thinks otherwise.
    const res = await api.registerPush(token);
    update({ token, registered: true, lastError: null });
    setStr(PUSH_TOKEN, token);
    // Sanity: server returned a count > 0 — log it for diagnostics.
    if (!res?.ok) update({ lastError: 'relay rejected the token' });
  } catch (e) {
    // Expo Go on Android (no remote push), simulators, or a denied permission all
    // land here — degrade to the in-app SSE alerts.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[push] registration skipped:', msg);
    update({ lastError: msg });
  }
}

/** Probe the relay for the current registration state (does it actually have
    our token?). Cheap — used by the Settings status panel on focus. */
export async function refreshPushStatus(): Promise<PushState> {
  try {
    const token = state.token ?? getStr(PUSH_TOKEN) ?? '';
    if (!token) {
      update({ registered: false });
      return state;
    }
    const res = await api.pushStatus(token);
    update({ registered: !!res?.registered, lastError: res?.registered ? null : state.lastError });
  } catch (e) {
    update({ registered: false, lastError: e instanceof Error ? e.message : String(e) });
  }
  return state;
}

/** Drop this phone's token from the relay (called on unpair). */
export async function unregisterPush(): Promise<void> {
  const token = state.token ?? getStr(PUSH_TOKEN);
  if (!token) return;
  try { await api.unregisterPush(token); } catch { /* relay/network down — token expires server-side anyway */ }
  update({ token: null, registered: false });
  setStr(PUSH_TOKEN, '');
}

function toPermission(s: string): PushPermission {
  if (s === 'granted') return 'granted';
  if (s === 'denied') return 'denied';
  if (s === 'undetermined') return 'undetermined';
  return 'unknown';
}
