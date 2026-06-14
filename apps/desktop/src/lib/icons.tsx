/* Maestro brand mark, provider glyphs, and Lucide-style line icons.
   All inherit currentColor unless a gradient is used.
   Ported to ES-module TypeScript React — visual output unchanged. */

import React from 'react';

// ── Maestro app mark: a squircle with an orchestration glyph
//    (a central conductor node radiating to a fleet of agent nodes)
export function MaestroMark({ size = 96 }: { size?: number }) {
  const id = React.useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" fill="none" aria-label="Maestro">
      <defs>
        <linearGradient id={`mg-${id}`} x1="14" y1="10" x2="82" y2="86" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5E8BFF" />
          <stop offset="0.52" stopColor="#7C5CFF" />
          <stop offset="1" stopColor="#A24BE0" />
        </linearGradient>
        <radialGradient id={`mh-${id}`} cx="0.32" cy="0.18" r="0.9">
          <stop stopColor="rgba(255,255,255,0.55)" />
          <stop offset="0.4" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>
      {/* squircle */}
      <path d="M48 3C20.5 3 3 20.5 3 48s17.5 45 45 45 45-17.5 45-45S75.5 3 48 3Z"
        transform="translate(0,0)" fill={`url(#mg-${id})`} />
      <rect x="3" y="3" width="90" height="90" rx="26" fill={`url(#mh-${id})`} />
      {/* fleet links */}
      <g stroke="rgba(255,255,255,0.85)" strokeWidth="2.4" strokeLinecap="round">
        <path d="M48 48 L26 30" />
        <path d="M48 48 L72 28" />
        <path d="M48 48 L24 66" />
        <path d="M48 48 L70 68" />
      </g>
      {/* agent nodes */}
      <g fill="#fff">
        <circle cx="26" cy="30" r="5.2" opacity="0.92" />
        <circle cx="72" cy="28" r="5.2" opacity="0.92" />
        <circle cx="24" cy="66" r="5.2" opacity="0.92" />
        <circle cx="70" cy="68" r="5.2" opacity="0.92" />
      </g>
      {/* operator core */}
      <circle cx="48" cy="48" r="9.5" fill="#fff" />
      <circle cx="48" cy="48" r="4.2" fill={`url(#mg-${id})`} />
    </svg>
  );
}

// ── Provider glyphs (simple monochrome stand-ins, inherit currentColor)
export function AnthropicGlyph({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path d="M24.4 8h-5.1l8.9 24h5.3L24.4 8Zm-12.2 0L3 32h5.4l1.86-5.1h9.0L18.4 32h5.4L14.6 8h-2.4Zm-.2 14.4 2.96-8.1 2.96 8.1h-5.92Z" fill="currentColor"/>
    </svg>
  );
}

export function OpenAIGlyph({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path d="M34.3 17.2a8.6 8.6 0 0 0-.74-7.06 8.7 8.7 0 0 0-9.37-4.17A8.6 8.6 0 0 0 17.7 3.2a8.7 8.7 0 0 0-8.29 6.02 8.6 8.6 0 0 0-5.74 4.17 8.7 8.7 0 0 0 1.07 10.2 8.6 8.6 0 0 0 .74 7.06 8.7 8.7 0 0 0 9.37 4.17 8.6 8.6 0 0 0 6.49 2.79 8.7 8.7 0 0 0 8.29-6.03 8.6 8.6 0 0 0 5.74-4.17 8.7 8.7 0 0 0-1.06-10.2Zm-12.9 18a6.45 6.45 0 0 1-4.14-1.5l.2-.12 6.88-3.97a1.12 1.12 0 0 0 .57-.98v-9.7l2.91 1.68a.1.1 0 0 1 .06.08v8.03a6.48 6.48 0 0 1-6.48 6.47Zm-13.9-5.94a6.44 6.44 0 0 1-.77-4.34l.2.12 6.89 3.98a1.12 1.12 0 0 0 1.13 0l8.41-4.86v3.36a.1.1 0 0 1-.04.09l-6.96 4.02a6.48 6.48 0 0 1-8.85-2.37ZM5.7 14.55a6.45 6.45 0 0 1 3.37-2.84v8.18a1.12 1.12 0 0 0 .56.97l8.4 4.85-2.9 1.68a.1.1 0 0 1-.1 0l-6.96-4.02a6.48 6.48 0 0 1-2.37-8.82Zm23.92 5.56-8.41-4.86 2.9-1.67a.1.1 0 0 1 .1 0l6.96 4.01a6.47 6.47 0 0 1-1 11.67v-8.18a1.12 1.12 0 0 0-.55-.97Zm2.9-4.36-.2-.12-6.88-3.98a1.12 1.12 0 0 0-1.13 0l-8.41 4.86v-3.36a.1.1 0 0 1 .04-.09l6.96-4.01a6.47 6.47 0 0 1 9.62 6.7Zm-18.2 6 -2.91-1.68a.1.1 0 0 1-.06-.08v-8.03a6.47 6.47 0 0 1 10.62-4.97l-.2.11-6.88 3.97a1.12 1.12 0 0 0-.57.98l-.01 9.69Zm1.58-3.4 3.75-2.16 3.75 2.16v4.33l-3.75 2.16-3.75-2.16v-4.33Z" fill="currentColor"/>
    </svg>
  );
}

// ── Names of every available line icon (keys of the `paths` map below).
export type IconName =
  | 'check'
  | 'paperclip'
  | 'globe'
  | 'chat'
  | 'arrowRight'
  | 'arrowLeft'
  | 'map'
  | 'sidebar'
  | 'bookmark'
  | 'folder'
  | 'lock'
  | 'key'
  | 'gauge'
  | 'smartphone'
  | 'sun'
  | 'moon'
  | 'spark'
  | 'shield'
  | 'bolt'
  | 'wifi'
  | 'cpu'
  | 'image'
  | 'dollar'
  | 'refresh'
  | 'home'
  | 'layers'
  | 'jobs'
  | 'bell'
  | 'search'
  | 'command'
  | 'plus'
  | 'calendar'
  | 'clock'
  | 'terminal'
  | 'brush'
  | 'play'
  | 'telescope'
  | 'target'
  | 'file'
  | 'square'
  | 'checkCircle'
  | 'xCircle'
  | 'more'
  | 'chevronRight'
  | 'chevronDown'
  | 'gitMerge'
  | 'send'
  | 'alert'
  | 'settings'
  | 'x'
  | 'clapper'
  | 'enter'
  | 'sliders'
  | 'pause';

export interface IconProps {
  name: IconName;
  size?: number;
  stroke?: number;
  style?: React.CSSProperties;
}

// ── Small line icons (Lucide-style, 1.5px stroke)
export function Icon({ name, size = 18, stroke = 1.75, style }: IconProps) {
  const p = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const, style,
  };
  const paths: Record<IconName, React.ReactNode> = {
    check: <polyline points="20 6 9 17 4 12" />,
    arrowRight: <><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></>,
    arrowLeft: <><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></>,
    folder: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>,
    lock: <><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>,
    key: <><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.5 12.5 8.5-8.5"/><path d="m15 6 3 3"/><path d="m18 3 3 3"/></>,
    gauge: <><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></>,
    map: <><path d="M14.1 5.55a2 2 0 0 0 1.8 0l3.66-1.83A1 1 0 0 1 21 4.62v12.76a1 1 0 0 1-.55.9l-4.55 2.27a2 2 0 0 1-1.8 0l-4.2-2.1a2 2 0 0 0-1.8 0l-3.66 1.83A1 1 0 0 1 3 19.38V6.62a1 1 0 0 1 .55-.9L8.1 3.45a2 2 0 0 1 1.8 0Z"/><path d="M15 5.76v15"/><path d="M9 3.24v15"/></>,
    sidebar: <><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></>,
    bookmark: <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>,
    smartphone: <><rect x="6" y="2" width="12" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></>,
    moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>,
    spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>,
    bolt: <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z"/>,
    wifi: <><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><line x1="12" y1="20" x2="12" y2="20"/></>,
    cpu: <><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></>,
    paperclip: <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>,
    globe: <><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></>,
    chat: <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>,
    dollar: <><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></>,
    refresh: <><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></>,
    home: <><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5"/></>,
    layers: <><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></>,
    jobs: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 14h2M8 17h6"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></>,
    command: <path d="M15 6a3 3 0 1 1 3 3h-3V6Zm0 12a3 3 0 1 0 3-3h-3v3Zm-6 0a3 3 0 1 1-3-3h3v3Zm0-12a3 3 0 1 0-3 3h3V6Zm0 3h6v6H9V9Z"/>,
    plus: <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>,
    calendar: <><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    terminal: <><polyline points="4 7 9 12 4 17"/><line x1="12" y1="17" x2="20" y2="17"/></>,
    brush: <><path d="M9.5 14.5 4 20"/><path d="M14 4 20 10l-7.5 7.5a3.5 3.5 0 0 1-5-5L14 4Z"/><path d="m13 5 6 6"/></>,
    play: <polygon points="6 4 20 12 6 20 6 4"/>,
    telescope: <><path d="m3 14 7-2 2 5-7 2-2-5Z"/><path d="m10 12 8.5-2.4a1 1 0 0 0 .7-1.2l-.5-2a1 1 0 0 0-1.2-.7L9 8"/><path d="M9 17v4M7 21h4"/></>,
    target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></>,
    square: <rect x="6" y="6" width="12" height="12" rx="2"/>,
    checkCircle: <><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></>,
    xCircle: <><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></>,
    more: <><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></>,
    chevronRight: <polyline points="9 6 15 12 9 18"/>,
    chevronDown: <polyline points="6 9 12 15 18 9"/>,
    gitMerge: <><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="9" r="3"/><path d="M6 9v6M15 9a9 9 0 0 1-9 9"/></>,
    send: <><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></>,
    alert: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/></>,
    x: <><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></>,
    clapper: <><path d="M3 8h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z"/><path d="m3 8 2-4 4 4M9 4l3 4M13 4l3 4M17 4l3 4"/></>,
    enter: <><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></>,
    sliders: <><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></>,
    pause: <><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></>,
  };
  return <svg {...p}>{paths[name]}</svg>;
}
