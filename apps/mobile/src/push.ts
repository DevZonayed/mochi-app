/* Push-notification registration + tap routing.

   In a real (non-Expo-Go) build we fetch an Expo push token and register it with
   the relay, so the Mac's job/approval events reach this phone as OS push
   notifications even when the app is closed. The foreground path stays the
   SSE-driven in-app banner + chime (see LiveNotifier). Safe and silent wherever
   push is unavailable (Expo Go, web, simulators, no FCM credentials). */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { api } from './api';
import { navigationRef } from './navigation';
import { getStr, setStr, PUSH_TOKEN } from './storage';

/** The EAS projectId baked into the build (required to mint Expo push tokens). */
function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
}

/** Fetch an Expo push token and register it with the relay. Re-registers on every
    launch (the relay holds tokens in memory). Never throws. */
export async function registerForPush(): Promise<void> {
  try {
    if (Platform.OS === 'web') return;
    if (Constants.appOwnership === 'expo') return; // Expo Go can't mint a real token
    const pid = projectId();
    if (!pid) return; // not an EAS build (no projectId) — nothing to register
    let granted = (await Notifications.getPermissionsAsync()).granted;
    if (!granted) granted = (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId: pid })).data;
    if (!token) return;
    await api.registerPush(token);
    setStr(PUSH_TOKEN, token);
  } catch {
    /* push unavailable (no FCM, offline, denied) — in-app SSE alerts still fire */
  }
}

/** Route notification taps to the right screen. Call once at startup; returns a
    disposer. Reads the payload the relay attaches to each push. */
export function wireNotificationResponses(): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
    const data = resp.notification.request.content.data as { jobId?: string; kind?: string; approvalId?: string } | undefined;
    if (!navigationRef.isReady()) return;
    if (data?.jobId) navigationRef.navigate('JobTimeline', { jobId: data.jobId });
    else if (data?.kind === 'approval-created') navigationRef.navigate('Tabs');
  });
  return () => sub.remove();
}
