import React from 'react';
import { AppState, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from './src/theme';
import { RootNavigator } from './src/navigation';
import { LiveNotifier } from './src/LiveNotifier';
import { hydrate } from './src/storage';
import { openLiveStream } from './src/api';
import { reloadSessionToken, reloadActiveHost, isAuthed, getActiveHost, subscribeActiveHost } from './src/auth';
import { registerForPush } from './src/push';
import { setupPushNav } from './src/pushNav';
import { pullSync, applyLiveEvent, readSyncStore } from './src/syncStore';

export default function App() {
  // Load persisted state (session token, active host, theme, prefs) before first
  // render so the app opens straight into the right place instead of flashing login.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    hydrate().then(() => {
      reloadSessionToken();
      reloadActiveHost();
      if (alive) setReady(true);
      void registerForPush(); // enable closed-app OS notifications (no-op until signed in/built)
      if (isAuthed() && getActiveHost()) void pullSync(); // first snapshot for the active host
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
    if (isAuthed() && getActiveHost()) void pullSync();
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
