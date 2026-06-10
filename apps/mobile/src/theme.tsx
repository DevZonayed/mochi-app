import React, { createContext, useContext, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { makeTheme, type Theme, type ThemeMode } from '@maestro/design-tokens';

interface ThemeContextValue {
  theme: Theme;
  mode: ThemeMode;
  /** null = follow the OS appearance */
  setOverride: (mode: ThemeMode | null) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [override, setOverride] = useState<ThemeMode | null>(null);
  const mode: ThemeMode = override ?? (system === 'dark' ? 'dark' : 'light');
  const theme = useMemo(() => makeTheme(mode), [mode]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      mode,
      setOverride,
      toggle: () => setOverride(mode === 'dark' ? 'light' : 'dark'),
    }),
    [theme, mode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}
