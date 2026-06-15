/* Audit Log & Run History — full-window assembly. Scaled macOS window with
   frosted sidebar + toolbar, a Runs/Audit segmented control, a read-only
   replay overlay, the forensic audit table, and the ⌘K command palette.
   Ported to ES-module TypeScript React — visual output unchanged. */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '../lib/icons';
import {
  APP_W, APP_H, useAppScale, useTheme, TrafficLights, Sidebar, Toolbar, type Theme,
} from '../lib/appShell';
import { api, type Job, type Project } from '../lib/api';

/* ───────────────────────── page-specific CSS (from Audit History.html <style>) ───────────────────────── */
const styles = `
  @keyframes spin { to { transform: rotate(360deg); } }
  .app-wallpaper { position: absolute; inset: 0; z-index: 0; pointer-events: none;
    background: radial-gradient(60% 50% at 16% 0%, color-mix(in srgb, var(--blob-a) 26%, transparent), transparent 70%), radial-gradient(55% 50% at 100% 100%, color-mix(in srgb, var(--blob-b) 20%, transparent), transparent 70%), var(--bg); }
  .nav-item:hover { background: var(--fill-tertiary); color: var(--ink); }
  .ws-header:hover { background: var(--fill-tertiary); }
  .search-field:hover { background: var(--fill-secondary); }
  .tb-icon:hover { background: var(--fill-secondary); color: var(--ink); }
  .link-btn:hover { text-decoration: underline; }
  .ghost-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  .run-row:hover, .audit-row:hover { background: var(--fill-tertiary); }
  .chain:hover { filter: brightness(1.1); }
  .repl-num { animation: countUp 300ms var(--spring); }
  @keyframes countUp { from { transform: translateY(-3px); } to { transform: none; } }
  .tab-fade { animation: tfade 240ms var(--spring); }
  @keyframes tfade { from { transform: translateY(6px); } to { transform: none; } }
  .sheet-pop { animation: sheetPop 220ms var(--spring); }
  @keyframes sheetPop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
  input[type="range"].ios-slider { -webkit-appearance: none; appearance: none; outline: none; }
  input[type="range"].ios-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.28); cursor: pointer; }
  *::-webkit-scrollbar { width: 11px; height: 11px; }
  *::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--ink) 22%, transparent); border-radius: 999px; border: 3px solid transparent; background-clip: padding-box; }
  ::selection { background: rgba(0,122,255,0.22); }
`;

/* ───────────────────────── ShapeChip (from pd-jobs) ───────────────────────── */
const SHAPES: Record<string, { label: string; tint: string }> = {
  single:   { label: 'Single',            tint: 'var(--ink-secondary)' },
  pbr:      { label: 'Plan→Build→Review', tint: 'var(--blue)' },
  fanout:   { label: 'Fan-out',           tint: 'var(--purple)' },
  pipeline: { label: 'Pipeline',          tint: 'var(--teal)' },
};

function ShapeChip({ shape }: { shape: string }) {
  const s = SHAPES[shape] || SHAPES.single;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)',
      background: `color-mix(in srgb, ${s.tint} 13%, transparent)`, color: s.tint,
      font: '600 var(--fs-caption)/1 var(--font-text)', whiteSpace: 'nowrap', flexShrink: 0 }}>
      <span style={{ width: 5, height: 5, borderRadius: 3, background: s.tint }} />{s.label}
    </span>
  );
}

/* ───────────────────────── ⌘K command palette (from cc-palette) ───────────────────────── */
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

/* ───────────────────────── data ───────────────────────── */
interface RunItem { proj: string; tint: string; name: string; out: keyof typeof OUT; shape: string; engine: string; cost: string; dur: string; time: string; }
const ENGINE_SHORT: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
interface RunGroup { day: string; items: RunItem[]; }

const OUT = { done: { icon: 'checkCircle', tint: 'var(--green)' }, failed: { icon: 'xCircle', tint: 'var(--red)' }, cancelled: { icon: 'pause', tint: 'var(--ink-tertiary)' } } as const;

/* ── live-API → run-history adapters ──
   The run list is a read-only audit/history view of the job log. Each api Job is
   mapped onto the existing RunItem shape: status → outcome icon, effort → shape
   chip, projectId → project name/color, cost through, and time/duration derived
   from createdAt/updatedAt. Rows are grouped by the day of updatedAt. */
const SHAPE_BY_EFFORT: Record<string, string> = { fast: 'single', balanced: 'fanout', deep: 'pbr', max: 'pipeline' };

function outFromStatus(s: Job['status']): keyof typeof OUT {
  if (s === 'done') return 'done';
  if (s === 'failed') return 'failed';
  // pending / running are not terminal outcomes — surface with the neutral marker
  return 'cancelled';
}

function pad2(n: number): string { return n < 10 ? '0' + n : String(n); }

function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/* m:ss elapsed from createdAt→updatedAt (clamped to ≥0). */
function durOf(start: number, end: number): string {
  const secs = Math.max(0, Math.round((end - start) / 1000));
  return `${Math.floor(secs / 60)}:${pad2(secs % 60)}`;
}

function dayKeyOf(ms: number): string {
  const d = new Date(ms); d.setHours(0, 0, 0, 0);
  return String(d.getTime());
}

function dayLabelOf(ms: number): string {
  const d = new Date(ms); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

/* Build the grouped, day-sorted run history from live jobs + projects. */
function buildRuns(jobs: Job[], projects: Project[]): RunGroup[] {
  const byId = new Map(projects.map(p => [p.id, p]));
  const sorted = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = new Map<string, { ms: number; label: string; items: RunItem[] }>();
  for (const j of sorted) {
    const proj = byId.get(j.projectId);
    const key = dayKeyOf(j.updatedAt);
    let g = groups.get(key);
    if (!g) { g = { ms: Number(key), label: dayLabelOf(j.updatedAt), items: [] }; groups.set(key, g); }
    g.items.push({
      proj: proj?.name ?? 'Unassigned',
      tint: proj?.color ? `var(--${proj.color})` : 'var(--ink-secondary)',
      name: j.title,
      out: outFromStatus(j.status),
      shape: SHAPE_BY_EFFORT[j.effort] ?? 'single',
      engine: ENGINE_SHORT[j.engine ?? 'claude'] ?? (j.engine ?? ''),
      cost: j.cost.toFixed(2),
      dur: durOf(j.createdAt, j.updatedAt),
      time: clockOf(j.updatedAt),
    });
  }
  return [...groups.values()].sort((a, b) => b.ms - a.ms).map(g => ({ day: g.label, items: g.items }));
}

function RunsTab({ runs, onOpen }: { runs: RunGroup[]; onOpen: (run: RunItem) => void }) {
  const [q, setQ] = React.useState('');
  const term = q.trim().toLowerCase();
  // Live filter over the run history: project, job title, or outcome.
  const shown = runs
    .map(g => ({
      day: g.day,
      items: term === '' ? g.items : g.items.filter(r =>
        r.proj.toLowerCase().includes(term) || r.name.toLowerCase().includes(term) || r.out.toLowerCase().includes(term)),
    }))
    .filter(g => g.items.length > 0);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, height: 44, padding: '0 14px', borderRadius: 12, background: 'var(--bg-grouped)', border: '0.5px solid var(--separator)', marginBottom: 18, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', maxWidth: 420 }}>
        <Icon name="search" size={17} style={{ color: 'var(--ink-tertiary)' }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search runs by project, job, or outcome"
          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-tertiary)' }} />
      </div>
      {shown.length === 0 && (
        <div style={{ padding: '48px 0', textAlign: 'center', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>No runs yet</div>
      )}
      {shown.map(g => (
        <div key={g.day} style={{ marginBottom: 20 }}>
          <div style={{ position: 'sticky', top: 0, zIndex: 2, padding: '6px 2px', background: 'color-mix(in srgb, var(--bg) 86%, transparent)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
            <span style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>{g.day}</span>
          </div>
          <div style={{ background: 'var(--bg-grouped)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden', marginTop: 8, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
            {g.items.map((r, i) => (
              <div key={i} onClick={() => onOpen(r)} className="run-row" style={{ display: 'grid', gridTemplateColumns: '24px 1.3fr 1.6fr 1.2fr 0.7fr 0.7fr 56px', gap: 14, alignItems: 'center', padding: '13px 16px', borderBottom: i < g.items.length - 1 ? '0.5px solid var(--separator)' : 'none', cursor: 'pointer' }}>
                <Icon name={OUT[r.out].icon} size={17} style={{ color: OUT[r.out].tint }} />
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}><span style={{ width: 8, height: 8, borderRadius: 4, background: r.tint, flexShrink: 0 }} /><span style={{ font: '500 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.proj}</span></span>
                <span style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
                <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <ShapeChip shape={r.shape} />
                  {r.engine && <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{r.engine}</span>}
                </span>
                <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', textAlign: 'right' }}>${r.cost}</span>
                <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', textAlign: 'right' }}>{r.dur}</span>
                <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', textAlign: 'right' }}>{r.time}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ReplayOverlay({ run, onClose }: { run: RunItem; onClose: () => void }) {
  const navigate = useNavigate();
  const [t, setT] = React.useState(60);
  const phases = [{ n: 'Plan', e: 12 }, { n: 'Build', e: 64 }, { n: 'Review', e: 86 }, { n: 'Gate', e: 100 }];
  const active = phases.findIndex((p, i) => t <= p.e && (i === 0 || t > phases[i - 1].e));
  const cost = (parseFloat(run.cost) * t / 100).toFixed(2);
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 36, background: 'rgba(10,12,24,0.4)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 760, maxHeight: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '0.5px solid var(--separator)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}><span style={{ width: 8, height: 8, borderRadius: 4, background: run.tint }} /> {run.proj}</span>
          <span style={{ font: '700 var(--fs-title2)/1.1 var(--font-display)', color: 'var(--ink)', flex: 1 }}>{run.name}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>Read-only replay</span>
          <button onClick={onClose} className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="x" size={18} /></button>
        </div>
        {/* scrubber */}
        <div style={{ padding: '16px 20px', borderBottom: '0.5px solid var(--separator)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="tb-icon" style={{ width: 34, height: 34, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--blue)', color: '#fff' }}><Icon name="play" size={15} /></button>
            <input type="range" min={0} max={100} value={t} onChange={e => setT(+e.target.value)} className="ios-slider scrub" style={{ flex: 1, height: 28, WebkitAppearance: 'none', appearance: 'none', background: `linear-gradient(var(--blue),var(--blue)) 0/${t}% 100% no-repeat var(--fill-secondary)`, borderRadius: 'var(--r-pill)', cursor: 'pointer' }} />
            <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', width: 42 }}>{Math.round(t / 100 * 372)}s</span>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', minHeight: 280 }}>
          {/* step outline syncs */}
          <div style={{ borderRight: '0.5px solid var(--separator)', padding: 18 }}>
            <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 14 }}>Timeline</div>
            {phases.map((p, i) => {
              const done = t > p.e, cur = i === active;
              return (
                <div key={i} style={{ display: 'flex', gap: 11, paddingBottom: 16, position: 'relative' }}>
                  {i < phases.length - 1 && <span style={{ position: 'absolute', left: 9, top: 20, bottom: -2, width: 2, background: done ? 'var(--green)' : 'var(--separator)' }} />}
                  <span style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', zIndex: 1, background: done ? 'var(--green)' : cur ? 'var(--blue)' : 'var(--fill-secondary)', color: '#fff', boxShadow: cur ? '0 0 0 4px color-mix(in srgb, var(--blue) 16%, transparent)' : 'none' }}>{done && <Icon name="check" size={11} stroke={3} />}</span>
                  <span style={{ font: `${cur ? 700 : 500} var(--fs-callout)/1.1 var(--font-text)`, color: done || cur ? 'var(--ink)' : 'var(--ink-tertiary)' }}>{p.n}</span>
                </div>
              );
            })}
          </div>
          {/* synced meter + note */}
          <div style={{ padding: 20 }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
              <div style={{ flex: 1, background: 'var(--fill-tertiary)', borderRadius: 10, padding: '12px 14px' }}><div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 5 }}>Spend so far</div><div className="repl-num" style={{ font: '600 var(--fs-title2)/1 var(--font-mono)', color: 'var(--ink)' }}>${cost}</div></div>
              <div style={{ flex: 1, background: 'var(--fill-tertiary)', borderRadius: 10, padding: '12px 14px' }}><div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 5 }}>Phase</div><div style={{ font: '600 var(--fs-title2)/1 var(--font-text)', color: 'var(--ink)' }}>{phases[Math.max(0, active)].n}</div></div>
            </div>
            <div style={{ font: '400 var(--fs-footnote)/1.6 var(--font-mono)', color: 'var(--ink-secondary)', padding: '12px 14px', background: 'var(--fill-tertiary)', borderRadius: 10 }}>
              <span style={{ color: 'var(--purple)' }}>›</span> {['scanning repo for session reads…', 'patching call sites in routes/', 'running typecheck — 0 errors', 'awaiting your review at the gate'][Math.max(0, active)]}
            </div>
            <a onClick={() => navigate('/session-transcript')} className="link-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 14, font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)', textDecoration: 'none', cursor: 'pointer' }}><Icon name="terminal" size={14} /> Open full transcript</a>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Audit
interface AuditRow { seq: number; time: string; actor: keyof typeof ACTOR; icon: IconName; text: string | null; redacted?: boolean; }

const AUDIT: AuditRow[] = [
  { seq: 41209, time: '14:08:22', actor: 'job', icon: 'gitMerge', text: 'Gate approved from iPhone — merge PR #482' },
  { seq: 41208, time: '14:08:20', actor: 'operator', icon: 'check', text: 'Operator approved merge gate' },
  { seq: 41207, time: '14:02:11', actor: 'job', icon: 'key', text: 'Key used: Anthropic (build pass)' },
  { seq: 41206, time: '13:40:55', actor: 'job', icon: 'send', text: 'Published video to YouTube · 1 unit' },
  { seq: 41205, time: '13:39:02', actor: 'system', icon: 'shield', text: 'Skill quarantined: figma-export — description drift' },
  { seq: 41204, time: '13:12:40', actor: 'operator', icon: 'gauge', text: 'Raised Market Scan cap $30 → $40' },
  { seq: 41203, time: '12:55:18', actor: 'system', icon: 'lock', text: null, redacted: true },
  { seq: 41202, time: '11:40:09', actor: 'job', icon: 'play', text: 'Job started: Draft launch thread' },
  { seq: 41201, time: '09:30:44', actor: 'job', icon: 'alert', text: 'Job stopped: Competitor digest hit $30 cap' },
];
const ACTOR = { job: { label: 'Job', tint: 'var(--purple)' }, operator: { label: 'Operator', tint: 'var(--blue)' }, system: { label: 'System', tint: 'var(--ink-secondary)' } } as const;

function AuditTab({ broken }: { broken: boolean }) {
  return (
    <div>
      {/* integrity banner */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderRadius: 12, marginBottom: 16,
        background: broken ? 'rgba(255,59,48,0.1)' : 'rgba(52,199,89,0.1)', border: `1px solid ${broken ? 'rgba(255,59,48,0.4)' : 'rgba(52,199,89,0.3)'}` }}>
        <Icon name={broken ? 'alert' : 'shield'} size={17} style={{ color: broken ? 'var(--red)' : 'var(--green)' }} />
        <span style={{ font: `${broken ? 700 : 600} var(--fs-subhead)/1.3 var(--font-text)`, color: broken ? 'var(--red)' : 'var(--ink)' }}>
          {broken ? 'Chain broken at #31,002 — entries after this point may have been altered' : 'Hash chain verified · 41,209 entries intact'}
        </span>
      </div>
      {/* filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        {['All', 'Tool calls', 'Sends', 'Gates', 'Keys', 'Config'].map((f, i) => (
          <button key={f} style={{ height: 30, padding: '0 12px', borderRadius: 'var(--r-pill)', font: '600 var(--fs-footnote)/1 var(--font-text)', background: i === 0 ? 'var(--blue)' : 'var(--fill-secondary)', color: i === 0 ? '#fff' : 'var(--ink-secondary)' }}>{f}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="ghost-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}><Icon name="calendar" size={14} /> Jun 17</button>
        <button className="ghost-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}><Icon name="enter" size={13} style={{ transform: 'rotate(-90deg)' }} /> Export</button>
      </div>
      {/* table */}
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden', boxShadow: 'var(--card-shadow)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '70px 90px 100px 1fr 40px', gap: 14, padding: '10px 16px', borderBottom: '0.5px solid var(--separator)', background: 'var(--fill-tertiary)' }}>
          {['Seq', 'Time', 'Actor', 'Event', ''].map((h, i) => <span key={i} style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{h}</span>)}
        </div>
        {AUDIT.map((r, i) => (
          <div key={r.seq} className="audit-row" style={{ display: 'grid', gridTemplateColumns: '70px 90px 100px 1fr 40px', gap: 14, alignItems: 'center', padding: '11px 16px', borderBottom: i < AUDIT.length - 1 ? '0.5px solid var(--separator)' : 'none',
            background: r.redacted ? 'var(--fill-tertiary)' : 'transparent' }}>
            <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>#{r.seq}</span>
            <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>{r.time}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)', background: `color-mix(in srgb, ${ACTOR[r.actor].tint} 13%, transparent)`, color: ACTOR[r.actor].tint, font: '600 var(--fs-caption)/1 var(--font-text)', justifySelf: 'start' }}>{ACTOR[r.actor].label}</span>
            {r.redacted
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-tertiary)', fontStyle: 'italic' }}><Icon name="lock" size={13} /> Content redacted (consent withdrawn) · event preserved</span>
              : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, minWidth: 0 }}><Icon name={r.icon} size={15} style={{ color: 'var(--ink-tertiary)', flexShrink: 0 }} /><span style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.text}</span></span>}
            <span title="Hash-chained" className="chain" style={{ justifySelf: 'center', color: r.redacted ? 'var(--ink-tertiary)' : 'var(--green)' }}><Icon name="gitMerge" size={14} /></span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── page root ───────────────────────── */
const AU_TABS: { key: 'runs' | 'audit'; label: string; icon: IconName }[] = [
  { key: 'runs', label: 'Runs', icon: 'play' },
  { key: 'audit', label: 'Audit', icon: 'shield' },
];

export default function AuditHistory() {
  const navigate = useNavigate();
  const scale = useAppScale();
  const [theme, setTheme] = useTheme('light');
  const [tab, setTab] = React.useState<'runs' | 'audit'>('runs');
  const [replay, setReplay] = React.useState<RunItem | null>(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [runs, setRuns] = React.useState<RunGroup[]>([]);
  const ti = AU_TABS.findIndex(t => t.key === tab);

  // live load: jobs → run/audit history, projects → name + color. Re-runnable.
  const refetch = React.useCallback(async () => {
    try {
      const [apiJobs, apiProjects] = await Promise.all([api.listJobs(), api.listProjects()]);
      setRuns(buildRuns(apiJobs, apiProjects));
    } catch {
      /* fail soft — keep whatever we already have */
    }
  }, []);

  React.useEffect(() => { void refetch(); }, [refetch]);

  // LIVE: SSE job updates → refetch the history
  React.useEffect(() => api.subscribe({ onJob: () => { void refetch(); } }), [refetch]);

  // shared cross-page nav routing
  const navTo = (k: string) => {
    const map: Record<string, string> = {
      projects: '/projects',
      trends: '/trends',
      studio: '/media-studio',
      publishing: '/publishing',
    };
    if (map[k]) navigate(map[k]);
  };

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

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
          <Toolbar theme={theme as Theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} />
          <main style={{ flex: 1, overflowY: 'auto', padding: '24px 28px 36px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 22 }}>
              <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>History</h1>
              <span style={{ flex: 1 }} />
              <div style={{ position: 'relative', display: 'inline-flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 11 }}>
                <div style={{ position: 'absolute', top: 3, bottom: 3, left: `calc(${ti} * 104px + 3px)`, width: 104, background: 'var(--bg-elevated)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 280ms var(--spring)' }} />
                {AU_TABS.map(t => <button key={t.key} onClick={() => setTab(t.key)} style={{ position: 'relative', zIndex: 1, width: 104, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 0', font: `${tab === t.key ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`, color: tab === t.key ? 'var(--ink)' : 'var(--ink-secondary)' }}><Icon name={t.icon} size={15} /> {t.label}</button>)}
              </div>
            </div>
            <div key={tab} className="tab-fade">
              {tab === 'runs' ? <RunsTab runs={runs} onOpen={setReplay} /> : <AuditTab broken={false} />}
            </div>
          </main>
        </div>
        {replay && <ReplayOverlay run={replay} onClose={() => setReplay(null)} />}
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </div>
    </div>
  );
}
