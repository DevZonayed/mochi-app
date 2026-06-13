/* Settings — macOS System Settings model: left chrome sidebar + in-page
   settings nav + right grouped panes, with reset-confirm sheet and ⌘K palette.
   Full-window experience: renders its own window chrome (NOT the standard
   AppShell single-pane layout) because the prototype puts a second settings
   nav column beside the main pane.
   Ported to ES-module TypeScript React — visual output unchanged. */

import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Icon, type IconName } from '../lib/icons';
import { CommsPanel } from './CommsGateway';
import { BudgetPanel } from './BudgetDashboard';
import { pathForNav } from '../lib/routes';
import {
  GroupedList, Row, Switch, EffortDial, ModelSwitcher,
  type EffortStop,
} from '../lib/ui';
import {
  APP_W, APP_H, useAppScale, useTheme, getThemePref, setThemePref, TrafficLights, Sidebar, Toolbar,
  type Theme,
} from '../lib/appShell';
import { api, ApiError, type Workspace, type ProviderConn, type ProviderId, type Routing, type PairingInfo, type EngineStatuses, type AppSettings, IS_LOCAL } from '../lib/api';

/* ───────────────────────── page-specific CSS (from Settings.html) ───────────────────────── */
const styles = `
  @keyframes spin { to { transform: rotate(360deg); } }
  .app-wallpaper { position: absolute; inset: 0; z-index: 0; pointer-events: none;
    background: radial-gradient(60% 50% at 16% 0%, color-mix(in srgb, var(--blob-a) 26%, transparent), transparent 70%), radial-gradient(55% 50% at 100% 100%, color-mix(in srgb, var(--blob-b) 22%, transparent), transparent 70%), var(--bg); }
  .nav-item:hover { background: var(--fill-tertiary); color: var(--ink); }
  .ws-header:hover { background: var(--fill-tertiary); }
  .search-field:hover { background: var(--fill-secondary); }
  .tb-icon:hover { background: var(--fill-secondary); color: var(--ink); }
  .ghost-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  .reject-btn:hover { background: rgba(255,59,48,0.1); }
  .set-nav:hover { background: var(--fill-tertiary); }
  .pane-fade { animation: pfade 240ms var(--spring); }
  @keyframes pfade { from { transform: translateY(6px); } to { transform: none; } }
  .sheet-pop { animation: sheetPop 220ms var(--spring); }
  @keyframes sheetPop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
  *::-webkit-scrollbar { width: 9px; height: 9px; }
  *::-webkit-scrollbar-thumb { background: var(--fill-secondary); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
  ::selection { background: rgba(0,122,255,0.22); }
`;

/* ───────────────────────── ⌘K command palette ───────────────────────── */
interface PaletteItem { group: string; icon: IconName; label: string; hint: string; }

const PALETTE_ITEMS: PaletteItem[] = [
  { group: 'Jump to', icon: 'home', label: 'Command Center', hint: '⌘1' },
  { group: 'Jump to', icon: 'layers', label: 'Projects', hint: '⌘2' },
  { group: 'Jump to', icon: 'jobs', label: 'Jobs', hint: '⌘3' },
  { group: 'Jump to', icon: 'shield', label: 'Approvals', hint: '⌘4' },
  { group: 'Jump to', icon: 'clapper', label: 'Studio', hint: '' },
  { group: 'Jump to', icon: 'telescope', label: 'Trends', hint: '' },
  { group: 'Jump to', icon: 'send', label: 'Publishing', hint: '' },
  { group: 'Jump to', icon: 'gauge', label: 'Costs', hint: '' },
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

/* ───────────────────────── settings nav model ───────────────────────── */
interface SetNavItem { key: string; icon: IconName; label: string; tint: string; }

const SET_NAV: SetNavItem[] = [
  { key: 'general', icon: 'settings', label: 'General', tint: 'var(--ink-secondary)' },
  { key: 'engines', icon: 'cpu', label: 'Engines', tint: 'var(--purple)' },
  { key: 'accounts', icon: 'key', label: 'Accounts & keys', tint: 'var(--blue)' },
  { key: 'comms', icon: 'command', label: 'Comms', tint: 'var(--teal)' },
  { key: 'costs', icon: 'gauge', label: 'Costs', tint: 'var(--green)' },
  { key: 'security', icon: 'shield', label: 'Security', tint: 'var(--green)' },
  { key: 'devices', icon: 'smartphone', label: 'Devices', tint: 'var(--teal)' },
  { key: 'power', icon: 'bolt', label: 'Power & reliability', tint: 'var(--orange)' },
  { key: 'updates', icon: 'refresh', label: 'Updates', tint: 'var(--indigo)' },
  { key: 'danger', icon: 'alert', label: 'Danger zone', tint: 'var(--red)' },
];
/* Panes that bring their own page-scale layout and need the full pane width
   (not the 640px reading column the form panes use). */
const WIDE_PANES = new Set(['comms', 'costs']);

/* ───────────────────────── pane primitives ───────────────────────── */
function PaneHead({ children, sub }: { children?: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <h2 style={{ margin: 0, font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>{children}</h2>
      {sub && <p style={{ margin: '6px 0 0', font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>{sub}</p>}
    </div>
  );
}

function Seg({ options, value, onChange }: { options: string[]; value: string; onChange: (next: string) => void }) {
  const i = options.findIndex(o => o === value);
  return (
    <div style={{ position: 'relative', display: 'inline-flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 9 }}>
      <div style={{ position: 'absolute', top: 2, bottom: 2, left: `calc(${i} * (100% - 4px) / ${options.length} + 2px)`, width: `calc((100% - 4px) / ${options.length})`, background: 'var(--bg-elevated)', borderRadius: 7, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 240ms var(--spring)' }} />
      {options.map(o => <button key={o} onClick={() => onChange(o)} style={{ position: 'relative', zIndex: 1, padding: '6px 14px', font: '600 var(--fs-footnote)/1 var(--font-text)', color: value === o ? 'var(--ink)' : 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>{o}</button>)}
    </div>
  );
}

function ToggleRow({ label, sub, on: initial, last, onChange }: { label: React.ReactNode; sub?: React.ReactNode; on: boolean; last?: boolean; onChange?: (v: boolean) => void }) {
  const [on, setOn] = React.useState(initial);
  React.useEffect(() => { setOn(initial); }, [initial]);
  const toggle = (v: boolean) => { setOn(v); onChange?.(v); };
  return (
    <Row last={last}>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', font: '400 var(--fs-body)/1.2 var(--font-text)', color: 'var(--ink)' }}>{label}</span>
        {sub && <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>{sub}</span>}
      </span>
      <Switch on={on} onChange={toggle} />
    </Row>
  );
}

/* ───────────────────────── panes ───────────────────────── */
const EFFORT_TO_STOP: Record<string, EffortStop> = { fast: 'FAST', balanced: 'BALANCED', deep: 'DEEP', max: 'MAX' };
const STOP_TO_EFFORT: Record<EffortStop, 'fast' | 'balanced' | 'deep' | 'max'> = { FAST: 'fast', BALANCED: 'balanced', DEEP: 'deep', MAX: 'max' };

function GeneralPane({ theme, setTheme, workspace }: {
  theme: Theme; setTheme: React.Dispatch<React.SetStateAction<Theme>>;
  workspace: Workspace | null;
}) {
  const [settings, setSettings] = React.useState<AppSettings | null>(null);
  React.useEffect(() => { api.getSettings().then(setSettings).catch(() => {}); }, []);

  const eff: EffortStop = settings ? EFFORT_TO_STOP[settings.defaultEffort] ?? 'BALANCED' : 'BALANCED';
  const model = settings?.defaultEngine ?? 'auto';

  const patch = (p: Partial<AppSettings>) => { setSettings(s => (s ? { ...s, ...p } : s)); void api.setSettings(p).catch(() => {}); };
  const saveName = (name: string) => { const n = name.trim(); if (n && n !== workspace?.name) void api.createWorkspace(n).catch(() => {}); };

  return (
    <div>
      <PaneHead>General</PaneHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <GroupedList header="Workspace">
          <Row><span style={{ width: 110, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Name</span><input key={workspace?.id ?? 'ws'} defaultValue={workspace?.name ?? 'Maestro'} onBlur={e => saveName(e.target.value)} style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)', padding: '13px 0' }} /></Row>
          <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Appearance</span><Seg options={['Light', 'Dark', 'Auto']} value={getThemePref() === 'auto' ? 'Auto' : getThemePref() === 'dark' ? 'Dark' : 'Light'} onChange={v => setThemePref(v === 'Auto' ? 'auto' : v === 'Dark' ? 'dark' : 'light')} /></Row>
        </GroupedList>
        <GroupedList header="Defaults" footer="Applies to new jobs; a project or the composer can override per run.">
          <Row><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Default effort</span><EffortDial value={eff} onChange={v => patch({ defaultEffort: STOP_TO_EFFORT[v] })} compact /></Row>
          <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Default engine</span><ModelSwitcher value={model} onChange={v => patch({ defaultEngine: v === 'claude' || v === 'codex' ? v : 'auto' })} align="right" /></Row>
        </GroupedList>
        <GroupedList header="Startup">
          <ToggleRow label="Open Maestro at login" on={settings?.openAtLogin ?? false} onChange={v => patch({ openAtLogin: v })} last />
        </GroupedList>
      </div>
    </div>
  );
}

/* ── Engines pane — which engine plays which role ───────────────────── */
type RoleKey = 'master' | 'reviewer' | 'image' | 'video';
const ROLE_ROWS: { key: RoleKey; label: string; sub: string; offOption?: boolean }[] = [
  { key: 'master', label: 'Master agent', sub: 'Runs your jobs end-to-end.' },
  { key: 'reviewer', label: 'Reviewer', sub: 'Second pass appended to every result.', offOption: true },
  { key: 'image', label: 'Image generation', sub: 'Used by Media Studio (preview).' },
  { key: 'video', label: 'Video generation', sub: 'Used by Media Studio (preview).' },
];
const ENGINE_OPTIONS = ['Claude Code', 'Codex'] as const;
const labelToEngine = (l: string): 'claude' | 'codex' | 'off' => (l === 'Claude Code' ? 'claude' : l === 'Codex' ? 'codex' : 'off');
const engineToLabel = (e: string): string => (e === 'claude' ? 'Claude Code' : e === 'codex' ? 'Codex' : 'Off');

function EnginesPane() {
  const [routing, setRouting] = React.useState<Routing | null>(null);
  const [engines, setEngines] = React.useState<EngineStatuses | null>(null);

  const refetch = React.useCallback(() => {
    Promise.all([api.getRouting(), api.engineStatus()])
      .then(([r, e]) => { setRouting(r); setEngines(e); })
      .catch(() => {});
  }, []);
  React.useEffect(() => {
    refetch();
    // Engine status can change out-of-band (user runs `claude login` in a
    // terminal); re-check when jobs move and on a slow poll while the pane is open.
    const unsub = api.subscribe({ onJob: () => refetch() });
    const t = setInterval(refetch, 10000);
    return () => { unsub(); clearInterval(t); };
  }, [refetch]);

  const setRole = (key: RoleKey, label: string) => {
    const value = labelToEngine(label);
    setRouting(r => (r ? { ...r, [key]: value } as Routing : r));
    void api.setRouting({ [key]: value } as Partial<Routing>).then(setRouting).catch(() => {});
  };

  // ONE source of truth: the same status the run path uses, so the pane can
  // never disagree with what actually happens when a job runs.
  const ENGINE_STATUS_ROWS: { id: 'claude' | 'codex'; label: string }[] = [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
  ];

  return (
    <div>
      <PaneHead sub="Pick which engine plays each role. Both run locally on this Mac, on your own sign-ins.">Engines</PaneHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <GroupedList footer="Master + Reviewer are active today. Image & video routing applies to Media Studio when the pipeline ships.">
          {ROLE_ROWS.map((r, i) => (
            <Row key={r.key} last={i === ROLE_ROWS.length - 1}>
              <span style={{ flex: 1 }}>
                <span style={{ display: 'block', font: '400 var(--fs-body)/1.2 var(--font-text)', color: 'var(--ink)' }}>{r.label}</span>
                <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>{r.sub}</span>
              </span>
              {routing
                ? <Seg
                    options={r.offOption ? ['Off', ...ENGINE_OPTIONS] : [...ENGINE_OPTIONS]}
                    value={engineToLabel(routing[r.key])}
                    onChange={v => setRole(r.key, v)} />
                : <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>…</span>}
            </Row>
          ))}
        </GroupedList>
        <GroupedList header="Engine status" footer="Engines use your own sign-ins on this Mac — Claude Code (`claude login`) and Codex (ChatGPT).">
          {ENGINE_STATUS_ROWS.map((row, i) => {
            const s = engines?.[row.id];
            const ok = !!s?.available;
            return (
              <Row key={row.id} last={i === ENGINE_STATUS_ROWS.length - 1}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>{row.label}</span>
                  {s && !ok && s.reason
                    ? <span style={{ display: 'block', font: '400 var(--fs-caption)/1.35 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 3 }}>{s.reason}</span>
                    : ok && s ? <span style={{ display: 'block', font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 3 }}>{s.detail}</span> : null}
                </span>
                <span style={{ flexShrink: 0, font: '500 var(--fs-footnote)/1 var(--font-text)', color: !engines ? 'var(--ink-tertiary)' : ok ? 'var(--green)' : 'var(--red)' }}>
                  {!engines ? '…' : ok ? 'Ready' : 'Not signed in'}
                </span>
              </Row>
            );
          })}
        </GroupedList>
      </div>
    </div>
  );
}

const REAL_PROVIDERS: { id: ProviderId; name: string; tint: string; glyph: string; meta: string; hint: string }[] = [
  { id: 'anthropic', name: 'Anthropic', tint: '#D97757', glyph: 'A', meta: 'Claude · coding & reasoning', hint: 'sk-ant-…' },
  { id: 'openai', name: 'OpenAI', tint: 'var(--ink)', glyph: 'O', meta: 'GPT · media & vision', hint: 'sk-…' },
  { id: 'fal', name: 'fal.ai', tint: 'var(--purple)', glyph: 'f', meta: 'Media · image, video, voice', hint: 'key_id:key_secret' },
];
const OTHER_PROVIDERS = [
  { name: 'Replicate', tint: 'var(--teal)', glyph: 'R' },
  { name: 'ElevenLabs', tint: 'var(--indigo)', glyph: 'E' },
  { name: 'Google', tint: 'var(--blue)', glyph: 'G' },
];

function AccountsPane() {
  const [conns, setConns] = React.useState<ProviderConn[]>([]);
  const [keys, setKeys] = React.useState<Record<string, string>>({ anthropic: '', openai: '', fal: '' });
  const [errors, setErrors] = React.useState<Record<string, string>>({ anthropic: '', openai: '', fal: '' });
  const [busy, setBusy] = React.useState<Record<string, boolean>>({ anthropic: false, openai: false, fal: false });

  const refetch = React.useCallback(() => { api.listProviders().then(setConns).catch(() => {}); }, []);
  React.useEffect(() => { refetch(); }, [refetch]);

  const connOf = (id: ProviderId) => conns.find(c => c.provider === id);

  const connect = async (id: ProviderId) => {
    const key = (keys[id] || '').trim();
    if (!key) return;
    setBusy(b => ({ ...b, [id]: true })); setErrors(e => ({ ...e, [id]: '' }));
    try {
      await api.connectProvider(id, key);
      setKeys(k => ({ ...k, [id]: '' }));
      refetch();
    } catch (err) {
      setErrors(e => ({ ...e, [id]: err instanceof ApiError ? err.message : 'Connection failed' }));
    } finally {
      setBusy(b => ({ ...b, [id]: false }));
    }
  };
  const disconnect = async (id: ProviderId) => {
    setBusy(b => ({ ...b, [id]: true }));
    try { await api.disconnectProvider(id); refetch(); } catch { /* ignore */ } finally { setBusy(b => ({ ...b, [id]: false })); }
  };

  return (
    <div>
      <PaneHead sub="Agents use your keys; they never see them.">Accounts &amp; keys</PaneHead>
      <GroupedList footer="Connections live on this Mac: your Claude Code / Codex sign-ins are detected automatically, and any API key is validated live and stored in the Mac's Keychain. Nothing leaves this machine.">
        {REAL_PROVIDERS.map((p, i) => {
          const c = connOf(p.id);
          const connected = !!c;
          return (
            <Row key={p.id} last={i === REAL_PROVIDERS.length - 1}>
              <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${p.tint} 15%, transparent)`, color: p.tint, font: '800 var(--fs-callout)/1 var(--font-display)' }}>{p.glyph}</span>
              <span style={{ flexShrink: 0, width: 138, minWidth: 0 }}>
                <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{p.name}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: errors[p.id] ? 'var(--red)' : connected ? 'var(--green)' : 'var(--ink-secondary)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                  <Icon name="lock" size={11} /> {errors[p.id] ? errors[p.id] : connected ? `Connected · ${c?.detail ?? 'this Mac'}` : p.meta}
                </span>
              </span>
              {connected ? (
                <span style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                  {c?.method === 'subscription'
                    ? <span style={{ height: 32, display: 'inline-flex', alignItems: 'center', padding: '0 13px', borderRadius: 'var(--r-pill)', background: 'rgba(52,199,89,0.12)', color: 'var(--green)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Signed in</span>
                    : <button onClick={() => disconnect(p.id)} disabled={busy[p.id]} className="ghost-btn" style={{ height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>{busy[p.id] ? '…' : 'Disconnect'}</button>}
                </span>
              ) : (
                <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                  <input type="password" value={keys[p.id] || ''} placeholder={p.hint}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setKeys(k => ({ ...k, [p.id]: e.target.value }))}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') connect(p.id); }}
                    style={{ flex: 1, minWidth: 0, maxWidth: 184, height: 32, border: '0.5px solid var(--separator-strong)', borderRadius: 8, outline: 'none', background: 'var(--fill-tertiary)', font: '400 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', padding: '0 10px' }} />
                  <button onClick={() => connect(p.id)} disabled={busy[p.id] || !(keys[p.id] || '').trim()} style={{ height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', opacity: busy[p.id] || !(keys[p.id] || '').trim() ? 0.5 : 1 }}>{busy[p.id] ? '…' : 'Connect'}</button>
                </span>
              )}
            </Row>
          );
        })}
      </GroupedList>
      <div style={{ height: 18 }} />
      <GroupedList header="More providers" footer="Additional providers are on the roadmap.">
        {OTHER_PROVIDERS.map((p, i) => (
          <Row key={p.name} last={i === OTHER_PROVIDERS.length - 1}>
            <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${p.tint} 15%, transparent)`, color: p.tint, font: '800 var(--fs-callout)/1 var(--font-display)' }}>{p.glyph}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{p.name}</span>
              <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>Not connected</span>
            </span>
            <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Soon</span>
          </Row>
        ))}
      </GroupedList>
    </div>
  );
}

function SecurityPane({ onExportAudit }: { onExportAudit: () => void }) {
  return (
    <div>
      <PaneHead>Security</PaneHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <GroupedList header="Autonomy floor">
          <Row last>
            <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)' }}><Icon name="lock" size={18} /></span>
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Unattended is the maximum autonomy</span>
              <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.35 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Always inside allowlists and caps. There is no bypass mode.</span>
            </span>
          </Row>
        </GroupedList>
        <GroupedList footer="Untrusted content (web pages, messages, files) is treated as input, never instructions.">
          <ToggleRow label="Review untrusted input" sub="Scan tool outputs and inbound messages for injected instructions." on={true} last />
        </GroupedList>
        <GroupedList header="Skill trust">
          <Row><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Re-scan cadence</span><Seg options={['Daily', 'Weekly', 'On change']} value={'On change'} onChange={() => {}} /></Row>
          <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>On drift</span><span style={{ font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--orange)' }}>Quarantine until re-approved</span></Row>
        </GroupedList>
        <GroupedList header="Audit log">
          <Row><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Retention</span><Seg options={['90 days', '1 year', 'Forever']} value={'Forever'} onChange={() => {}} /></Row>
          <Row last onClick={onExportAudit}><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--blue)' }}>Export audit (JSONL)</span><Icon name="enter" size={16} style={{ color: 'var(--ink-tertiary)', transform: 'rotate(-90deg)' }} /></Row>
        </GroupedList>
      </div>
    </div>
  );
}

function DevicesPane({ onPair }: { onPair: () => void }) {
  const [pairing, setPairing] = React.useState<PairingInfo | null>(null);
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!IS_LOCAL) return;
    let alive = true;
    api.getPairing().then(p => { if (alive) setPairing(p); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const copy = () => {
    if (!pairing) return;
    void navigator.clipboard?.writeText(pairing.token).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); });
  };
  return (
    <div>
      <PaneHead>Devices</PaneHead>
      {pairing && (
        <>
          <GroupedList header="Pairing code" footer="Enter this code on your phone (Onboarding → Enter code) or open the web remote with ?token=<code>. Remotes can't reach this Mac without it.">
            <Row last>
              <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 13%, transparent)', color: 'var(--blue)' }}><Icon name="key" size={17} /></span>
              <span style={{ flex: 1, font: '600 var(--fs-headline)/1 var(--font-mono)', letterSpacing: '0.08em', color: 'var(--ink)' }}>{pairing.token}</span>
              <button onClick={copy} className="ghost-btn" style={{ height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', background: copied ? 'rgba(52,199,89,0.14)' : 'var(--fill-secondary)', color: copied ? 'var(--green)' : 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>{copied ? 'Copied ✓' : 'Copy'}</button>
            </Row>
          </GroupedList>
          <div style={{ height: 18 }} />
        </>
      )}
      <GroupedList footer="Anyone who enters your code can control this Mac, so keep it private. Regenerating the code (Danger zone → reset is not required) would unpair existing devices.">
        <Row>
          <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-tertiary)', color: 'var(--ink-tertiary)' }}><Icon name="smartphone" size={18} /></span>
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>No paired devices yet</span>
            <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Pair your phone with the code above to control this Mac remotely.</span>
          </span>
        </Row>
        <Row last onClick={onPair}>
          <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 13%, transparent)', color: 'var(--blue)' }}><Icon name="plus" size={18} stroke={2.4} /></span>
          <span style={{ flex: 1, font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--blue)' }}>Pair new device</span>
          <Icon name="chevronRight" size={16} style={{ color: 'var(--ink-tertiary)' }} />
        </Row>
      </GroupedList>
    </div>
  );
}

function PowerPane() {
  return (
    <div>
      <PaneHead>Power &amp; reliability</PaneHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <GroupedList footer="Jobs survive sleep anyway — they resume from checkpoint.">
          <ToggleRow label="Keep Mac awake while jobs run" on={false} last />
        </GroupedList>
        <GroupedList header="Checkpoints">
          <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Interval</span><Seg options={['30s', '2 min', '5 min']} value={'2 min'} onChange={() => {}} /></Row>
        </GroupedList>
        <GroupedList header="Relay" footer={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--green)' }} /> Connected · 38ms</span>}>
          <Row last><span style={{ width: 92, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Address</span><input defaultValue="relay.maestro.app:443" style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: '500 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)', padding: '13px 0' }} /></Row>
        </GroupedList>
      </div>
    </div>
  );
}

function UpdatesPane() {
  return (
    <div>
      <PaneHead>Updates</PaneHead>
      <GroupedList footer="Updates are signed and verified before install.">
        <Row><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Current version</span><span style={{ font: '500 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>3.4.1 (build 8821)</span></Row>
        <Row><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Channel</span><Seg options={['Stable', 'Beta']} value={'Stable'} onChange={() => {}} /></Row>
        <Row last><span style={{ flex: 1, display: 'inline-flex', alignItems: 'center', gap: 7, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--green)' }}><Icon name="check" size={14} stroke={2.6} /> Up to date</span><button className="ghost-btn" style={{ height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Check now</button></Row>
      </GroupedList>
    </div>
  );
}

function DangerPane({ onReset }: { onReset: () => void }) {
  return (
    <div>
      <PaneHead sub="Separated on purpose. These actions can't be undone.">Danger zone</PaneHead>
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 12, border: '1px solid rgba(255,59,48,0.3)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 16px' }}>
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Reset workspace</span>
            <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 3, maxWidth: 460 }}>Removes projects, transcripts, synced copies, and media. The audit log keeps a tombstone.</span>
          </span>
          <button onClick={onReset} style={{ height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--red)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 4px 14px rgba(255,59,48,0.3)' }}>Reset…</button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── reset confirm sheet ───────────────────────── */
function ResetSheet({ onClose }: { onClose: () => void }) {
  const [typed, setTyped] = React.useState('');
  const ok = typed.trim().toUpperCase() === 'RESET';
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32, background: 'rgba(10,12,24,0.4)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 420, background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', padding: 24, textAlign: 'center' }}>
        <span style={{ display: 'inline-grid', placeItems: 'center', width: 52, height: 52, borderRadius: '50%', background: 'rgba(255,59,48,0.14)', color: 'var(--red)', marginBottom: 15 }}><Icon name="alert" size={26} /></span>
        <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Reset this workspace?</h2>
        <p style={{ margin: '0 0 18px', font: '400 var(--fs-subhead)/1.45 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>This removes projects, transcripts, synced copies, and media. Type <b style={{ color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}>RESET</b> to confirm.</p>
        <input value={typed} onChange={e => setTyped(e.target.value)} autoFocus placeholder="RESET" style={{ width: '100%', height: 44, textAlign: 'center', border: '1.5px solid var(--separator-strong)', borderRadius: 12, outline: 'none', background: 'var(--fill-tertiary)', font: '600 var(--fs-headline)/1 var(--font-mono)', color: 'var(--ink)', marginBottom: 14 }} />
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={onClose} disabled={!ok} style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: ok ? 'var(--red)' : 'var(--fill-secondary)', color: ok ? '#fff' : 'var(--ink-tertiary)', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: ok ? '0 6px 18px rgba(255,59,48,0.32)' : 'none' }}>Reset workspace</button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── page root ───────────────────────── */
export default function Settings() {
  const scale = useAppScale();
  const [theme, setTheme] = useTheme('light');
  const navigate = useNavigate();
  const location = useLocation();
  // Deep-link into a section, e.g. the toolbar Costs chip → navigate('/settings',
  // { state: { section: 'costs' } }). Falls back to General.
  const initialSec = (location.state as { section?: string } | null)?.section;
  const [sec, setSec] = React.useState(initialSec && typeof initialSec === 'string' ? initialSec : 'general');
  const [reset, setReset] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  // Live workspace (first one) backing the name row. Fail-soft on error.
  const [workspace, setWorkspace] = React.useState<Workspace | null>(null);

  React.useEffect(() => {
    let alive = true;
    api.listWorkspaces().then(ws => { if (alive) setWorkspace(ws[0] ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Shared route registry resolves every sidebar key (incl. Workspace, and the
  // Comms/Costs destinations) — no duplicate map to drift out of sync.
  const navTo = (key: string) => navigate(pathForNav(key));

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const panes: Record<string, React.ReactNode> = {
    general: <GeneralPane theme={theme} setTheme={setTheme} workspace={workspace} />,
    engines: <EnginesPane />,
    accounts: <AccountsPane />,
    comms: <CommsPanel embedded />,
    costs: <BudgetPanel embedded />,
    security: <SecurityPane onExportAudit={() => navigate('/audit')} />,
    devices: <DevicesPane onPair={() => navigate('/device-pairing')} />,
    power: <PowerPane />,
    updates: <UpdatesPane />,
    danger: <DangerPane onReset={() => setReset(true)} />,
  };

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      <style>{styles}</style>
      <div style={{
        width: '100%', height: '100%', overflow: 'hidden', position: 'relative', background: 'var(--bg)',
        display: 'flex',
      }}>
        <div className="app-wallpaper" aria-hidden="true" />
        <TrafficLights />
        <Sidebar active="" onNav={navTo} onWorkspace={() => {}} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
          <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} />
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            {/* settings nav */}
            <aside style={{ width: 232, flexShrink: 0, borderRight: '0.5px solid var(--separator)', padding: '20px 12px', overflowY: 'auto', background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
              <div style={{ font: '700 var(--fs-title2)/1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)', padding: '0 10px 14px' }}>Settings</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {SET_NAV.map(n => {
                  const on = sec === n.key;
                  return (
                    <button key={n.key} onClick={() => setSec(n.key)} className={on ? '' : 'set-nav'} style={{ display: 'flex', alignItems: 'center', gap: 11, height: 38, padding: '0 10px', borderRadius: 8, textAlign: 'left',
                      background: on ? 'var(--blue)' : 'transparent', color: on ? '#fff' : 'var(--ink)', font: `${on ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`, transition: 'background 140ms ease' }}>
                      <span style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center', background: on ? 'rgba(255,255,255,0.2)' : `color-mix(in srgb, ${n.tint} 14%, transparent)`, color: on ? '#fff' : n.tint }}><Icon name={n.icon} size={15} /></span>
                      {n.label}
                    </button>
                  );
                })}
              </div>
            </aside>
            {/* pane */}
            <main style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 40px' }}>
              <div key={sec} className="pane-fade" style={{ maxWidth: WIDE_PANES.has(sec) ? 980 : 640 }}>{panes[sec]}</div>
            </main>
          </div>
        </div>
      </div>
      {reset && <ResetSheet onClose={() => setReset(false)} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
