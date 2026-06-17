import React from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from './src/theme';
import { RootNavigator } from './src/navigation';
import { LiveNotifier } from './src/LiveNotifier';
import { hydrate } from './src/storage';
import { reloadPairToken } from './src/api';

export default function App() {
  // Load persisted settings (pair token, theme, prefs) before first render so the
  // app opens straight into the right place instead of flashing onboarding.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    hydrate().then(() => {
      reloadPairToken();
      if (alive) setReady(true);
    });
    return () => { alive = false; };
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
