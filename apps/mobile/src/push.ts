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

   Diagnostics: every step logs to `console.log('[push] …')` so the operator can
   tail `expo run` and see exactly which gate (auth / projectId / permission /
   simulator / Expo Go / relay error) stopped a registration. The pattern was
   that closed-app push silently failed without any breadcrumb — this gives us
   one. The logs are short, prefixed, and contain no PII other than the first
   12 chars of the Expo token (which is opaque). */

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';
import { isAuthed } from './auth';
import { getStr, setStr } from './storage';

const PUSH_TOKEN = 'maestro.mobile.pushToken';
/** In-memory cache of the most recently REGISTERED token so we don't re-POST
    on every foreground transition. Cleared on sign-out so a sign-in→sign-out→
    sign-in cycle re-registers cleanly. */
let registered = '';

/** The EAS project id required to mint an Expo push token. */
function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
}

/** Trim a token for logs — Expo tokens look like `ExponentPushToken[xxxxx…]`
    and are not secret, but we still don't need the whole thing in stdout. */
function tokenTag(t: string): string { return t ? `${t.slice(0, 22)}…` : '<empty>'; }

/** Register (or refresh) this phone's Expo push token with the relay. Idempotent,
    safe to call on every launch and on foreground. Never throws. */
export async function registerForPush(): Promise<void> {
  try {
    if (!isAuthed()) { console.log('[push] skip — not signed in yet'); return; }

    const pid = projectId();
    if (!pid) {
      console.warn('[push] no EAS projectId — set extra.eas.projectId and use a dev/prod build to enable closed-app notifications');
      return;
    }

    // The web build never has remote push — it's the desktop SSE story.
    if (Platform.OS === 'web') { console.log('[push] skip — web build (no remote push)'); return; }

    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') {
      console.log('[push] requesting notification permission…');
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') {
      console.warn('[push] permission denied — user must enable notifications in OS settings');
      return;
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: pid });
    if (!token) { console.warn('[push] getExpoPushTokenAsync returned empty token'); return; }
    if (token === registered) { console.log('[push] token unchanged, no re-register'); return; }

    console.log(`[push] registering token with relay: ${tokenTag(token)}`);
    const res = await api.registerPush(token);
    console.log(`[push] relay accepted: ok=${res.ok} deviceId=${res.deviceId ?? '?'}`);
    registered = token;
    setStr(PUSH_TOKEN, token);
  } catch (e) {
    // Expo Go on Android (no remote push), denied permissions, or a relay
    // network failure all land here — degrade to the in-app SSE alerts.
    console.warn('[push] registration failed:', e instanceof Error ? e.message : e);
  }
}

/** Drop this phone's token from the relay (called on unpair / sign-out). */
export async function unregisterPush(): Promise<void> {
  const token = registered || getStr(PUSH_TOKEN);
  if (!token) return;
  try {
    await api.unregisterPush();
    console.log('[push] unregistered from relay');
  } catch (e) {
    console.warn('[push] unregister failed (token expires server-side):', e instanceof Error ? e.message : e);
  }
  registered = '';
  setStr(PUSH_TOKEN, '');
}
