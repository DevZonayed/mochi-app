/* Push-notification deep-linking. When the user taps a "Conversation complete",
   "Job failed", or "Needs your attention" notification, we route them to the
   originating session chat. Two cases to handle, both via expo-notifications:

   - Background/closed-app tap → fires `addNotificationResponseReceivedListener`.
   - Cold-start tap (app was killed) → the listener has NOT fired yet by the time
     we mount; we read `getLastNotificationResponseAsync()` once on init.

   We defer navigation until `navRef.isReady()` so a tap during startup still
   lands correctly instead of being silently dropped. */

import * as Notifications from 'expo-notifications';
import { navRef } from './navRef';

/** Shape the relay attaches to every alert push (see apps/server `PushNavData`). */
export type PushNavData = {
  kind?: 'job-done' | 'job-failed' | 'approval' | 'schedule-late';
  projectId?: string;
  sessionId?: string;
  jobId?: string;
  approvalId?: string;
};

let installed = false;
let pendingNav: PushNavData | null = null;

/** Pull a (possibly nested) PushNavData off the OS notification request. Expo
    delivers it on `request.content.data`; APNs/FCM payloads occasionally wrap
    it under `body`, so we accept either. */
function dataOf(response: Notifications.NotificationResponse | null | undefined): PushNavData | null {
  const raw = response?.notification?.request?.content?.data as Record<string, unknown> | undefined;
  if (!raw) return null;
  const inner = (raw.body && typeof raw.body === 'object' ? (raw.body as Record<string, unknown>) : raw) as PushNavData;
  return inner;
}

/** Resolve where this push should land. Falls back to a no-op when there isn't
    enough context to identify a session or approval. */
export function routeFor(data: PushNavData | null): { name: 'SessionChat' | 'Approvals' | 'Home'; params?: { projectId: string; sessionId?: string } } | null {
  if (!data) return null;
  // Job-complete / job-failed always carry projectId + (usually) sessionId.
  if ((data.kind === 'job-done' || data.kind === 'job-failed') && data.projectId) {
    return { name: 'SessionChat', params: { projectId: data.projectId, sessionId: data.sessionId } };
  }
  // Attention (approval): prefer the originating session chat, otherwise the
  // Approvals tab so the user can act on the gate.
  if (data.kind === 'approval') {
    if (data.projectId && data.sessionId) return { name: 'SessionChat', params: { projectId: data.projectId, sessionId: data.sessionId } };
    return { name: 'Approvals' };
  }
  // Schedule-late: only useful if it was tied to a session.
  if (data.kind === 'schedule-late' && data.projectId) {
    return { name: 'SessionChat', params: { projectId: data.projectId, sessionId: data.sessionId } };
  }
  return null;
}

/** Push-side hops: SessionChat lives on the root Stack, Approvals on the Tabs
    navigator. Both forms are reachable via `navRef.navigate(...)` once ready. */
function navigateTo(target: ReturnType<typeof routeFor>): void {
  if (!target || !navRef.isReady()) return;
  try {
    if (target.name === 'SessionChat' && target.params) {
      // Replace the SessionChat instance if already mounted, otherwise push it.
      navRef.navigate('SessionChat', target.params);
    } else if (target.name === 'Approvals') {
      // Approvals is a tab inside the 'Tabs' navigator — nested navigate.
      navRef.navigate('Tabs', { screen: 'Approvals' } as never);
    }
  } catch {
    /* navigation tree not in the expected shape — give up silently */
  }
}

/** Honor a notification tap (whether it arrived live or via cold-start). Queued
    when the navigator isn't ready yet — `flushPendingNav()` drains it once it is. */
function honor(data: PushNavData | null): void {
  if (!data) return;
  if (navRef.isReady()) navigateTo(routeFor(data));
  else pendingNav = data;
}

/** Wire the OS-tap listeners + drain any pending cold-start tap. Idempotent. */
export function setupPushNav(): () => void {
  if (installed) return () => undefined;
  installed = true;

  // Background / foreground tap.
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    honor(dataOf(response));
  });

  // Cold-start tap (app was launched BY the notification). Clear afterwards so
  // a later normal launch doesn't re-route into the stale session — the OS keeps
  // the last response cached otherwise (SDK 51+ exposes the clear helper; older
  // runtimes silently skip).
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    if (!response) return;
    honor(dataOf(response));
    try {
      const clear = (Notifications as unknown as { clearLastNotificationResponseAsync?: () => Promise<void> })
        .clearLastNotificationResponseAsync;
      if (clear) void clear();
    } catch { /* not supported in this runtime — no-op */ }
  });

  return () => {
    sub.remove();
    installed = false;
  };
}

/** Called from RootNavigator once `NavigationContainer` reports ready, so any
    cold-start tap that arrived before mount finally routes. */
export function flushPendingNav(): void {
  if (!pendingNav) return;
  const data = pendingNav;
  pendingNav = null;
  navigateTo(routeFor(data));
}

/** Test helpers — registering push tap behavior is otherwise hard to reach from
    unit tests, since expo-notifications can't be exercised under vitest. */
export const _internals = { honor, dataOf };
