/**
 * Maestro iOS "glass & ink" theme — TypeScript mirror of tokens.css.
 * Used by React Native (which can't read CSS vars) and any JS consumer.
 * Keep values in sync with ./tokens.css (the web source of truth).
 */

export type ThemeMode = 'light' | 'dark';

/** Semantic accent colors — identical across light/dark. */
export const palette = {
  blue: '#007AFF',
  bluePress: '#0062CC',
  green: '#34C759',
  red: '#FF3B30',
  orange: '#FF9500',
  purple: '#AF52DE', // AI / agent activity
  teal: '#30B0C7', // media / studio
  indigo: '#5856D6', // skills
} as const;

/** Surface + ink colors per appearance. */
export const schemes = {
  light: {
    bg: '#F2F2F7',
    bgElevated: '#FFFFFF',
    bgGrouped: 'rgba(255,255,255,0.72)',
    fillSecondary: 'rgba(118,118,128,0.12)',
    fillTertiary: 'rgba(118,118,128,0.08)',
    ink: '#000000',
    inkSecondary: 'rgba(60,60,67,0.60)',
    inkTertiary: 'rgba(60,60,67,0.30)',
    separator: 'rgba(60,60,67,0.18)',
    separatorStrong: 'rgba(60,60,67,0.29)',
    backdrop: '#E7E9F3',
    diffAdd: '#E8F8EE',
    diffDel: '#FDEBEC',
  },
  dark: {
    bg: '#000000',
    bgElevated: '#1C1C1E',
    bgGrouped: 'rgba(44,44,46,0.66)',
    fillSecondary: 'rgba(120,120,128,0.24)',
    fillTertiary: 'rgba(120,120,128,0.16)',
    ink: '#FFFFFF',
    inkSecondary: 'rgba(235,235,245,0.60)',
    inkTertiary: 'rgba(235,235,245,0.30)',
    separator: 'rgba(84,84,88,0.55)',
    separatorStrong: 'rgba(84,84,88,0.65)',
    backdrop: '#06070D',
    diffAdd: 'rgba(52,199,89,0.15)',
    diffDel: 'rgba(255,59,48,0.14)',
  },
} as const;

/** iOS type ramp (pt). */
export const fontSize = {
  largeTitle: 34,
  title1: 28,
  title2: 22,
  headline: 17,
  body: 17,
  callout: 16,
  subhead: 15,
  footnote: 13,
  caption: 11,
} as const;

/** Font families. RN: System resolves to SF Pro on iOS; mono falls back per-platform. */
export const fontFamily = {
  // `undefined` => RN System font (SF Pro on iOS, Roboto on Android)
  display: undefined as string | undefined,
  text: undefined as string | undefined,
  mono: 'Menlo',
} as const;

export const radius = {
  card: 20,
  group: 12,
  pill: 980,
} as const;

/** 8pt grid helper (base unit = 4). */
export const space = (n: number): number => n * 4;

export const motion = {
  /** matches CSS cubic-bezier(0.32, 0.72, 0, 1) — use with react-native-reanimated Easing.bezier. */
  springBezier: [0.32, 0.72, 0, 1] as const,
  durationMs: 320,
} as const;

export type Scheme = (typeof schemes)[ThemeMode];

export interface Theme {
  mode: ThemeMode;
  color: Scheme & typeof palette;
  fontSize: typeof fontSize;
  fontFamily: typeof fontFamily;
  radius: typeof radius;
  space: typeof space;
  motion: typeof motion;
}

/** Build a full theme object for the given appearance. */
export function makeTheme(mode: ThemeMode): Theme {
  return {
    mode,
    color: { ...schemes[mode], ...palette },
    fontSize,
    fontFamily,
    radius,
    space,
    motion,
  };
}

export const lightTheme = makeTheme('light');
export const darkTheme = makeTheme('dark');
