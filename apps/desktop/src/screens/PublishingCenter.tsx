/* Publishing Center — the studio's output lands here first, nothing publishes
   without the operator. Drafts grid (approve & schedule), week calendar,
   per-platform connection/quota status, and an append-only provenance ledger,
   plus the ⌘K palette.

   Ported from the design prototype (pub-data / pub-views / pub-app) to an
   ES-module TypeScript React screen. Visual output is unchanged.

   The prototype's WindowFrame + Sidebar + Toolbar chrome maps onto the shared
   <AppShell>; cross-page location.href navigation is handled by AppShell's
   react-router useNavigate. PGlyph, PlatChip, the four tab views, and the
   CommandPalette are not exported by the shared library, so they are inlined
   here. */

import React from 'react';
import { Icon, type IconName } from '../lib/icons';
import { AppShell } from '../lib/appShell';

// page-specific CSS lifted from "Publishing Center".html <style>
// (hover/animation hooks; the shared global stylesheet already defines
//  .nav-item / .ws-header / .search-field / .tb-icon / .app-wallpaper / spin)
const PUBLISHING_CSS = `
  .link-btn:hover { text-decoration: underline; }
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .ghost-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  .draft-card { transition: transform 160ms var(--spring), box-shadow 160ms ease, opacity 320ms ease; }
  .draft-card:hover { transform: translateY(-2px); box-shadow: var(--card-shadow), 0 10px 28px rgba(15,20,60,0.12); }
  .draft-card.fly-out { animation: flyOut 360ms var(--spring) forwards; }
  @keyframes flyOut { to { transform: translate(-40px,-30px) scale(0.85); opacity: 0; } }
  .pub-chip:hover { box-shadow: var(--card-shadow); transform: translateY(-1px); }
  .tab-fade { animation: tfade 240ms var(--spring); }
  @keyframes tfade { from { transform: translateY(6px); } to { transform: none; } }
  .toast { animation: toastIn 280ms var(--spring); }
  @keyframes toastIn { from { transform: translate(-50%, 12px); } to { transform: translate(-50%, 0); } }
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
`;

// ──────────────────────────────────────────────────────────────────────────
// Platform defs (monochrome brand glyphs) + data (pub-data)
// ──────────────────────────────────────────────────────────────────────────

type PlatformKey = 'youtube' | 'tiktok' | 'instagram' | 'x' | 'linkedin' | 'pinterest' | 'bluesky';

function PGlyph({ p, size = 18 }: { p: PlatformKey; size?: number }) {
  const c = 'currentColor';
  const paths: Record<PlatformKey, React.ReactNode> = {
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

interface PlatformMeta { name: string; tint: string }

const PLATFORMS: Record<PlatformKey, PlatformMeta> = {
  youtube:   { name: 'YouTube',   tint: 'var(--red)' },
  tiktok:    { name: 'TikTok',    tint: 'var(--ink)' },
  instagram: { name: 'Instagram', tint: 'var(--purple)' },
  x:         { name: 'X',         tint: 'var(--ink)' },
  linkedin:  { name: 'LinkedIn',  tint: 'var(--blue)' },
  pinterest: { name: 'Pinterest', tint: 'var(--red)' },
  bluesky:   { name: 'Bluesky',   tint: 'var(--teal)' },
};

interface Draft {
  id: string;
  title: string;
  cap: string;
  ar: string;
  tint: string;
  dest: PlatformKey[];
  when: string;
  inapp: boolean;
}

const DRAFTS: Draft[] = [
  { id: 'd1', title: 'Launch film — vertical cut', cap: 'Maestro is live. One operator, a fleet of agents — run projects, schedules, and budgets from one calm place.', ar: '9/16', tint: 'linear-gradient(150deg,#0E2A5E,#30B0C7)', dest: ['youtube', 'tiktok', 'instagram'], when: 'Today 14:00', inapp: true },
  { id: 'd2', title: 'Launch week thread', cap: 'Here’s everything that shipped in Maestro this week ↓ A 7-part thread on durable agents.', ar: '16/9', tint: 'linear-gradient(150deg,#1b2a4a,#5856D6)', dest: ['x', 'linkedin', 'bluesky'], when: 'Today 16:30', inapp: false },
  { id: 'd3', title: 'Icon set reveal', cap: 'Fresh system icons — 48 glyphs, 3 weights, exported @3x. Swipe for the grid.', ar: '9/16', tint: 'linear-gradient(150deg,#2a1b4a,#AF52DE)', dest: ['instagram', 'pinterest'], when: 'Tomorrow 09:00', inapp: true },
  { id: 'd4', title: 'Behind the scenes — render farm', cap: 'How we render a video minute for under a dollar on self-hosted GPUs.', ar: '16/9', tint: 'linear-gradient(150deg,#1b3a2a,#1F8A5B)', dest: ['youtube', 'linkedin'], when: 'Jun 19 11:00', inapp: false },
];

// ──────────────────────────────────────────────────────────────────────────
// Shared platform chip (pub-views)
// ──────────────────────────────────────────────────────────────────────────

function PlatChip({ p, small }: { p: PlatformKey; small?: boolean }) {
  const pl = PLATFORMS[p];
  return (
    <span title={pl.name} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: small ? 24 : 28, height: small ? 24 : 28, borderRadius: 7,
      background: 'var(--fill-secondary)', color: pl.tint }}><PGlyph p={p} size={small ? 14 : 16} /></span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Drafts grid (pub-views)
// ──────────────────────────────────────────────────────────────────────────

function DraftsGrid({ onApprove }: { onApprove: (id: string) => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px,1fr))', gap: 18 }}>
      {DRAFTS.map(d => (
        <div key={d.id} data-draft={d.id} className="draft-card" style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', gap: 14, padding: 14 }}>
            <div style={{ width: d.ar === '9/16' ? 64 : 104, aspectRatio: d.ar, borderRadius: 10, background: d.tint, flexShrink: 0, position: 'relative', overflow: 'hidden' }}>
              <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'rgba(255,255,255,0.85)' }}><Icon name="play" size={20} /></span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ font: '600 var(--fs-callout)/1.25 var(--font-text)', color: 'var(--ink)', marginBottom: 5 }}>{d.title}</div>
              <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{d.cap}</div>
            </div>
          </div>
          <div style={{ padding: '0 14px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6 }}>{d.dest.map(p => <PlatChip key={p} p={p} small />)}</div>
            <span style={{ flex: 1 }} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}><Icon name="clock" size={12} /> {d.when}</span>
          </div>
          <div style={{ padding: '0 14px 12px', display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)', background: 'rgba(52,199,89,0.14)', color: 'var(--green)', font: '600 var(--fs-caption)/1 var(--font-text)' }}><Icon name="shield" size={11} /> AI label ✓ · C2PA ✓</span>
            {d.inapp && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '500 var(--fs-caption)/1 var(--font-text)' }}><Icon name="alert" size={11} /> Goes to in-app drafts (platform rule)</span>}
          </div>
          <div style={{ display: 'flex', gap: 9, padding: '12px 14px', borderTop: '0.5px solid var(--separator)', marginTop: 'auto' }}>
            <button onClick={() => onApprove(d.id)} className="primary-cta" style={{ flex: 1, height: 38, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', boxShadow: '0 4px 14px rgba(0,122,255,0.28)' }}>Approve &amp; schedule</button>
            <button className="ghost-btn" style={{ height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Edit</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Calendar view (pub-views)
// ──────────────────────────────────────────────────────────────────────────

const PUB_WEEK = ['Mon 15', 'Tue 16', 'Wed 17', 'Thu 18', 'Fri 19', 'Sat 20', 'Sun 21'];

interface PubEvent { day: number; time: string; p: PlatformKey; label: string }

const PUB_EVENTS: PubEvent[] = [
  { day: 0, time: '09:00', p: 'instagram', label: 'Icon set' },
  { day: 2, time: '14:00', p: 'youtube', label: 'Launch film' },
  { day: 2, time: '16:30', p: 'x', label: 'Launch thread' },
  { day: 4, time: '11:00', p: 'youtube', label: 'Render farm' },
  { day: 4, time: '18:00', p: 'linkedin', label: 'Recap post' },
  { day: 5, time: '10:00', p: 'tiktok', label: 'Teaser' },
];

function PubCalendar() {
  const hours = ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00'];
  const rowFor = (t: string) => hours.findIndex(h => h >= t.slice(0, 2) + ':00') >= 0 ? Math.max(0, Math.floor((parseInt(t) - 8) / 2)) : 0;
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '56px repeat(7,1fr)', borderBottom: '0.5px solid var(--separator)' }}>
        <div style={{ borderRight: '0.5px solid var(--separator)' }} />
        {PUB_WEEK.map((d, i) => <div key={i} style={{ padding: '11px 0', textAlign: 'center', font: '600 var(--fs-footnote)/1.2 var(--font-text)', color: i === 2 ? 'var(--red)' : 'var(--ink)', borderRight: i < 6 ? '0.5px solid var(--separator)' : 'none' }}>{d}</div>)}
      </div>
      {hours.map((h, hi) => (
        <div key={h} style={{ display: 'grid', gridTemplateColumns: '56px repeat(7,1fr)', borderBottom: hi < hours.length - 1 ? '0.5px solid var(--separator)' : 'none', minHeight: 64 }}>
          <div style={{ borderRight: '0.5px solid var(--separator)', padding: '6px 8px 0', textAlign: 'right', font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{h}</div>
          {PUB_WEEK.map((_, di) => (
            <div key={di} style={{ borderRight: di < 6 ? '0.5px solid var(--separator)' : 'none', padding: 4, display: 'flex', flexDirection: 'column', gap: 4, background: di === 2 ? 'color-mix(in srgb, var(--red) 2%, transparent)' : 'transparent' }}>
              {PUB_EVENTS.filter(e => e.day === di && rowFor(e.time) === hi).map((e, i) => (
                <div key={i} className="pub-chip" style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 7px', borderRadius: 7, cursor: 'grab',
                  background: `color-mix(in srgb, ${PLATFORMS[e.p].tint} 14%, var(--bg-elevated))`, border: `1px solid color-mix(in srgb, ${PLATFORMS[e.p].tint} 35%, transparent)` }}>
                  <span style={{ color: PLATFORMS[e.p].tint, flexShrink: 0 }}><PGlyph p={e.p} size={12} /></span>
                  <span style={{ font: '600 var(--fs-caption)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Platforms tab (pub-views)
// ──────────────────────────────────────────────────────────────────────────

type PlatStatus = 'connected' | 'exhausted' | 'disconnected';

interface PlatRow { p: PlatformKey; status: PlatStatus; quota: string; pct: number; audit?: string; cost?: string }

const PLAT_ROWS: PlatRow[] = [
  { p: 'youtube', status: 'connected', quota: '4 / 6 uploads today', pct: 0.66 },
  { p: 'tiktok', status: 'connected', quota: 'Tokens refresh in 14h', pct: 0.4, audit: 'Audit pending · posts are self-only' },
  { p: 'instagram', status: 'connected', quota: '8 / 25 posts today', pct: 0.32 },
  { p: 'x', status: 'connected', quota: 'Unlimited · paid tier', pct: 0.2, cost: '~$0.20 per post with URL — links go in replies' },
  { p: 'linkedin', status: 'connected', quota: '3 / 5 posts today', pct: 0.6 },
  { p: 'pinterest', status: 'exhausted', quota: 'Daily limit reached · resets 6h', pct: 1 },
  { p: 'bluesky', status: 'disconnected', quota: '', pct: 0 },
];

function PlatformsTab() {
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      {PLAT_ROWS.map((r, i) => {
        const pl = PLATFORMS[r.p];
        const sMap: Record<PlatStatus, [string, string]> = { connected: ['Connected', 'var(--green)'], exhausted: ['Quota exhausted', 'var(--orange)'], disconnected: ['Not connected', 'var(--ink-tertiary)'] };
        const [sl, st] = sMap[r.status];
        return (
          <div key={r.p} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '15px 18px', borderBottom: i < PLAT_ROWS.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
            <span style={{ width: 40, height: 40, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: pl.tint }}><PGlyph p={r.p} size={22} /></span>
            <div style={{ width: 130, flexShrink: 0 }}>
              <div style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)' }}>{pl.name}</div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-caption)/1 var(--font-text)', color: st, marginTop: 3 }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: st }} /> {sl}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {r.status !== 'disconnected' && (
                <React.Fragment>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: r.status === 'exhausted' ? 'var(--orange)' : 'var(--ink-secondary)' }}>{r.quota}</span>
                  </div>
                  <div style={{ height: 5, borderRadius: 3, background: 'var(--fill-secondary)', overflow: 'hidden', maxWidth: 280 }}>
                    <div style={{ width: `${r.pct * 100}%`, height: '100%', borderRadius: 3, background: r.status === 'exhausted' ? 'var(--orange)' : pl.tint }} />
                  </div>
                </React.Fragment>
              )}
              {r.audit && <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 7, height: 20, padding: '0 8px', borderRadius: 'var(--r-pill)', background: 'rgba(255,149,0,0.13)', color: 'var(--orange)', font: '600 var(--fs-caption)/1 var(--font-text)' }}><Icon name="shield" size={11} /> {r.audit}</div>}
              {r.cost && <div style={{ font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 6 }}>{r.cost}</div>}
            </div>
            <button className={r.status === 'disconnected' ? 'primary-cta' : 'ghost-btn'} style={{ height: 36, padding: '0 16px', borderRadius: 'var(--r-pill)', flexShrink: 0,
              background: r.status === 'disconnected' ? 'var(--blue)' : 'var(--fill-secondary)', color: r.status === 'disconnected' ? '#fff' : 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)', boxShadow: r.status === 'disconnected' ? '0 4px 14px rgba(0,122,255,0.28)' : 'none' }}>
              {r.status === 'disconnected' ? 'Connect' : 'Reconnect'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Ledger tab (pub-views)
// ──────────────────────────────────────────────────────────────────────────

interface LedgerRow { time: string; p: PlatformKey[]; asset: string; ok: boolean; cost: string; hash: string }

const LEDGER: LedgerRow[] = [
  { time: '14:02', p: ['youtube'], asset: 'linear-gradient(135deg,#0E2A5E,#30B0C7)', ok: true, cost: '1 unit', hash: '9f2c…e3a1' },
  { time: '13:40', p: ['x', 'linkedin'], asset: 'linear-gradient(135deg,#1b2a4a,#5856D6)', ok: true, cost: '$0.20', hash: '4ab8…77d1' },
  { time: '11:15', p: ['instagram'], asset: 'linear-gradient(135deg,#2a1b4a,#AF52DE)', ok: false, cost: '—', hash: 'c19e…02ba' },
  { time: '09:30', p: ['pinterest'], asset: 'linear-gradient(135deg,#3a1b2a,#FF3B30)', ok: true, cost: '1 pin', hash: '7d10…aa3f' },
  { time: 'Yest 18:00', p: ['tiktok'], asset: 'linear-gradient(135deg,#1b3a2a,#1F8A5B)', ok: true, cost: '1 token', hash: 'b81e…e3a1' },
];

function LedgerTab() {
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '90px 60px 1.4fr 0.9fr 0.8fr 1fr', gap: 14, padding: '11px 18px', borderBottom: '0.5px solid var(--separator)', background: 'var(--fill-tertiary)' }}>
        {['Time', 'Asset', 'Platforms', 'Outcome', 'Cost', 'Provenance'].map((h, i) => <span key={i} style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{h}</span>)}
      </div>
      {LEDGER.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '90px 60px 1.4fr 0.9fr 0.8fr 1fr', gap: 14, alignItems: 'center', padding: '12px 18px', borderBottom: i < LEDGER.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
          <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>{r.time}</span>
          <span style={{ width: 30, height: 30, borderRadius: 7, background: r.asset, border: '0.5px solid var(--separator)' }} />
          <span style={{ display: 'flex', gap: 6 }}>{r.p.map(p => <PlatChip key={p} p={p} small />)}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '600 var(--fs-footnote)/1 var(--font-text)', color: r.ok ? 'var(--green)' : 'var(--red)' }}>
            <Icon name={r.ok ? 'checkCircle' : 'xCircle'} size={15} /> {r.ok ? 'Published' : 'Failed'}{!r.ok && <button className="link-btn" style={{ color: 'var(--blue)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>Retry</button>}
          </span>
          <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>{r.cost}</span>
          <span style={{ font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{r.hash}</span>
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Command palette (inlined from cc-palette — not exported by the shared lib)
// ──────────────────────────────────────────────────────────────────────────

interface PaletteItem { group: string; icon: IconName; label: string; hint: string }

const PALETTE_ITEMS: PaletteItem[] = [
  { group: 'Actions', icon: 'play', label: 'Run job…', hint: 'Start a new job in a project' },
  { group: 'Actions', icon: 'plus', label: 'New project…', hint: 'From a template' },
  { group: 'Actions', icon: 'calendar', label: 'Schedule a run…', hint: 'Pick time & cadence' },
  { group: 'Actions', icon: 'gauge', label: 'Adjust budget cap…', hint: 'Workspace or project' },
  { group: 'Recent', icon: 'gitMerge', label: 'Merge PR #482 — auth refactor', hint: 'Atlas API' },
  { group: 'Recent', icon: 'send', label: 'Publish “Launch week” thread', hint: 'Q3 Content' },
  { group: 'Recent', icon: 'telescope', label: 'Competitor digest', hint: 'Market Scan' },
  { group: 'Jump to', icon: 'layers', label: 'Projects', hint: '⌘2' },
  { group: 'Jump to', icon: 'shield', label: 'Approvals', hint: '⌘4' },
];

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = React.useState('');
  const [sel, setSel] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 60); }
  }, [open]);

  const filtered = PALETTE_ITEMS.filter(it => it.label.toLowerCase().includes(q.toLowerCase()) || it.hint.toLowerCase().includes(q.toLowerCase()));
  const groups = filtered.reduce((acc, it) => { (acc[it.group] = acc[it.group] || []).push(it); return acc; }, {} as Record<string, PaletteItem[]>);
  const flat = filtered;

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(flat.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (e.key === 'Escape') { onClose(); }
    else if (e.key === 'Enter') { onClose(); }
  };

  if (!open) return null;
  let idx = -1;
  return (
    <div onMouseDown={onClose} style={{
      position: 'absolute', inset: 0, zIndex: 80, display: 'flex', justifyContent: 'center', paddingTop: 132,
      background: 'rgba(10,12,24,0.28)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
    }}>
      <div onMouseDown={e => e.stopPropagation()} style={{
        width: 640, maxHeight: 460, alignSelf: 'flex-start', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--glass-border)',
        backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)',
        boxShadow: '0 30px 80px rgba(10,15,40,0.45), var(--glass-inner)', overflow: 'hidden',
        animation: 'palettePop 200ms var(--spring)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '16px 18px', borderBottom: '0.5px solid var(--separator)' }}>
          <Icon name="search" size={19} style={{ color: 'var(--ink-tertiary)' }} />
          <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}
            placeholder="Search commands, projects, jobs…"
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent',
              font: '400 var(--fs-title2)/1 var(--font-text)', color: 'var(--ink)' }} />
          <span style={{ padding: '3px 7px', borderRadius: 5, background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>esc</span>
        </div>

        <div style={{ overflowY: 'auto', padding: 8 }}>
          {flat.length === 0 && (
            <div style={{ padding: '28px 0', textAlign: 'center', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>No matches</div>
          )}
          {Object.entries(groups).map(([group, items]) => (
            <div key={group} style={{ marginBottom: 6 }}>
              <div style={{ padding: '6px 10px 4px', font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{group}</div>
              {items.map(it => {
                idx++; const active = idx === sel; const myIdx = idx;
                return (
                  <div key={it.label} onMouseEnter={() => setSel(myIdx)} onMouseDown={onClose} style={{
                    display: 'flex', alignItems: 'center', gap: 11, height: 42, padding: '0 10px', borderRadius: 9, cursor: 'pointer',
                    background: active ? 'var(--blue)' : 'transparent',
                  }}>
                    <span style={{ width: 28, height: 28, borderRadius: 7, display: 'grid', placeItems: 'center', flexShrink: 0,
                      background: active ? 'rgba(255,255,255,0.2)' : 'var(--fill-secondary)', color: active ? '#fff' : 'var(--ink-secondary)' }}>
                      <Icon name={it.icon} size={16} />
                    </span>
                    <span style={{ flex: 1, font: '500 var(--fs-callout)/1.1 var(--font-text)', color: active ? '#fff' : 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.label}</span>
                    <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: active ? 'rgba(255,255,255,0.8)' : 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{it.hint}</span>
                    {active && <Icon name="enter" size={15} style={{ color: 'rgba(255,255,255,0.9)' }} />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Publishing Center page root (pub-app)
// ──────────────────────────────────────────────────────────────────────────

interface PubTab { key: string; label: string; icon: IconName }

const PUB_TABS: PubTab[] = [
  { key: 'drafts', label: 'Drafts', icon: 'play' },
  { key: 'calendar', label: 'Calendar', icon: 'calendar' },
  { key: 'platforms', label: 'Platforms', icon: 'send' },
  { key: 'ledger', label: 'Ledger', icon: 'jobs' },
];

export default function PublishingCenter() {
  const [tab, setTab] = React.useState('drafts');
  const [toast, setToast] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const tabIdx = PUB_TABS.findIndex(t => t.key === tab);

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const approve = (id: string) => {
    const card = document.querySelector(`[data-draft="${id}"]`);
    if (card) { card.classList.add('fly-out'); setTimeout(() => { setToast(true); setTimeout(() => setToast(false), 2400); card.classList.remove('fly-out'); }, 360); }
  };

  return (
    <AppShell active="publishing" budget={{ spent: 38.20, cap: 200, animateKey: 0 }} onSearch={() => setPaletteOpen(true)}>
      <style>{PUBLISHING_CSS}</style>

      <div style={{ padding: '24px 28px 36px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
          <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Publishing</h1>
          <span style={{ flex: 1 }} />
          {/* segmented */}
          <div style={{ position: 'relative', display: 'inline-flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 11 }}>
            <div style={{ position: 'absolute', top: 3, bottom: 3, left: `calc(${tabIdx} * 110px + 3px)`, width: 110, background: 'var(--bg-elevated)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 280ms var(--spring)' }} />
            {PUB_TABS.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)} style={{ position: 'relative', zIndex: 1, width: 110, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 0',
                font: `${tab === t.key ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`, color: tab === t.key ? 'var(--ink)' : 'var(--ink-secondary)' }}>
                <Icon name={t.icon} size={15} /> {t.label}
              </button>
            ))}
          </div>
        </div>

        <div key={tab} className="tab-fade">
          {tab === 'drafts' && <React.Fragment>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>
              <Icon name="shield" size={14} style={{ color: 'var(--green)' }} /> The studio's output lands here first. Nothing publishes without you.
            </div>
            <DraftsGrid onApprove={approve} />
          </React.Fragment>}
          {tab === 'calendar' && <PubCalendar />}
          {tab === 'platforms' && <PlatformsTab />}
          {tab === 'ledger' && <React.Fragment>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <span style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>Append-only · read-only · exportable</span>
              <span style={{ flex: 1 }} />
              <button className="ghost-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}><Icon name="enter" size={14} style={{ transform: 'rotate(-90deg)' }} /> Export</button>
            </div>
            <LedgerTab />
          </React.Fragment>}
        </div>
      </div>

      {toast && (
        <div className="toast" style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 90, display: 'inline-flex', alignItems: 'center', gap: 10, height: 46, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--on-glass)', color: 'var(--bg-elevated)', boxShadow: '0 12px 32px rgba(10,15,40,0.4)' }}>
          <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--green)', display: 'grid', placeItems: 'center' }}><Icon name="calendar" size={12} style={{ color: '#fff' }} /></span>
          <span style={{ font: '600 var(--fs-subhead)/1 var(--font-text)' }}>Scheduled · added to the calendar</span>
        </div>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
