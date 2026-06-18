import React from 'react';
import { AppState, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from './src/theme';
import { RootNavigator } from './src/navigation';
import { LiveNotifier } from './src/LiveNotifier';
import { hydrate } from './src/storage';
import { reloadPairToken } from './src/api';
import { registerForPush } from './src/push';

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
    });
    return () => { alive = false; };
  }, []);

  // Re-register the push token whenever the app returns to the foreground — covers
  // a relay redeploy (in-memory token store) and a token that rotated while away.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') void registerForPush(); });
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <StatusBar style="auto" />
        {ready ? <><RootNavigator /><LiveNotifier /></> : <View style={{ flex: 1, backgroundColor: '#0a0b10' }} />}
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
