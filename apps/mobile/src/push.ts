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
   in-app SSE alerts keep working, only the closed-app path is disabled. */

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { api, getPairToken } from './api';
import { getStr, setStr } from './storage';

const PUSH_TOKEN = 'maestro.mobile.pushToken';
let registered = '';

/** The EAS project id required to mint an Expo push token. */
function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
}

/** Register (or refresh) this phone's Expo push token with the relay. Idempotent,
    safe to call on every launch and on foreground. Never throws. */
export async function registerForPush(): Promise<void> {
  try {
    if (!getPairToken()) return; // not paired yet — nothing to register against
    const pid = projectId();
    if (!pid) {
      console.warn('[push] no EAS projectId — set extra.eas.projectId and use a dev/prod build to enable closed-app notifications');
      return;
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: pid });
    if (!token || token === registered) return;
    await api.registerPush(token);
    registered = token;
    setStr(PUSH_TOKEN, token);
  } catch (e) {
    // Expo Go on Android (no remote push), simulators, or a denied permission all
    // land here — degrade to the in-app SSE alerts.
    console.warn('[push] registration skipped:', e instanceof Error ? e.message : e);
  }
}

/** Drop this phone's token from the relay (called on unpair). */
export async function unregisterPush(): Promise<void> {
  const token = registered || getStr(PUSH_TOKEN);
  if (!token) return;
  try { await api.unregisterPush(token); } catch { /* relay/network down — token expires server-side anyway */ }
  registered = '';
  setStr(PUSH_TOKEN, '');
}
