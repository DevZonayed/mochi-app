import React from 'react';
import { AppState, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from './src/theme';
import { RootNavigator } from './src/navigation';
import { LiveNotifier } from './src/LiveNotifier';
import { hydrate } from './src/storage';
import { openLiveStream } from './src/api';
import { reloadSessionToken, reloadActiveHost, isAuthed, getActiveHost, subscribeActiveHost, subscribeSession } from './src/auth';
import { registerForPush } from './src/push';
import { setupPushNav } from './src/pushNav';
import { pullSync, applyLiveEvent, readSyncStore, rehydrateSyncStore } from './src/syncStore';
// Phase 3A2a: pull the native-controller enrollment production graph (runtime +
// expo-secure-store / expo-crypto / expo-sqlite adapters) into the app bundle so
// 3A2b can lazily start it. No network or auto-start happens on import.
import './src/shadowEnrollment';
// Phase 3A2b1 §4: reach the PRODUCTION controller surface (verified dynamic action API +
// projection view + command status) through the real startup path. Lazy, no network, no
// screen — a genuine call, not a marker-only import.
import { bootstrapShadowProductionController, resetProductionShadowController } from './src/shadowProductionController';
// Phase 3C2: start the read-only controller-UI store so its authority/lifecycle gating
// (revoke / expiry / account+host switch / signout → synchronous lock before purge) is
// live from launch. Lazy: no network, no screen — the store subscribes to auth signals.
import { getShadowUiController } from './src/shadowUiControllerRuntime';
// Phase 3C2 (F2): the persisted top-level secure-controller mode decides the ROOT nav
// tree. Restore it before the navigator picks a tree; re-restore on identity change.
import { restoreControllerMode, invalidateControllerMode } from './src/controllerMode';
// Phase 3D1 (B1): the PRODUCTION screen-stream runtime owner. It constructs + attaches
// the real ScreenStreamClient after verified enrollment, dials /ws/remote/screen, and
// detaches/zeros on session/host/grant change — so "View screen" starts a real stream.
import { getShadowScreenRuntime } from './src/shadowScreenRuntimeProd';

export default function App() {
  // Load persisted state (session token, active host, theme, prefs) before first
  // render so the app opens straight into the right place instead of flashing login.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    hydrate().then(() => {
      reloadSessionToken();
      reloadActiveHost();
      rehydrateSyncStore(); // re-read persisted data now that the cache is populated
      getShadowUiController(); // start the controller-UI store's lifecycle subscriptions
      void restoreControllerMode(); // restore the root-tree decision for the current account
      if (alive) setReady(true); // open the UI immediately — the screen runtime wires below
      void registerForPush(); // enable closed-app OS notifications (no-op until signed in/built)
      if (isAuthed() && getActiveHost()) void pullSync(); // first snapshot for the active host
      // B1-R1: AWAIT the controller bootstrap/restore (which populates the enrollment
      // grant) BEFORE starting the screen runtime, so the runtime's boot refresh reads a
      // restored grant instead of racing it. A bounded failure just leaves the screen
      // truthfully unavailable — the grant subscription re-attaches once a grant arrives.
      // `alive` gates the start for cancellable cleanup on unmount.
      Promise.resolve(bootstrapShadowProductionController())
        .catch(() => { /* bounded — screen stays unavailable until a grant lands */ })
        .finally(() => { if (alive) getShadowScreenRuntime(); });
    });
    return () => { alive = false; };
  }, []);

  // Re-register the push token whenever the app returns to the foreground — covers
  // a server redeploy and a token that rotated while away. Also re-pull the active
  // host's snapshot so the user sees everything that changed while away, and bump
  // the live epoch so the WS reconnects fresh.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      void registerForPush();
      if (isAuthed() && getActiveHost()) void pullSync();
      setLiveEpoch((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  // Reconnect the live stream + re-pull whenever the ACTIVE HOST changes (device
  // switch). Keeps the WebSocket pointed at the Mac the user is currently driving.
  React.useEffect(() => subscribeActiveHost(() => {
    setLiveEpoch((n) => n + 1);
    // Account/host switch → drop + close the old controller surface so no prior-account
    // scope key, timer, or capability snapshot survives; the next use rebuilds fresh.
    resetProductionShadowController();
    // Re-decide the root tree for the (possibly new) account — splash until re-resolved,
    // never a legacy flash while the old authority is being locked/purged.
    invalidateControllerMode();
    void restoreControllerMode();
    if (isAuthed() && getActiveHost()) { void pullSync(); bootstrapShadowProductionController(); }
  }), []);

  // Sign-out / sign-in / SAME-HOST account switch also changes the authenticated identity.
  // Reset the controller so its scope key, renewal timer, and subscriptions never linger
  // across accounts even when the active host id is unchanged.
  React.useEffect(() => subscribeSession(() => {
    resetProductionShadowController();
    invalidateControllerMode();
    void restoreControllerMode();
    if (isAuthed() && getActiveHost()) bootstrapShadowProductionController();
  }), []);

  // One shared live subscriber (/ws/remote) for the whole app — every screen reads
  // from the SyncStore, so we only need a single sink. `liveEpoch` increments to
  // force a reconnect on AppState→active, sign-in, or host switch. The stream is
  // gated on having BOTH a session and an active host.
  const [liveEpoch, setLiveEpoch] = React.useState(0);
  React.useEffect(() => {
    if (!ready || !isAuthed() || !getActiveHost()) return;
    const since = readSyncStore().lastSync;
    const dispose = openLiveStream((name, data) => applyLiveEvent(name, data), since);
    return () => dispose();
  }, [ready, liveEpoch]);

  // Tap-to-deep-link for closed/background notifications. Cold-start taps are
  // queued and flushed once the navigator reports ready (see RootNavigator).
  React.useEffect(() => setupPushNav(), []);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <StatusBar style="auto" />
        {ready ? <><RootNavigator /><LiveNotifier /></> : <View style={{ flex: 1, backgroundColor: '#0a0b10' }} />}
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
