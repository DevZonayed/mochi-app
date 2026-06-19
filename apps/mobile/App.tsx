import React from 'react';
import { AppState, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from './src/theme';
import { RootNavigator } from './src/navigation';
import { LiveNotifier } from './src/LiveNotifier';
import { hydrate } from './src/storage';
import { reloadPairToken, getPairToken, openLiveStream } from './src/api';
import { registerForPush } from './src/push';
import { setupPushNav } from './src/pushNav';
import { pullSync, applyLiveEvent, readSyncStore } from './src/syncStore';

export default function App() {
  // Load persisted settings (pair token, theme, prefs) before first render so the
  // app opens straight into the right place instead of flashing onboarding.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    hydrate().then(() => {
      reloadPairToken();
      if (alive) setReady(true);
      void registerForPush(); // enable closed-app OS notifications (no-op until paired/built)
      if (getPairToken()) void pullSync(); // first delta — replaces the per-screen cache-then-network calls
    });
    return () => { alive = false; };
  }, []);

  // Re-register the push token whenever the app returns to the foreground — covers
  // a relay redeploy (in-memory token store) and a token that rotated while away.
  // Also re-pull the delta so the user sees everything that changed while away,
  // and tear down + reopen the SSE stream so its `?since=lastSync` is current.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      void registerForPush();
      if (getPairToken()) void pullSync();
      // The single global SSE subscriber below tears itself down when
      // `liveEpoch` flips; this kick bumps it so the next connect carries the
      // freshest `?since=` value.
      setLiveEpoch((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  // One shared SSE subscriber for the whole app — every screen reads from the
  // SyncStore, so we only need a single sink. `liveEpoch` increments to force
  // a reconnect on AppState→active or pair-token change (so `?since=` is fresh).
  const [liveEpoch, setLiveEpoch] = React.useState(0);
  React.useEffect(() => {
    if (!ready || !getPairToken()) return;
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
