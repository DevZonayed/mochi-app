/* Publishing Center — platform defs (monochrome brand glyphs) + data. */

function PGlyph({ p, size = 18 }) {
  const c = 'currentColor';
  const paths = {
    youtube: <path d="M21.6 7.2a2.7 2.7 0 0 0-1.9-1.9C18 4.8 12 4.8 12 4.8s-6 0-7.7.5A2.7 2.7 0 0 0 2.4 7.2C2 8.9 2 12 2 12s0 3.1.4 4.8a2.7 2.7 0 0 0 1.9 1.9c1.7.5 7.7.5 7.7.5s6 0 7.7-.5a2.7 2.7 0 0 0 1.9-1.9c.4-1.7.4-4.8.4-4.8s0-3.1-.4-4.8ZM10 15V9l5.2 3L10 15Z" fill={c}/>,
    tiktok: <path d="M16.5 3c.3 2.2 1.6 3.7 3.8 3.9v2.6c-1.3.1-2.5-.3-3.8-1v5.9c0 4.6-5 6-7.3 2.7-1.5-2.1-.7-5.8 3.4-6v2.7c-.3.05-.7.15-1 .27-.9.4-1.4 1-1.3 2 .2 1.9 3.7 2.5 3.4-1.2V3h2.8Z" fill={c}/>,
    instagram: <><rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke={c} strokeWidth="1.8"/><circle cx="12" cy="12" r="4" fill="none" stroke={c} strokeWidth="1.8"/><circle cx="17" cy="7" r="1.3" fill={c}/></>,
    x: <path d="M17.5 3h3l-6.5 7.4L21.5 21h-5.9l-4.3-5.6L6.3 21H3.3l7-8L2.8 3h6l3.9 5.2L17.5 3Zm-1 16h1.6L7.6 4.7H5.9L16.5 19Z" fill={c}/>,
    linkedin: <><rect x="3.5" y="3.5" width="17" height="17" rx="3" fill="none" stroke={c} strokeWidth="1.8"/><path d="M7 10v6M7 7.5v.01M11 16v-3.5a1.5 1.5 0 0 1 3 0V16M11 16v-6" stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round"/></>,
    pinterest: <path d="M12 2a10 10 0 0 0-3.6 19.3c-.1-.8-.2-2 0-2.9l1.2-5s-.3-.6-.3-1.5c0-1.4.8-2.4 1.8-2.4.9 0 1.3.6 1.3 1.4 0 .9-.5 2.2-.8 3.4-.2 1 .5 1.8 1.5 1.8 1.8 0 3-2.3 3-5 0-2-1.4-3.6-3.9-3.6-2.9 0-4.6 2.1-4.6 4.4 0 .8.2 1.4.6 1.9.2.2.2.3.1.5l-.2.9c-.1.3-.3.4-.5.2-1-.5-1.6-2-1.6-3.2 0-2.6 2.1-5.7 6.3-5.7 3.3 0 5.6 2.4 5.6 5 0 3.4-1.9 6-4.7 6-1 0-1.8-.5-2.1-1.1l-.6 2.3c-.2.8-.7 1.7-1 2.3A10 10 0 1 0 12 2Z" fill={c}/>,
    bluesky: <path d="M12 10.8C10.8 8.5 7.6 4.3 5 4c-1.4-.2-2 .6-2 2.2 0 1.6 1 5.2 1.6 5.9.5.7 1.6 1 3 .8-2.6.4-3.3 1.7-1.8 3.4 1.5 1.7 3.3.4 4.2-1.3.4-.8.6-1.4 1-2.3.4.9.6 1.5 1 2.3.9 1.7 2.7 3 4.2 1.3 1.5-1.7.8-3-1.8-3.4 1.4.2 2.5-.1 3-.8.6-.7 1.6-4.3 1.6-5.9 0-1.6-.6-2.4-2-2.2-2.6.3-5.8 4.5-7 6.8Z" fill={c}/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">{paths[p]}</svg>;
}

const PLATFORMS = {
  youtube:   { name: 'YouTube',   tint: 'var(--red)' },
  tiktok:    { name: 'TikTok',    tint: 'var(--ink)' },
  instagram: { name: 'Instagram', tint: 'var(--purple)' },
  x:         { name: 'X',         tint: 'var(--ink)' },
  linkedin:  { name: 'LinkedIn',  tint: 'var(--blue)' },
  pinterest: { name: 'Pinterest', tint: 'var(--red)' },
  bluesky:   { name: 'Bluesky',   tint: 'var(--teal)' },
};

const DRAFTS = [
  { id: 'd1', title: 'Launch film — vertical cut', cap: 'Maestro is live. One operator, a fleet of agents — run projects, schedules, and budgets from one calm place.', ar: '9/16', tint: 'linear-gradient(150deg,#0E2A5E,#30B0C7)', dest: ['youtube', 'tiktok', 'instagram'], when: 'Today 14:00', inapp: true },
  { id: 'd2', title: 'Launch week thread', cap: 'Here’s everything that shipped in Maestro this week ↓ A 7-part thread on durable agents.', ar: '16/9', tint: 'linear-gradient(150deg,#1b2a4a,#5856D6)', dest: ['x', 'linkedin', 'bluesky'], when: 'Today 16:30', inapp: false },
  { id: 'd3', title: 'Icon set reveal', cap: 'Fresh system icons — 48 glyphs, 3 weights, exported @3x. Swipe for the grid.', ar: '9/16', tint: 'linear-gradient(150deg,#2a1b4a,#AF52DE)', dest: ['instagram', 'pinterest'], when: 'Tomorrow 09:00', inapp: true },
  { id: 'd4', title: 'Behind the scenes — render farm', cap: 'How we render a video minute for under a dollar on self-hosted GPUs.', ar: '16/9', tint: 'linear-gradient(150deg,#1b3a2a,#1F8A5B)', dest: ['youtube', 'linkedin'], when: 'Jun 19 11:00', inapp: false },
];

Object.assign(window, { PGlyph, PLATFORMS, DRAFTS });
