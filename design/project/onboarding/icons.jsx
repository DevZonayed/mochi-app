/* Maestro brand mark, provider glyphs, and Lucide-style line icons.
   All inherit currentColor unless a gradient is used. */

// ── Maestro app mark: a squircle with an orchestration glyph
//    (a central conductor node radiating to a fleet of agent nodes)
function MaestroMark({ size = 96 }) {
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
function AnthropicGlyph({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path d="M24.4 8h-5.1l8.9 24h5.3L24.4 8Zm-12.2 0L3 32h5.4l1.86-5.1h9.0L18.4 32h5.4L14.6 8h-2.4Zm-.2 14.4 2.96-8.1 2.96 8.1h-5.92Z" fill="currentColor"/>
    </svg>
  );
}
function OpenAIGlyph({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path d="M34.3 17.2a8.6 8.6 0 0 0-.74-7.06 8.7 8.7 0 0 0-9.37-4.17A8.6 8.6 0 0 0 17.7 3.2a8.7 8.7 0 0 0-8.29 6.02 8.6 8.6 0 0 0-5.74 4.17 8.7 8.7 0 0 0 1.07 10.2 8.6 8.6 0 0 0 .74 7.06 8.7 8.7 0 0 0 9.37 4.17 8.6 8.6 0 0 0 6.49 2.79 8.7 8.7 0 0 0 8.29-6.03 8.6 8.6 0 0 0 5.74-4.17 8.7 8.7 0 0 0-1.06-10.2Zm-12.9 18a6.45 6.45 0 0 1-4.14-1.5l.2-.12 6.88-3.97a1.12 1.12 0 0 0 .57-.98v-9.7l2.91 1.68a.1.1 0 0 1 .06.08v8.03a6.48 6.48 0 0 1-6.48 6.47Zm-13.9-5.94a6.44 6.44 0 0 1-.77-4.34l.2.12 6.89 3.98a1.12 1.12 0 0 0 1.13 0l8.41-4.86v3.36a.1.1 0 0 1-.04.09l-6.96 4.02a6.48 6.48 0 0 1-8.85-2.37ZM5.7 14.55a6.45 6.45 0 0 1 3.37-2.84v8.18a1.12 1.12 0 0 0 .56.97l8.4 4.85-2.9 1.68a.1.1 0 0 1-.1 0l-6.96-4.02a6.48 6.48 0 0 1-2.37-8.82Zm23.92 5.56-8.41-4.86 2.9-1.67a.1.1 0 0 1 .1 0l6.96 4.01a6.47 6.47 0 0 1-1 11.67v-8.18a1.12 1.12 0 0 0-.55-.97Zm2.9-4.36-.2-.12-6.88-3.98a1.12 1.12 0 0 0-1.13 0l-8.41 4.86v-3.36a.1.1 0 0 1 .04-.09l6.96-4.01a6.47 6.47 0 0 1 9.62 6.7Zm-18.2 6 -2.91-1.68a.1.1 0 0 1-.06-.08v-8.03a6.47 6.47 0 0 1 10.62-4.97l-.2.11-6.88 3.97a1.12 1.12 0 0 0-.57.98l-.01 9.69Zm1.58-3.4 3.75-2.16 3.75 2.16v4.33l-3.75 2.16-3.75-2.16v-4.33Z" fill="currentColor"/>
    </svg>
  );
}

// ── Small line icons (Lucide-style, 1.5px stroke)
function Icon({ name, size = 18, stroke = 1.75, style }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round', strokeLinejoin: 'round', style };
  const paths = {
    check: <polyline points="20 6 9 17 4 12" />,
    arrowRight: <><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></>,
    arrowLeft: <><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></>,
    folder: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>,
    lock: <><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>,
    key: <><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.5 12.5 8.5-8.5"/><path d="m15 6 3 3"/><path d="m18 3 3 3"/></>,
    gauge: <><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></>,
    smartphone: <><rect x="6" y="2" width="12" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></>,
    moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>,
    spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>,
    bolt: <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z"/>,
    wifi: <><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><line x1="12" y1="20" x2="12" y2="20"/></>,
    cpu: <><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></>,
    dollar: <><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></>,
    refresh: <><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></>,
  };
  return <svg {...p}>{paths[name]}</svg>;
}

Object.assign(window, { MaestroMark, AnthropicGlyph, OpenAIGlyph, Icon });
