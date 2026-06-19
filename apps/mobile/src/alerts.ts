/* Loud, attention-grabbing alerts for the phone: an OS notification + a loud
   custom chime + haptics, fired when a run completes or a gate needs attention.

   Notes on Expo Go: local OS notifications are limited on Android Expo Go, so the
   loud chime (expo-audio) + haptics + the in-app banner (LiveNotifier) carry the
   alert there. A dev/production build shows the full OS notification too. */

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Haptics from 'expo-haptics';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

let configured = false;
let player: AudioPlayer | null = null;

/** Configure the notification handler, Android channel, permission, and sound.
    Idempotent; call once at startup. Never throws. */
export async function setupAlerts(): Promise<void> {
  if (configured) return;
  configured = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async (n) => {
        // A remote push that lands while the app is in the FOREGROUND is redundant
        // with the SSE-driven in-app banner + chime (LiveNotifier) — keep it silent
        // to avoid a double alert. Closed/background pushes never hit this handler
        // (the app isn't running) so the OS shows them natively. Local notifs from
        // fireAlert (trigger !== 'push') still present as before.
        const isRemote = (n.request.trigger as { type?: string } | null)?.type === 'push';
        if (isRemote) return { shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: true };
        return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true };
      },
    });
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('alerts', {
        name: 'Maestro alerts',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'default',
        vibrationPattern: [0, 260, 180, 260],
        enableVibrate: true,
      });
    }
    await Notifications.requestPermissionsAsync();
  } catch {
    /* notifications unavailable (Android Expo Go) — sound + haptics + banner still fire */
  }
  try {
    await setAudioModeAsync({ playsInSilentMode: true });
    player = createAudioPlayer(require('../assets/alert.wav'));
    player.volume = 1;
  } catch {
    player = null;
  }
}

/** Play the loud chime + a heavy haptic. Safe to call anytime. */
export function playAlertSound(): void {
  try { if (player) { player.seekTo(0); player.play(); } } catch { /* ignore */ }
  try { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch { /* ignore */ }
}

/** Post an immediate OS notification (no-op where unsupported). */
export async function notify(title: string, body: string): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: 'default' },
      trigger: null,
    });
  } catch {
    /* notifications unavailable in this runtime */
  }
}

/** The full loud alert: chime + haptics + OS notification. */
export function fireAlert(title: string, body: string): void {
  playAlertSound();
  void notify(title, body);
}
