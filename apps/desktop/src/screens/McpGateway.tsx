/* MCP Gateway — Tools & Gateway page. Segmented tabs (Servers, Live activity,
   Denials), deferred-loading toggles, live tool-call stream, denial allow flow
   with a scoped-grant confirm sheet, and the ⌘K command palette.
   Ported to ES-module TypeScript React — visual output unchanged. */

import React from 'react';
import { AppShell } from '../lib/appShell';
import { Icon, type IconName } from '../lib/icons';
import { Switch } from '../lib/ui';

/* ───────────────────────── page-specific CSS (from <Page>.html) ───────────────────────── */
const styles = `
  @keyframes spin { to { transform: rotate(360deg); } }
  .app-wallpaper { position: absolute; inset: 0; z-index: 0; pointer-events: none;
    background: radial-gradient(60% 50% at 16% 0%, color-mix(in srgb, var(--blob-a) 26%, transparent), transparent 70%), radial-gradient(55% 50% at 100% 100%, color-mix(in srgb, var(--blob-b) 22%, transparent), transparent 70%), var(--bg); }
  .nav-item:hover { background: var(--fill-tertiary); color: var(--ink); }
  .ws-header:hover { background: var(--fill-tertiary); }
  .search-field:hover { background: var(--fill-secondary); }
  .tb-icon:hover { background: var(--fill-secondary); color: var(--ink); }
  .link-btn:hover { text-decoration: underline; }
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .ghost-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  .filter-chip:hover { filter: brightness(0.97); }
  .breathe { animation: breathe 1.6s ease-in-out infinite; }
  @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  .call-row { transition: background 200ms ease; }
  .call-fresh { animation: callIn 600ms var(--spring); }
  @keyframes callIn { 0% { background: color-mix(in srgb, var(--blue) 10%, transparent); transform: translateY(-3px); } 100% { background: transparent; transform: none; } }
  .tab-fade { animation: tfade 240ms var(--spring); }
  @keyframes tfade { from { transform: translateY(6px); } to { transform: none; } }
  .sheet-pop { animation: sheetPop 220ms var(--spring); }
  @keyframes sheetPop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
`;

/* ───────────────────────── data ───────────────────────── */
interface Proj { name: string; color: string; }
const MCP_PROJ: Record<string, Proj> = {
  atlas: { name: 'Atlas API', color: 'var(--blue)' },
  content: { name: 'Q3 Content', color: 'var(--purple)' },
  scan: { name: 'Market Scan', color: 'var(--indigo)' },
};

interface Server {
  proj: string;
  name: string;
  glyph: string;
  tint: string;
  transport: string;
  tools: number;
  loaded: number;
  defer: boolean;
  scope: string;
  signed: boolean;
  on: boolean;
  ns: string;
}

const SERVERS: Server[] = [
  { proj: 'atlas', name: 'GitHub', glyph: 'gh', tint: 'var(--ink)', transport: 'HTTP', tools: 12, loaded: 3, defer: true, scope: 'read-write', signed: true, on: true, ns: 'com.github.mcp' },
  { proj: 'atlas', name: 'Postgres (prod)', glyph: 'pg', tint: 'var(--teal)', transport: 'stdio', tools: 6, loaded: 2, defer: true, scope: 'read-only', signed: true, on: true, ns: 'org.postgresql.mcp' },
  { proj: 'atlas', name: 'Sentry', glyph: 'se', tint: 'var(--orange)', transport: 'HTTP', tools: 4, loaded: 0, defer: true, scope: 'read-only', signed: true, on: false, ns: 'io.sentry.mcp' },
  { proj: 'content', name: 'Linear', glyph: 'li', tint: 'var(--indigo)', transport: 'HTTP', tools: 8, loaded: 4, defer: false, scope: 'read-write', signed: true, on: true, ns: 'com.linear.mcp' },
  { proj: 'content', name: 'Notion', glyph: 'no', tint: 'var(--ink)', transport: 'HTTP', tools: 9, loaded: 2, defer: true, scope: 'read-only', signed: true, on: true, ns: 'so.notion.mcp' },
  { proj: 'scan', name: 'Brave Search', glyph: 'br', tint: 'var(--orange)', transport: 'HTTP', tools: 3, loaded: 1, defer: true, scope: 'read-only', signed: true, on: true, ns: 'com.brave.mcp' },
  { proj: 'scan', name: 'Web scraper', glyph: 'ws', tint: 'var(--ink-secondary)', transport: 'stdio', tools: 5, loaded: 0, defer: true, scope: 'read-only · isolated', signed: false, on: false, ns: 'local.scraper' },
];

/* ───────────────────────── Servers tab ───────────────────────── */
function SrvGlyph({ s, size = 38 }: { s: Server; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: 10, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${s.tint} 15%, transparent)`, color: s.tint, font: '700 var(--fs-footnote)/1 var(--font-mono)', textTransform: 'uppercase' }}>{s.glyph}</span>;
}

function ServerRow({ s, last }: { s: Server; last: boolean }) {
  const [on, setOn] = React.useState(s.on);
  const [defer, setDefer] = React.useState(s.defer);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderBottom: last ? 'none' : '0.5px solid var(--separator)', opacity: on ? 1 : 0.62, transition: 'opacity 220ms ease' }}>
      <SrvGlyph s={s} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)' }}>{s.name}</span>
          <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/18px var(--font-mono)', color: 'var(--ink-secondary)' }}>{s.transport}</span>
          {s.signed ? <span title="Signature verified" style={{ color: 'var(--green)' }}><Icon name="shield" size={14} /></span> : <span title="Unsigned" style={{ color: 'var(--orange)' }}><Icon name="alert" size={14} /></span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
          <span className="tool-count" style={{ fontVariantNumeric: 'tabular-nums' }}>{s.tools} tools · {on ? s.loaded : 0} loaded</span>
          <span style={{ color: 'var(--ink-tertiary)' }}>·</span>
          <span>{s.scope}</span>
        </div>
      </div>
      {/* deferred-loading */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 6 }}>
        <span style={{ textAlign: 'right' }}>
          <span style={{ display: 'block', font: '500 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)' }}>Load on demand</span>
          <span style={{ display: 'block', font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>Saves ~85% startup tokens</span>
        </span>
        <Switch on={defer} onChange={setDefer} />
      </div>
      <span style={{ width: 1, height: 28, background: 'var(--separator)' }} />
      <Switch on={on} onChange={setOn} />
    </div>
  );
}

function ServersTab() {
  const [filter, setFilter] = React.useState('all');
  const projs = filter === 'all' ? Object.keys(MCP_PROJ) : [filter];
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        <button onClick={() => setFilter('all')} className="filter-chip" style={{ height: 32, padding: '0 14px', borderRadius: 'var(--r-pill)', background: filter === 'all' ? 'var(--blue)' : 'var(--fill-secondary)', color: filter === 'all' ? '#fff' : 'var(--ink-secondary)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>All projects</button>
        {Object.entries(MCP_PROJ).map(([k, p]) => (
          <button key={k} onClick={() => setFilter(k)} className="filter-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', background: filter === k ? 'var(--blue)' : 'var(--fill-secondary)', color: filter === k ? '#fff' : 'var(--ink-secondary)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
            <span style={{ width: 7, height: 7, borderRadius: 4, background: p.color }} /> {p.name}
          </button>
        ))}
      </div>

      {projs.map(pk => {
        const rows = SERVERS.filter(s => s.proj === pk);
        const p = MCP_PROJ[pk];
        return (
          <div key={pk} style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ width: 9, height: 9, borderRadius: 5, background: p.color }} />
              <span style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>{p.name}</span>
              <span style={{ flex: 1 }} />
              <button className="link-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)' }}><Icon name="plus" size={14} stroke={2.4} /> Add server</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: '12px 12px 0 0', background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', borderBottom: 'none', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>
              <Icon name="lock" size={13} style={{ color: 'var(--ink-tertiary)' }} /> Deny by default — agents reach only what you allow here.
            </div>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: '0 0 12px 12px', border: '0.5px solid var(--separator)', overflow: 'hidden', boxShadow: 'var(--card-shadow)' }}>
              {rows.map((s, i) => <ServerRow key={s.name} s={s} last={i === rows.length - 1} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────────────── Live activity ───────────────────────── */
interface Call { job: string; server: string; tool: string; scope: string; ok: boolean; ms: string; }

const CALLS_SEED: Call[] = [
  { job: 'atlas', server: 'github', tool: 'get_pull_request', scope: 'read', ok: true, ms: '142ms' },
  { job: 'atlas', server: 'postgres', tool: 'query', scope: 'read', ok: true, ms: '38ms' },
  { job: 'content', server: 'linear', tool: 'create_issue', scope: 'write', ok: true, ms: '210ms' },
  { job: 'scan', server: 'brave', tool: 'web_search', scope: 'read', ok: true, ms: '480ms' },
  { job: 'atlas', server: 'github', tool: 'create_commit_status', scope: 'write', ok: true, ms: '96ms' },
  { job: 'content', server: 'notion', tool: 'append_block', scope: 'write', ok: false, ms: '12ms' },
  { job: 'atlas', server: 'postgres', tool: 'list_tables', scope: 'read', ok: true, ms: '22ms' },
  { job: 'scan', server: 'brave', tool: 'news_search', scope: 'read', ok: true, ms: '512ms' },
];
const JOB_TINT: Record<string, string> = { atlas: 'var(--blue)', content: 'var(--purple)', scan: 'var(--indigo)' };

interface CallRow extends Call { id: number; t: number; fresh?: boolean; }

function LiveActivity() {
  const [rows, setRows] = React.useState<CallRow[]>(() => CALLS_SEED.map((c, i) => ({ ...c, id: i, t: 14 * 3600 + 8 * 60 + 22 - i * 3 })));
  const [paused, setPaused] = React.useState(false);
  const idRef = React.useRef(CALLS_SEED.length);

  React.useEffect(() => {
    if (paused) return;
    const t = setInterval(() => {
      const c = CALLS_SEED[Math.floor(Math.random() * CALLS_SEED.length)];
      setRows(r => [{ ...c, id: idRef.current++, t: Math.floor(Date.now() / 1000) % 86400, fresh: true }, ...r].slice(0, 40));
    }, 1800);
    return () => clearInterval(t);
  }, [paused]);

  const fmt = (s: number) => { const h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60, sec = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`; };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, height: 40, padding: '0 14px', borderRadius: 11, background: 'var(--bg-grouped)', border: '0.5px solid var(--separator)', maxWidth: 360, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
          <Icon name="search" size={16} style={{ color: 'var(--ink-tertiary)' }} />
          <span style={{ font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Filter by server, tool, or job</span>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, font: '500 var(--fs-footnote)/1 var(--font-text)', color: paused ? 'var(--ink-tertiary)' : 'var(--green)' }}>
          {!paused && <span className="breathe" style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--green)' }} />}{paused ? 'Paused' : 'Live'}
        </span>
        <button onClick={() => setPaused(p => !p)} className="ghost-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 36, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
          <Icon name={paused ? 'play' : 'pause'} size={14} /> {paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden', boxShadow: 'var(--card-shadow)' }}>
        {rows.map((r, i) => (
          <div key={r.id} className={`call-row ${r.fresh ? 'call-fresh' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 16px', borderBottom: i < rows.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
            <span style={{ font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', width: 64, flexShrink: 0 }}>{fmt(r.t)}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, width: 96, flexShrink: 0 }}><span style={{ width: 7, height: 7, borderRadius: 4, background: JOB_TINT[r.job] }} /><span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{MCP_PROJ[r.job].name}</span></span>
            <span style={{ flex: 1, minWidth: 0, font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><span style={{ color: 'var(--ink-tertiary)' }}>{r.server}.</span>{r.tool}</span>
            <span style={{ height: 20, padding: '0 8px', borderRadius: 'var(--r-pill)', background: r.scope === 'write' ? 'color-mix(in srgb, var(--orange) 13%, transparent)' : 'var(--fill-secondary)', color: r.scope === 'write' ? 'var(--orange)' : 'var(--ink-secondary)', font: '600 var(--fs-caption)/20px var(--font-text)', flexShrink: 0 }}>{r.scope}</span>
            <span style={{ font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', width: 52, textAlign: 'right', flexShrink: 0 }}>{r.ms}</span>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: r.ok ? 'var(--green)' : 'var(--red)', flexShrink: 0 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── Denials tab ───────────────────────── */
interface Denial { job: string; server: string; tool: string; reason: string; }

const DENIALS: Denial[] = [
  { job: 'scan', server: 'web scraper', tool: 'fetch_url', reason: 'Not on project allowlist' },
  { job: 'atlas', server: 'github', tool: 'delete_repo', reason: 'Capability not granted' },
  { job: 'content', server: 'notion', tool: 'export_workspace', reason: 'Signature drift' },
  { job: 'atlas', server: 'postgres', tool: 'drop_table', reason: 'Capability not granted' },
];

function DenialsTab({ onAllow }: { onAllow: (d: Denial) => void }) {
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden', boxShadow: 'var(--card-shadow)' }}>
      {DENIALS.map((d, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderBottom: i < DENIALS.length - 1 ? '0.5px solid var(--separator)' : 'none', background: 'rgba(255,59,48,0.03)' }}>
          <span style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'rgba(255,59,48,0.12)', color: 'var(--red)' }}><Icon name="lock" size={16} /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', font: '500 var(--fs-callout)/1.1 var(--font-mono)', color: 'var(--ink)' }}><span style={{ color: 'var(--ink-tertiary)' }}>{d.server}.</span>{d.tool}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--red)', marginTop: 3 }}>
              <Icon name="xCircle" size={12} /> {d.reason} <span style={{ color: 'var(--ink-tertiary)' }}>· {MCP_PROJ[d.job].name}</span>
            </span>
          </span>
          <button onClick={() => onAllow(d)} className="link-btn" style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)', flexShrink: 0 }}>Allow for this project…</button>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── Scoped-grant confirm sheet ───────────────────────── */
function GrantSheet({ denial, onClose }: { denial: Denial; onClose: () => void }) {
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32, background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 420, background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', padding: 24 }}>
        <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Grant a scoped tool?</h2>
        <p style={{ margin: '0 0 16px', font: '400 var(--fs-subhead)/1.45 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' } as React.CSSProperties}>
          Allow <span style={{ font: '600 var(--fs-subhead) var(--font-mono)', color: 'var(--ink)' }}>{denial.server}.{denial.tool}</span> for <b style={{ color: 'var(--ink)' }}>{MCP_PROJ[denial.job].name}</b> only. Other projects stay denied.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
          {[['Scope', 'This project only'], ['Mode', 'Read-only'], ['Expires', 'Until you revoke']].map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', borderRadius: 10, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)' }}>
              <span style={{ flex: 1, font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{r[0]}</span>
              <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>{r[1]}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={onClose} className="primary-cta" style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Grant access</button>
        </div>
      </div>
    </div>
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
interface McpTab { key: string; label: string; icon: IconName; }
const MCP_TABS: McpTab[] = [
  { key: 'servers', label: 'Servers', icon: 'cpu' },
  { key: 'activity', label: 'Live activity', icon: 'bolt' },
  { key: 'denials', label: 'Denials', icon: 'lock' },
];

export default function McpGateway() {
  const [tab, setTab] = React.useState('servers');
  const [grant, setGrant] = React.useState<Denial | null>(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const ti = MCP_TABS.findIndex(t => t.key === tab);

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  return (
    <AppShell
      active="skills"
      onSearch={() => setPaletteOpen(true)}
      budget={{ spent: 38.20, cap: 200, animateKey: 0 }}
    >
      <style>{styles}</style>

      <div style={{ padding: '24px 28px 36px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10 }}>
          <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Tools &amp; Gateway</h1>
          <span style={{ flex: 1 }} />
          <div style={{ position: 'relative', display: 'inline-flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 11 }}>
            <div style={{ position: 'absolute', top: 3, bottom: 3, left: `calc(${ti} * 120px + 3px)`, width: 120, background: 'var(--bg-elevated)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 280ms var(--spring)' }} />
            {MCP_TABS.map(t => <button key={t.key} onClick={() => setTab(t.key)} style={{ position: 'relative', zIndex: 1, width: 120, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 0', font: `${tab === t.key ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`, color: tab === t.key ? 'var(--ink)' : 'var(--ink-secondary)' }}><Icon name={t.icon} size={15} /> {t.label}</button>)}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>
          <Icon name="shield" size={14} style={{ color: 'var(--green)' }} /> One chokepoint — every tool call passes through the gateway and lands in the audit log.
        </div>

        <div key={tab} className="tab-fade">
          {tab === 'servers' && <ServersTab />}
          {tab === 'activity' && <LiveActivity />}
          {tab === 'denials' && <DenialsTab onAllow={setGrant} />}
        </div>
      </div>

      {grant && <GrantSheet denial={grant} onClose={() => setGrant(null)} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
