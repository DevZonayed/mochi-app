import React from 'react';
import Svg, {
  Path,
  Circle,
  Rect,
  Line,
  Polyline,
  Polygon,
  G,
  Defs,
  LinearGradient,
  RadialGradient,
  Stop,
} from 'react-native-svg';

/**
 * Maestro line-icon set — a faithful React Native port of design/project/lib/icons.jsx
 * (Lucide-style, 24×24, 1.75px stroke, inherits the passed `color`).
 */
export type IconName =
  | 'check' | 'arrowRight' | 'arrowLeft' | 'folder' | 'lock' | 'key' | 'gauge'
  | 'smartphone' | 'sun' | 'moon' | 'spark' | 'shield' | 'bolt' | 'home' | 'layers'
  | 'jobs' | 'bell' | 'search' | 'command' | 'plus' | 'calendar' | 'clock'
  | 'telescope' | 'checkCircle' | 'xCircle' | 'more' | 'chevronRight' | 'chevronDown'
  | 'gitMerge' | 'send' | 'settings' | 'x' | 'clapper' | 'sliders' | 'dollar'
  | 'refresh' | 'image' | 'play' | 'pause';

const PATHS: Record<IconName, React.ReactNode> = {
  check: <Polyline points="20 6 9 17 4 12" />,
  arrowRight: <><Line x1="5" y1="12" x2="19" y2="12" /><Polyline points="12 5 19 12 12 19" /></>,
  arrowLeft: <><Line x1="19" y1="12" x2="5" y2="12" /><Polyline points="12 19 5 12 12 5" /></>,
  folder: <Path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  lock: <><Rect x="3" y="11" width="18" height="11" rx="2" /><Path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
  key: <><Circle cx="7.5" cy="15.5" r="4.5" /><Path d="m10.5 12.5 8.5-8.5" /><Path d="m15 6 3 3" /><Path d="m18 3 3 3" /></>,
  gauge: <><Path d="m12 14 4-4" /><Path d="M3.34 19a10 10 0 1 1 17.32 0" /></>,
  smartphone: <><Rect x="6" y="2" width="12" height="20" rx="2" /><Line x1="11" y1="18" x2="13" y2="18" /></>,
  sun: <><Circle cx="12" cy="12" r="4" /><Path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></>,
  moon: <Path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  spark: <Path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />,
  shield: <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />,
  bolt: <Path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" />,
  home: <><Path d="M3 10.5 12 3l9 7.5" /><Path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" /></>,
  layers: <><Path d="m12 2 9 5-9 5-9-5 9-5Z" /><Path d="m3 12 9 5 9-5" /><Path d="m3 17 9 5 9-5" /></>,
  jobs: <><Rect x="3" y="4" width="18" height="16" rx="2" /><Path d="M3 9h18" /><Path d="M8 14h2M8 17h6" /></>,
  bell: <><Path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><Path d="M13.7 21a2 2 0 0 1-3.4 0" /></>,
  search: <><Circle cx="11" cy="11" r="7" /><Path d="m21 21-4.3-4.3" /></>,
  command: <Path d="M15 6a3 3 0 1 1 3 3h-3V6Zm0 12a3 3 0 1 0 3-3h-3v3Zm-6 0a3 3 0 1 1-3-3h3v3Zm0-12a3 3 0 1 0-3 3h3V6Zm0 3h6v6H9V9Z" />,
  plus: <><Line x1="12" y1="5" x2="12" y2="19" /><Line x1="5" y1="12" x2="19" y2="12" /></>,
  calendar: <><Rect x="3" y="4" width="18" height="18" rx="2" /><Path d="M3 10h18M8 2v4M16 2v4" /></>,
  clock: <><Circle cx="12" cy="12" r="9" /><Path d="M12 7v5l3 2" /></>,
  telescope: <><Path d="m3 14 7-2 2 5-7 2-2-5Z" /><Path d="m10 12 8.5-2.4a1 1 0 0 0 .7-1.2l-.5-2a1 1 0 0 0-1.2-.7L9 8" /><Path d="M9 17v4M7 21h4" /></>,
  checkCircle: <><Circle cx="12" cy="12" r="9" /><Path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  xCircle: <><Circle cx="12" cy="12" r="9" /><Path d="m9 9 6 6M15 9l-6 6" /></>,
  more: <><Circle cx="5" cy="12" r="1.4" /><Circle cx="12" cy="12" r="1.4" /><Circle cx="19" cy="12" r="1.4" /></>,
  chevronRight: <Polyline points="9 6 15 12 9 18" />,
  chevronDown: <Polyline points="6 9 12 15 18 9" />,
  gitMerge: <><Circle cx="6" cy="6" r="3" /><Circle cx="6" cy="18" r="3" /><Circle cx="18" cy="9" r="3" /><Path d="M6 9v6M15 9a9 9 0 0 1-9 9" /></>,
  send: <><Path d="M22 2 11 13" /><Path d="M22 2 15 22l-4-9-9-4 20-7Z" /></>,
  settings: <><Circle cx="12" cy="12" r="3" /><Path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" /></>,
  x: <><Line x1="6" y1="6" x2="18" y2="18" /><Line x1="18" y1="6" x2="6" y2="18" /></>,
  clapper: <><Path d="M3 8h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" /><Path d="m3 8 2-4 4 4M9 4l3 4M13 4l3 4M17 4l3 4" /></>,
  sliders: <><Line x1="4" y1="21" x2="4" y2="14" /><Line x1="4" y1="10" x2="4" y2="3" /><Line x1="12" y1="21" x2="12" y2="12" /><Line x1="12" y1="8" x2="12" y2="3" /><Line x1="20" y1="21" x2="20" y2="16" /><Line x1="20" y1="12" x2="20" y2="3" /><Line x1="1" y1="14" x2="7" y2="14" /><Line x1="9" y1="8" x2="15" y2="8" /><Line x1="17" y1="16" x2="23" y2="16" /></>,
  dollar: <><Line x1="12" y1="2" x2="12" y2="22" /><Path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></>,
  refresh: <><Path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><Path d="M21 3v5h-5" /></>,
  image: <><Rect x="3" y="3" width="18" height="18" rx="2" /><Circle cx="9" cy="9" r="2" /><Path d="m21 15-5-5L5 21" /></>,
  play: <Polygon points="6 4 20 12 6 20 6 4" />,
  pause: <><Rect x="6" y="5" width="4" height="14" rx="1" /><Rect x="14" y="5" width="4" height="14" rx="1" /></>,
};

export function Icon({
  name,
  size = 18,
  color = '#000',
  stroke = 1.75,
}: {
  name: IconName;
  size?: number;
  color?: string;
  stroke?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <G fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
        {PATHS[name]}
      </G>
    </Svg>
  );
}

/** Maestro app mark: gradient squircle with the orchestration glyph. */
export function MaestroMark({ size = 96 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 96 96" fill="none">
      <Defs>
        <LinearGradient id="mg" x1="14" y1="10" x2="82" y2="86" gradientUnits="userSpaceOnUse">
          <Stop stopColor="#5E8BFF" />
          <Stop offset="0.52" stopColor="#7C5CFF" />
          <Stop offset="1" stopColor="#A24BE0" />
        </LinearGradient>
        <RadialGradient id="mh" cx="0.32" cy="0.18" r="0.9">
          <Stop stopColor="rgba(255,255,255,0.55)" />
          <Stop offset="0.4" stopColor="rgba(255,255,255,0)" />
        </RadialGradient>
      </Defs>
      <Rect x="3" y="3" width="90" height="90" rx="26" fill="url(#mg)" />
      <Rect x="3" y="3" width="90" height="90" rx="26" fill="url(#mh)" />
      <G stroke="rgba(255,255,255,0.85)" strokeWidth="2.4" strokeLinecap="round">
        <Path d="M48 48 L26 30" />
        <Path d="M48 48 L72 28" />
        <Path d="M48 48 L24 66" />
        <Path d="M48 48 L70 68" />
      </G>
      <G fill="#fff">
        <Circle cx="26" cy="30" r="5.2" opacity={0.92} />
        <Circle cx="72" cy="28" r="5.2" opacity={0.92} />
        <Circle cx="24" cy="66" r="5.2" opacity={0.92} />
        <Circle cx="70" cy="68" r="5.2" opacity={0.92} />
      </G>
      <Circle cx="48" cy="48" r="9.5" fill="#fff" />
      <Circle cx="48" cy="48" r="4.2" fill="url(#mg)" />
    </Svg>
  );
}
