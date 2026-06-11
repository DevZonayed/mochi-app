/* Trend Intelligence — signal cards, brief feed, right rail, ⌘K palette.
   Indigo accent zone. Ported to ES-module TypeScript React — visual output
   unchanged. Uses the shared AppShell chrome and react-router navigation. */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../lib/appShell';
import { Icon, type IconName } from '../lib/icons';
import { Spinner } from '../lib/ui';

/* ───────────────────────── page-specific CSS (from <Page>.html) ───────────────────────── */
const styles = `
  .link-btn:hover { text-decoration: underline; }
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(88,86,214,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .ghost-btn:hover, .ctx-pick:hover { filter: brightness(0.98); }
  .tr-play:hover { background: color-mix(in srgb, var(--indigo) 14%, transparent); color: var(--indigo); }
  .title-row:hover, .run-link:hover { filter: brightness(0.99); box-shadow: var(--card-shadow); }
  .studio-btn { transition: transform 120ms var(--spring), box-shadow 160ms ease; }
  .studio-btn:hover { box-shadow: 0 8px 22px rgba(48,176,199,0.45); }
  .brief-card { transition: transform 420ms var(--spring), opacity 420ms ease; }
  .brief-card.fly-studio { animation: flyStudio 420ms var(--spring) forwards; }
  @keyframes flyStudio { to { transform: translate(-120px, 40px) scale(0.8); opacity: 0; } }
  .cursor-blink { animation: blink 1.05s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .stream-bullet { animation: bulletIn 400ms var(--spring) both; }
  @keyframes bulletIn { from { transform: translateX(-6px); opacity: 0.3; } to { transform: none; opacity: 1; } }
  .toast { animation: toastIn 280ms var(--spring); }
  @keyframes toastIn { from { transform: translate(-50%, 12px); } to { transform: translate(-50%, 0); } }
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
`;

/* ───────────────────────── platform glyphs (from publishing/pub-data) ───────────────────────── */
type PlatformKey = 'youtube' | 'tiktok' | 'instagram' | 'x' | 'linkedin' | 'pinterest' | 'bluesky';

function PGlyph({ p, size = 18 }: { p: PlatformKey; size?: number }) {
  const c = 'currentColor';
  const paths: Record<PlatformKey, React.ReactNode> = {
    youtube: <path d="M21.6 7.2a2.7 2.7 0 0 0-1.9-1.9C18 4.8 12 4.8 12 4.8s-6 0-7.7.5A2.7 2.7 0 0 0 2.4 7.2C2 8.9 2 12 2 12s0 3.1.4 4.8a2.7 2.7 0 0 0 1.9 1.9c1.7.5 7.7.5 7.7.5s6 0 7.7-.5a2.7 2.7 0 0 0 1.9-1.9c.4-1.7.4-4.8.4-4.8s0-3.1-.4-4.8ZM10 15V9l5.2 3L10 15Z" fill={c} />,
    tiktok: <path d="M16.5 3c.3 2.2 1.6 3.7 3.8 3.9v2.6c-1.3.1-2.5-.3-3.8-1v5.9c0 4.6-5 6-7.3 2.7-1.5-2.1-.7-5.8 3.4-6v2.7c-.3.05-.7.15-1 .27-.9.4-1.4 1-1.3 2 .2 1.9 3.7 2.5 3.4-1.2V3h2.8Z" fill={c} />,
    instagram: <><rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke={c} strokeWidth="1.8" /><circle cx="12" cy="12" r="4" fill="none" stroke={c} strokeWidth="1.8" /><circle cx="17" cy="7" r="1.3" fill={c} /></>,
    x: <path d="M17.5 3h3l-6.5 7.4L21.5 21h-5.9l-4.3-5.6L6.3 21H3.3l7-8L2.8 3h6l3.9 5.2L17.5 3Zm-1 16h1.6L7.6 4.7H5.9L16.5 19Z" fill={c} />,
    linkedin: <><rect x="3.5" y="3.5" width="17" height="17" rx="3" fill="none" stroke={c} strokeWidth="1.8" /><path d="M7 10v6M7 7.5v.01M11 16v-3.5a1.5 1.5 0 0 1 3 0V16M11 16v-6" stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round" /></>,
    pinterest: <path d="M12 2a10 10 0 0 0-3.6 19.3c-.1-.8-.2-2 0-2.9l1.2-5s-.3-.6-.3-1.5c0-1.4.8-2.4 1.8-2.4.9 0 1.3.6 1.3 1.4 0 .9-.5 2.2-.8 3.4-.2 1 .5 1.8 1.5 1.8 1.8 0 3-2.3 3-5 0-2-1.4-3.6-3.9-3.6-2.9 0-4.6 2.1-4.6 4.4 0 .8.2 1.4.6 1.9.2.2.2.3.1.5l-.2.9c-.1.3-.3.4-.5.2-1-.5-1.6-2-1.6-3.2 0-2.6 2.1-5.7 6.3-5.7 3.3 0 5.6 2.4 5.6 5 0 3.4-1.9 6-4.7 6-1 0-1.8-.5-2.1-1.1l-.6 2.3c-.2.8-.7 1.7-1 2.3A10 10 0 1 0 12 2Z" fill={c} />,
    bluesky: <path d="M12 10.8C10.8 8.5 7.6 4.3 5 4c-1.4-.2-2 .6-2 2.2 0 1.6 1 5.2 1.6 5.9.5.7 1.6 1 3 .8-2.6.4-3.3 1.7-1.8 3.4 1.5 1.7 3.3.4 4.2-1.3.4-.8.6-1.4 1-2.3.4.9.6 1.5 1 2.3.9 1.7 2.7 3 4.2 1.3 1.5-1.7.8-3-1.8-3.4 1.4.2 2.5-.1 3-.8.6-.7 1.6-4.3 1.6-5.9 0-1.6-.6-2.4-2-2.2-2.6.3-5.8 4.5-7 6.8Z" fill={c} />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">{paths[p]}</svg>;
}

const PLATFORMS: Record<PlatformKey, { name: string; tint: string }> = {
  youtube:   { name: 'YouTube',   tint: 'var(--red)' },
  tiktok:    { name: 'TikTok',    tint: 'var(--ink)' },
  instagram: { name: 'Instagram', tint: 'var(--purple)' },
  x:         { name: 'X',         tint: 'var(--ink)' },
  linkedin:  { name: 'LinkedIn',  tint: 'var(--blue)' },
  pinterest: { name: 'Pinterest', tint: 'var(--red)' },
  bluesky:   { name: 'Bluesky',   tint: 'var(--teal)' },
};

/* ───────────────────────── signal cards ───────────────────────── */
interface Topic { name: string; m: 'up' | 'down'; d: string; }
const TOPICS: Topic[] = [
  { name: 'AI agents that run overnight', m: 'up', d: '+128%' },
  { name: 'Self-hosted video models', m: 'up', d: '+74%' },
  { name: 'Cost-per-token explainers', m: 'up', d: '+31%' },
  { name: 'Prompt engineering tips', m: 'down', d: '−12%' },
  { name: 'No-code app builders', m: 'down', d: '−8%' },
];
interface AudioTrack { name: string; use: string; }
const AUDIO: AudioTrack[] = [
  { name: 'Aphex-style ambient loop', use: 'used in 12k posts' },
  { name: 'Lo-fi tape beat 84bpm', use: 'used in 9.4k posts' },
  { name: 'Cinematic riser + drop', use: 'used in 6.1k posts' },
];

function SignalCard({ title, icon, children }: { title: string; icon: IconName; children?: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 16, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 13 }}>
        <Icon name={icon} size={15} style={{ color: 'var(--indigo)' }} />
        <span style={{ font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function SignalRow() {
  const heat = [0.2, 0.5, 0.8, 1, 0.6, 0.3, 0.1, 0.4, 0.7, 0.9, 0.5, 0.2, 0.6, 0.85, 1, 0.7, 0.4, 0.2, 0.3, 0.5, 0.8];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
      <SignalCard title="Trending topics" icon="telescope">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {TOPICS.map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', width: 14 }}>{i + 1}</span>
              <span style={{ flex: 1, minWidth: 0, font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, font: '600 var(--fs-caption)/1 var(--font-mono)', color: t.m === 'up' ? 'var(--green)' : 'var(--red)' }}>
                {t.m === 'up' ? '▲' : '▼'} {t.d}
              </span>
            </div>
          ))}
        </div>
      </SignalCard>

      <SignalCard title="Trending audio" icon="play">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {AUDIO.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <button className="tr-play" style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--indigo)' }}><Icon name="play" size={12} /></button>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', font: '500 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
                <span style={{ display: 'block', font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>{a.use}</span>
              </span>
            </div>
          ))}
        </div>
      </SignalCard>

      <SignalCard title="Best times to post" icon="clock">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3 }}>
          {heat.map((v, i) => <div key={i} style={{ aspectRatio: '1', borderRadius: 3, background: `color-mix(in srgb, var(--blue) ${Math.round(v * 80)}%, var(--fill-secondary))` }} />)}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>
          <span>Mon</span><span>Sun</span>
        </div>
        <div style={{ font: '500 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 8 }}>Peak: <b style={{ color: 'var(--ink)' }}>Wed &amp; Sat, 6–8pm</b></div>
      </SignalCard>

      <SignalCard title="Competitor pulse" icon="cpu">
        <svg viewBox="0 0 120 50" style={{ width: '100%', height: 50 }} preserveAspectRatio="none">
          <polyline points="0,40 15,38 30,30 45,33 60,22 75,25 90,14 105,18 120,8" fill="none" stroke="var(--indigo)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="0,50 0,40 15,38 30,30 45,33 60,22 75,25 90,14 105,18 120,8 120,50" fill="color-mix(in srgb, var(--indigo) 10%, transparent)" stroke="none" />
        </svg>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
          <span style={{ font: '700 var(--fs-title2)/1 var(--font-mono)', color: 'var(--ink)' }}>+18%</span>
          <span style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>posting velocity vs last week</span>
        </div>
      </SignalCard>
    </div>
  );
}

/* ───────────────────────── brief feed ───────────────────────── */
interface Brief {
  id: string;
  title: string;
  hook: string;
  titles: string[];
  platforms: PlatformKey[];
  conf: number;
  live: boolean;
}

const BRIEFS: Brief[] = [
  { id: 'b1', title: 'Why agents that survive sleep change everything', hook: 'Your best ideas don’t clock out at 5pm — why should your tools?',
    titles: ['I let AI agents run my projects overnight — here’s what I woke up to', 'The case for durable agents (that don’t die when your laptop sleeps)', 'Overnight automation: a calm operator’s setup'],
    platforms: ['youtube', 'x'], conf: 92, live: false },
  { id: 'b2', title: 'Self-hosted video for under a dollar a minute', hook: 'A video minute can cost $45. Here’s how we got ours to $0.90.',
    titles: ['How I render AI video for pennies on my own GPU', 'Stop paying $45/min for AI video — self-host instead', 'The economics of self-hosted video models'],
    platforms: ['youtube', 'linkedin'], conf: 84, live: false },
];

function BriefCard({ b, live, onStudio }: { b: Brief; live: boolean; onStudio: (id: string) => void }) {
  const [sel, setSel] = React.useState(0);
  return (
    <div data-brief={b.id} className="brief-card" style={{ background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 22, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
        <h3 style={{ margin: 0, flex: 1, font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>{b.title}</h3>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)', background: 'color-mix(in srgb, var(--green) 14%, transparent)', color: 'var(--green)', font: '600 var(--fs-caption)/1 var(--font-text)', flexShrink: 0 }}>
          {b.conf}% confidence
        </span>
      </div>

      {/* hook — the expressive type moment */}
      <div style={{ padding: '14px 18px', borderRadius: 12, background: 'color-mix(in srgb, var(--indigo) 7%, transparent)', borderLeft: '3px solid var(--indigo)', marginBottom: 18 }}>
        <span style={{ font: '500 italic 22px/1.4 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>“{b.hook}”</span>
        {live && <span className="cursor-blink" style={{ marginLeft: 3, color: 'var(--indigo)' }}>▍</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 20 }}>
        <div>
          <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 10 }}>Suggested titles</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {b.titles.map((t, i) => (
              <button key={i} onClick={() => setSel(i)} className="title-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, textAlign: 'left',
                background: sel === i ? 'color-mix(in srgb, var(--indigo) 9%, transparent)' : 'var(--fill-tertiary)', border: `1px solid ${sel === i ? 'color-mix(in srgb, var(--indigo) 35%, transparent)' : 'var(--separator)'}` }}>
                <span style={{ width: 18, height: 18, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', background: sel === i ? 'var(--indigo)' : 'transparent', border: sel === i ? 'none' : '1.5px solid var(--separator-strong)' }}>{sel === i && <Icon name="check" size={11} stroke={3} style={{ color: '#fff' }} />}</span>
                <span style={{ font: '500 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink)' }}>{t}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 10 }}>Thumbnail concepts</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {['linear-gradient(135deg,#2a1b4a,#5856D6)', 'linear-gradient(135deg,#1b2a4a,#007AFF)', 'linear-gradient(135deg,#1b3a2a,#1F8A5B)', 'linear-gradient(135deg,#3a2a1b,#FF9500)'].map((g, i) => (
              <div key={i} style={{ aspectRatio: '16/10', borderRadius: 9, background: g, display: 'grid', placeItems: 'center', border: '0.5px solid var(--separator)' }}>
                <Icon name="image" size={18} style={{ color: 'rgba(255,255,255,0.7)' }} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, paddingTop: 16, borderTop: '0.5px solid var(--separator)' }}>
        <div style={{ display: 'flex', gap: 6 }}>{b.platforms.map(p => <span key={p} style={{ width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: PLATFORMS[p].tint }}><PGlyph p={p} size={14} /></span>)}</div>
        <span style={{ flex: 1 }} />
        <button className="ghost-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}><Icon name="calendar" size={16} /> Schedule series</button>
        <button onClick={() => onStudio(b.id)} className="studio-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--teal)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(48,176,199,0.32)' }}><Icon name="clapper" size={16} /> Send to Studio</button>
      </div>
    </div>
  );
}

/* ───────────────────────── right rail ───────────────────────── */
function ResearchRail() {
  const navigate = useNavigate();
  const runs: [string, string, string][] = [['Tech explainers · YouTube', '12 min ago', 'done'], ['TikTok hooks · short-form', '2 hr ago', 'done'], ['Competitor sweep · weekly', 'Yesterday', 'done']];
  const sources: [string, string][] = [['Official APIs', 'ok'], ['YouTube Data API', 'ok'], ['Scraper · trend mirror', 'risk']];
  return (
    <aside style={{ width: 300, flexShrink: 0, borderLeft: '0.5px solid var(--separator)', padding: 18, overflowY: 'auto',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 11 }}>Research history</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 22 }}>
        {runs.map((r, i) => (
          <a key={i} onClick={(e) => { e.preventDefault(); navigate('/session-transcript'); }} href="#" className="run-link" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 11px', borderRadius: 10, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', textDecoration: 'none', cursor: 'pointer' }}>
            <Icon name="checkCircle" size={15} style={{ color: 'var(--green)', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', font: '500 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r[0]}</span>
              <span style={{ display: 'block', font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>{r[1]}</span>
            </span>
            <Icon name="chevronRight" size={14} style={{ color: 'var(--ink-tertiary)' }} />
          </a>
        ))}
      </div>
      <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 11 }}>Source health</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sources.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 11px', borderRadius: 10, background: s[1] === 'risk' ? 'rgba(255,149,0,0.08)' : 'var(--fill-tertiary)', border: `0.5px solid ${s[1] === 'risk' ? 'rgba(255,149,0,0.3)' : 'var(--separator)'}` }}>
            <Icon name={s[1] === 'risk' ? 'alert' : 'check'} size={14} stroke={2.4} style={{ color: s[1] === 'risk' ? 'var(--orange)' : 'var(--green)', flexShrink: 0 }} />
            <span style={{ flex: 1, font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)' }}>{s[0]}{s[1] === 'risk' && <span style={{ display: 'block', font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--orange)', marginTop: 2 }}>Risk-flagged · isolated</span>}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

/* ───────────────────────── ⌘K command palette ───────────────────────── */
interface PaletteItem { group: string; icon: IconName; label: string; hint: string; }

const PALETTE_ITEMS: PaletteItem[] = [
  { group: 'Actions', icon: 'play',      label: 'Run job…',                       hint: 'Start a new job in a project' },
  { group: 'Actions', icon: 'plus',      label: 'New project…',                   hint: 'From a template' },
  { group: 'Actions', icon: 'calendar',  label: 'Schedule a run…',                hint: 'Pick time & cadence' },
  { group: 'Actions', icon: 'gauge',     label: 'Adjust budget cap…',             hint: 'Workspace or project' },
  { group: 'Recent',  icon: 'gitMerge',  label: 'Merge PR #482 — auth refactor',  hint: 'Atlas API' },
  { group: 'Recent',  icon: 'send',      label: 'Publish “Launch week” thread',   hint: 'Q3 Content' },
  { group: 'Recent',  icon: 'telescope', label: 'Competitor digest',              hint: 'Market Scan' },
  { group: 'Jump to', icon: 'layers',    label: 'Projects',                       hint: '⌘2' },
  { group: 'Jump to', icon: 'shield',    label: 'Approvals',                      hint: '⌘4' },
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

/* ───────────────────────── page root ───────────────────────── */
const STREAM_LINES = [
  'Scanning 1,240 recent uploads in this genre',
  'Clustering hooks by retention curve',
  'Drafting title variants',
  'Scoring thumbnail concepts',
];

export default function TrendIntelligence() {
  const [running, setRunning] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [flyToast, setFlyToast] = React.useState(false);

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const sendStudio = (id: string) => {
    const card = document.querySelector(`[data-brief="${id}"]`);
    if (card) {
      card.classList.add('fly-studio');
      setTimeout(() => { card.classList.remove('fly-studio'); setFlyToast(true); setTimeout(() => setFlyToast(false), 2200); }, 420);
    }
  };

  return (
    <AppShell
      active="trends"
      onSearch={() => setPaletteOpen(true)}
    >
      <style>{styles}</style>

      <div style={{ height: '100%', display: 'flex', minHeight: 0 }}>
        <main style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '24px 28px 36px' }}>
          {/* header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Trends</h1>
            <button className="ctx-pick" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', background: 'color-mix(in srgb, var(--indigo) 12%, transparent)', color: 'var(--indigo)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
              Tech explainers · YouTube <Icon name="chevronDown" size={14} />
            </button>
            <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Refreshed 12 min ago</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => setRunning(r => !r)} className="primary-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--indigo)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(88,86,214,0.3)' }}>
              {running ? <Spinner size={15} color="#fff" /> : <Icon name="telescope" size={16} />} {running ? 'Researching…' : 'Run research now'}
            </button>
          </div>

          <SignalRow />

          <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 14 }}>Content briefs</div>
          {running && (
            <div className="brief-card" style={{ background: 'var(--bg-elevated)', borderRadius: 18, border: '1px solid color-mix(in srgb, var(--indigo) 30%, transparent)', boxShadow: '0 0 0 4px color-mix(in srgb, var(--indigo) 10%, transparent), var(--card-shadow)', padding: 22, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
                <Spinner size={16} color="var(--indigo)" /><span style={{ font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>Generating brief…</span>
              </div>
              {STREAM_LINES.map((l, i) => (
                <div key={i} className="stream-bullet" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0', font: '400 var(--fs-subhead)/1.4 var(--font-mono)', color: 'var(--ink-secondary)', animationDelay: `${i * 0.3}s` }}>
                  <span style={{ color: 'var(--indigo)' }}>›</span> {l}
                </div>
              ))}
            </div>
          )}
          {BRIEFS.map(b => <BriefCard key={b.id} b={b} live={false} onStudio={sendStudio} />)}
        </main>
        <ResearchRail />
      </div>

      {flyToast && (
        <div className="toast" style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 90, display: 'inline-flex', alignItems: 'center', gap: 10, height: 46, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--on-glass)', color: 'var(--bg-elevated)', boxShadow: '0 12px 32px rgba(10,15,40,0.4)' }}>
          <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--teal)', display: 'grid', placeItems: 'center' }}><Icon name="clapper" size={12} style={{ color: '#fff' }} /></span>
          <span style={{ font: '600 var(--fs-subhead)/1 var(--font-text)' }}>Sent to Studio · pre-filled brief</span>
        </div>
      )}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
