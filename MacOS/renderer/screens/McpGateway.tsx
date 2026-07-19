/* MCP Gateway — installed MCP skills plus unavailable activity/denial states. */

import React from 'react';
import { AppShell } from '../lib/appShell';
import { Icon, type IconName } from '../lib/icons';
import { Switch } from '../lib/ui';
import { api, type Skill as ApiSkill } from '../lib/api';

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
interface SkillRow {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: string;
  version: string;
  enabled: boolean;
  createdAt: number;
  glyph: string;
  tint: string;
}

const SRV_TINTS = ['var(--ink)', 'var(--teal)', 'var(--orange)', 'var(--indigo)', 'var(--purple)', 'var(--blue)'];

function skillToRow(sk: ApiSkill, i: number): SkillRow {
  const slug = sk.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return {
    id: sk.id,
    name: sk.name,
    description: sk.description,
    category: sk.category,
    kind: sk.kind,
    version: sk.version,
    enabled: sk.enabled,
    createdAt: sk.createdAt,
    glyph: (slug.slice(0, 2) || 'mc'),
    tint: SRV_TINTS[i % SRV_TINTS.length],
  };
}

/* ───────────────────────── Installed skills tab ───────────────────────── */
function SkillGlyph({ s, size = 38 }: { s: SkillRow; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: 10, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${s.tint} 15%, transparent)`, color: s.tint, font: '700 var(--fs-footnote)/1 var(--font-mono)', textTransform: 'uppercase' }}>{s.glyph}</span>;
}

function SkillRowView({ s, last, onToggle }: { s: SkillRow; last: boolean; onToggle: (s: SkillRow) => void }) {
  const on = s.enabled;
  const installed = Number.isFinite(s.createdAt) && s.createdAt > 0 ? new Date(s.createdAt).toLocaleDateString() : null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderBottom: last ? 'none' : '0.5px solid var(--separator)', opacity: on ? 1 : 0.62, transition: 'opacity 220ms ease' }}>
      <SkillGlyph s={s} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)' }}>{s.name}</span>
          <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: on ? 'color-mix(in srgb, var(--green) 14%, transparent)' : 'var(--fill-secondary)', font: '600 var(--fs-caption)/18px var(--font-text)', color: on ? 'var(--green)' : 'var(--ink-secondary)' }}>{on ? 'Enabled' : 'Disabled'}</span>
        </div>
        {s.description && (
          <div style={{ marginBottom: 7, font: '400 var(--fs-footnote)/1.35 var(--font-text)', color: 'var(--ink-secondary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {s.description}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
          {s.category && <span style={{ padding: '3px 7px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)' }}>{s.category}</span>}
          {s.kind && <span style={{ padding: '3px 7px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', fontFamily: 'var(--font-mono)' }}>{s.kind}</span>}
          {s.version && <span style={{ padding: '3px 7px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', fontFamily: 'var(--font-mono)' }}>v{s.version}</span>}
          {installed && <span style={{ color: 'var(--ink-tertiary)' }}>Added {installed}</span>}
        </div>
      </div>
      <span style={{ width: 1, height: 28, background: 'var(--separator)' }} />
      <Switch on={on} onChange={() => onToggle(s)} />
    </div>
  );
}

function InstalledSkillsTab({ skills, onToggle }: { skills: SkillRow[]; onToggle: (s: SkillRow) => void }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: '12px 12px 0 0', background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', borderBottom: 'none', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>
        <Icon name="lock" size={13} style={{ color: 'var(--ink-tertiary)' }} /> Installed MCP skills are listed from the local skills registry.
      </div>
      <div style={{ background: 'var(--bg-elevated)', borderRadius: '0 0 12px 12px', border: '0.5px solid var(--separator)', overflow: 'hidden', boxShadow: 'var(--card-shadow)' }}>
        {skills.length === 0 ? (
          <div style={{ padding: '34px 16px', textAlign: 'center', font: '400 var(--fs-callout)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>No installed MCP skills.</div>
        ) : skills.map((s, i) => <SkillRowView key={s.id} s={s} last={i === skills.length - 1} onToggle={onToggle} />)}
      </div>
    </div>
  );
}

/* ───────────────────────── Live activity ───────────────────────── */
function LiveActivity() {
  return (
    <div>
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden', boxShadow: 'var(--card-shadow)' }}>
        <div style={{ padding: '34px 16px', textAlign: 'center', font: '400 var(--fs-callout)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>No MCP activity is available.</div>
      </div>
    </div>
  );
}

/* ───────────────────────── Denials tab ───────────────────────── */
function DenialsTab() {
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden', boxShadow: 'var(--card-shadow)' }}>
      <div style={{ padding: '34px 16px', textAlign: 'center', font: '400 var(--fs-callout)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>No MCP denials are available.</div>
    </div>
  );
}

/* ───────────────────────── ⌘K command palette ───────────────────────── */
interface PaletteItem { group: string; icon: IconName; label: string; hint: string; }

const PALETTE_ITEMS: PaletteItem[] = [
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

/* ───────────────────────── page root ───────────────────────── */
interface McpTab { key: string; label: string; icon: IconName; }
const MCP_TABS: McpTab[] = [
  { key: 'skills', label: 'Installed', icon: 'cpu' },
  { key: 'activity', label: 'Live activity', icon: 'bolt' },
  { key: 'denials', label: 'Denials', icon: 'lock' },
];

export default function McpGateway() {
  const [tab, setTab] = React.useState('skills');
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [skills, setSkills] = React.useState<SkillRow[]>([]);
  const ti = MCP_TABS.findIndex(t => t.key === tab);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await api.listSkills();
        if (alive) setSkills(list.filter(sk => sk.kind === 'mcp').map(skillToRow));
      } catch {
        if (alive) setSkills([]);
      }
    })();
    return () => { alive = false; };
  }, []);

  const onToggleSkill = async (s: SkillRow) => {
    try {
      const updated = await api.toggleSkill(s.id);
      setSkills(prev => prev.map(p => (p.id === updated.id ? { ...p, enabled: updated.enabled } : p)));
    } catch { /* fail soft — keep current state */ }
  };

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  return (
    <AppShell
      active="skills"
      onSearch={() => setPaletteOpen(true)}
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
          <Icon name="shield" size={14} style={{ color: 'var(--green)' }} /> Installed MCP skills
        </div>

        <div key={tab} className="tab-fade">
          {tab === 'skills' && <InstalledSkillsTab skills={skills} onToggle={onToggleSkill} />}
          {tab === 'activity' && <LiveActivity />}
          {tab === 'denials' && <DenialsTab />}
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
