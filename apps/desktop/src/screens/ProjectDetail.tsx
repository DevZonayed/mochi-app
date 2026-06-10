/* Project Detail — ported from the design prototype
   (design/project/project-detail/*.jsx + command-center/{cc-zones,cc-palette}.jsx).
   Header, sticky tab bar, tab router (Overview / Jobs / Instructions / Skills &
   tools / Budget / Settings), command palette, and gate-arrives micro-interaction.
   Visual output (inline styles, classNames, var(--…), SVG, animation classes)
   preserved exactly. Cross-page navigation uses react-router. */

import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon, type IconName } from '../lib/icons';
import {
  GroupedList,
  Row,
  Switch,
  Spinner,
  EffortDial,
  EFFORT_EST,
  type EffortStop,
} from '../lib/ui';
import { AppShell, WORKSPACE } from '../lib/appShell';
import { api, type Project, type Job, type Effort } from '../lib/api';

/* ───────────────── page-specific CSS (from Project Detail.html <style>) ───────────────── */
const PAGE_CSS = `
  @keyframes spin { to { transform: rotate(360deg); } }

  .app-wallpaper {
    position: absolute; inset: 0; z-index: 0; pointer-events: none;
    background:
      radial-gradient(60% 50% at 16% 0%, color-mix(in srgb, var(--blob-a) 30%, transparent), transparent 70%),
      radial-gradient(55% 50% at 100% 100%, color-mix(in srgb, var(--blob-b) 26%, transparent), transparent 70%),
      var(--bg);
  }

  .nav-item:hover { background: var(--fill-tertiary); color: var(--ink); }
  .ws-header:hover { background: var(--fill-tertiary); }
  .search-field:hover { background: var(--fill-secondary); }
  .tb-icon:hover { background: var(--fill-secondary); color: var(--ink); }
  .crumb:hover { color: var(--blue) !important; }
  .link-btn:hover { text-decoration: underline; }
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .split-quiet:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 6%); }
  .step-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 55%, var(--ink) 8%); }
  .send-btn:not(:disabled):hover { transform: scale(1.06); }
  .send-btn:not(:disabled):active { transform: scale(0.95); }

  .breathe { animation: breathe 1.8s ease-in-out infinite; }
  @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

  .sub-card, .recent-row, .filter-chip { transition: background 120ms ease, transform 140ms var(--spring), box-shadow 140ms ease, border-color 140ms ease; }
  .sub-card:hover { transform: translateY(-2px); box-shadow: var(--card-shadow), 0 8px 22px rgba(15,20,60,0.12); border-color: var(--separator-strong); }
  .recent-row:hover { background: var(--fill-tertiary); }
  .filter-chip:hover { filter: brightness(0.97); }

  /* estimate count + cost chip — frozen-clock-safe (no opacity-0 starts) */
  .estimate { animation: estPulse 360ms var(--spring); }
  @keyframes estPulse { 0% { transform: translateY(-2px); } 100% { transform: none; } }
  .cost-chip { animation: chipIn 320ms var(--spring); }
  @keyframes chipIn { 0% { transform: scale(0.9); } 60% { transform: scale(1.04); } 100% { transform: scale(1); } }

  /* gate banner arrival */
  .gate-banner { animation: gateSlide 360ms var(--spring); }
  @keyframes gateSlide { 0% { transform: translateY(-10px); } 100% { transform: none; } }

  /* palette — frozen-clock-safe */
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }

  main::-webkit-scrollbar { width: 9px; }
  main::-webkit-scrollbar-thumb { background: var(--fill-secondary); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
  textarea::placeholder { color: var(--ink-tertiary); }
  ::selection { background: rgba(0,122,255,0.22); }
`;

/* ───────────────── shared atom: ZoneLabel (from cc-zones.jsx) ───────────────── */
function ZoneLabel({ icon, tint, children }: { icon: IconName; tint: string; children?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 11 }}>
      <Icon name={icon} size={15} style={{ color: tint }} />
      <span style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>{children}</span>
    </div>
  );
}

/* ───────────────── command palette (from cc-palette.jsx) ───────────────── */
interface PaletteItem {
  group: string;
  icon: IconName;
  label: string;
  hint: string;
}

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
  const groups = filtered.reduce<Record<string, PaletteItem[]>>((acc, it) => { (acc[it.group] = acc[it.group] || []).push(it); return acc; }, {});
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

/* ───────────────── shared job atoms (from pd-jobs.jsx) ───────────────── */
type JobStatus = 'running' | 'gated' | 'scheduled' | 'done' | 'failed';

const TRIGGER_ICON: Record<string, IconName> = { hand: 'play', clock: 'clock', chat: 'command', webhook: 'bolt' };
const TRIGGER_LABEL: Record<string, string> = { hand: 'Manual', clock: 'Scheduled', chat: 'From chat', webhook: 'Webhook' };

function JobStatusIcon({ status }: { status: JobStatus }) {
  const map: Record<JobStatus, { tint: string; node: React.ReactNode }> = {
    running:   { tint: 'var(--purple)', node: <Spinner size={13} color="var(--purple)" /> },
    gated:     { tint: 'var(--orange)', node: <Icon name="enter" size={15} /> },
    scheduled: { tint: 'var(--teal)',   node: <Icon name="clock" size={15} /> },
    done:      { tint: 'var(--green)',  node: <Icon name="check" size={14} stroke={2.6} /> },
    failed:    { tint: 'var(--red)',    node: <Icon name="x" size={14} stroke={2.6} /> },
  };
  const s = map[status] || map.done;
  return (
    <span style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center',
      background: `color-mix(in srgb, ${s.tint} 15%, transparent)`, color: s.tint }}>{s.node}</span>
  );
}

const SHAPES: Record<string, { label: string; tint: string }> = {
  single:   { label: 'Single',      tint: 'var(--ink-secondary)' },
  pbr:      { label: 'Plan→Build→Review', tint: 'var(--blue)' },
  fanout:   { label: 'Fan-out',     tint: 'var(--purple)' },
  pipeline: { label: 'Pipeline',    tint: 'var(--teal)' },
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

interface ProjectJob {
  id: string;
  trigger: string;
  name: string;
  shape: string;
  status: JobStatus;
  cost: string;
  started: string;
  duration: string;
}

/* ── live-data adapters: map api.Job → the ProjectJob shape the render expects ── */
const EFFORT_TO_API: Record<EffortStop, Effort> = { FAST: 'fast', BALANCED: 'balanced', DEEP: 'deep', MAX: 'max' };

const API_STATUS_TO_LOCAL: Record<Job['status'], JobStatus> = {
  pending: 'scheduled',
  running: 'running',
  done: 'done',
  failed: 'failed',
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return day === 1 ? 'Yesterday' : `${day} days ago`;
}

function jobDuration(j: Job): string {
  const totalSec = Math.max(0, Math.floor((j.updatedAt - j.createdAt) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function toProjectJob(j: Job): ProjectJob {
  return {
    id: j.id,
    trigger: 'hand',
    name: j.title || j.input || 'Untitled job',
    shape: 'single',
    status: API_STATUS_TO_LOCAL[j.status],
    cost: j.cost > 0 ? j.cost.toFixed(2) : '—',
    started: relativeTime(j.createdAt),
    duration: j.status === 'pending' ? '—' : jobDuration(j),
  };
}

const JOB_FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'gated', label: 'Gated' },
  { key: 'failed', label: 'Failed' },
];

function JobsTab({ jobs }: { jobs: ProjectJob[] }) {
  const [filter, setFilter] = React.useState('all');
  const rows = jobs.filter(j => filter === 'all' || j.status === filter);
  const count = (k: string) => k === 'all' ? jobs.length : jobs.filter(j => j.status === k).length;

  return (
    <div>
      {/* filter chips */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {JOB_FILTERS.map(f => {
          const on = filter === f.key;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)} className="filter-chip" style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)',
              background: on ? 'var(--blue)' : 'var(--fill-secondary)', color: on ? '#fff' : 'var(--ink-secondary)',
              font: '600 var(--fs-subhead)/1 var(--font-text)', transition: 'background 140ms ease, color 140ms ease',
            }}>
              {f.label}
              <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 'var(--r-pill)',
                background: on ? 'rgba(255,255,255,0.25)' : 'var(--fill-secondary)', color: on ? '#fff' : 'var(--ink-tertiary)',
                font: '700 var(--fs-caption)/18px var(--font-mono)', textAlign: 'center' }}>{count(f.key)}</span>
            </button>
          );
        })}
      </div>

      {/* table */}
      <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '24px 2fr 1.3fr 1fr 0.8fr 1fr 0.8fr', alignItems: 'center', gap: 14,
          padding: '11px 18px', borderBottom: '0.5px solid var(--separator)', background: 'var(--fill-tertiary)' }}>
          {['', 'Job', 'Shape', 'Status', 'Cost', 'Started', 'Duration'].map((h, i) => (
            <span key={i} style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)',
              textAlign: i >= 4 ? 'right' : 'left' }}>{h}</span>
          ))}
        </div>
        {rows.map((j, i) => (
          <div key={j.id} className="recent-row" style={{ display: 'grid', gridTemplateColumns: '24px 2fr 1.3fr 1fr 0.8fr 1fr 0.8fr', alignItems: 'center', gap: 14,
            padding: '12px 18px', borderBottom: i < rows.length - 1 ? '0.5px solid var(--separator)' : 'none', cursor: 'pointer' }}>
            <span title={TRIGGER_LABEL[j.trigger]} style={{ color: 'var(--ink-tertiary)', display: 'grid', placeItems: 'center' }}>
              <Icon name={TRIGGER_ICON[j.trigger]} size={15} />
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <JobStatusIcon status={j.status} />
              <span style={{ font: '500 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.name}</span>
            </span>
            <span><ShapeChip shape={j.shape} /></span>
            <span style={{ font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: j.status === 'failed' ? 'var(--red)' : j.status === 'gated' ? 'var(--orange)' : 'var(--ink-secondary)', textTransform: 'capitalize' }}>{j.status}</span>
            <span style={{ textAlign: 'right', font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>{j.cost === '—' ? '—' : '$' + j.cost}</span>
            <span style={{ textAlign: 'right', font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{j.started}</span>
            <span style={{ textAlign: 'right', font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{j.duration}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────── Overview tab (from pd-overview.jsx) ───────────────── */
interface AutonomyMode { key: string; label: string; hint: string }
const AUTONOMY: AutonomyMode[] = [
  { key: 'plan',   label: 'Plan first', hint: 'Agent proposes a plan; you approve before it runs.' },
  { key: 'gated',  label: 'Gated',      hint: 'Runs freely but stops at merge / publish / spend gates.' },
  { key: 'unatt',  label: 'Unattended', hint: 'Runs end-to-end. Only hard guardrails can stop it.' },
];

function GoalComposer({ projectId, onRun }: { projectId: string | null; onRun: () => void }) {
  const [goal, setGoal] = React.useState('');
  const [effort, setEffort] = React.useState<EffortStop>('BALANCED');
  const [autonomy, setAutonomy] = React.useState('gated');
  const [running, setRunning] = React.useState(false);
  const est = EFFORT_EST[effort];
  const ai = AUTONOMY.findIndex(a => a.key === autonomy);

  const run = async () => {
    const text = goal.trim();
    if (!text || !projectId || running) return;
    setRunning(true);
    try {
      await api.createAndRunJob({ projectId, input: text || 'New job', effort: EFFORT_TO_API[effort] });
      setGoal('');
      onRun();
    } catch {
      /* fail soft */
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="composer" style={{
      background: 'var(--bg-elevated)', borderRadius: 20, border: '0.5px solid var(--separator)',
      boxShadow: 'var(--card-shadow)', padding: 20,
    }}>
      {/* text surface */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <textarea
          value={goal} onChange={e => setGoal(e.target.value)} rows={2}
          placeholder="Hand this project a goal…"
          style={{
            flex: 1, border: 'none', outline: 'none', background: 'transparent', resize: 'none',
            font: '400 var(--fs-title2)/1.4 var(--font-text)', color: 'var(--ink)', letterSpacing: '-0.01em',
            minHeight: 62, paddingTop: 4,
          }} />
        <button className="send-btn" onClick={run} disabled={!goal.trim() || running} style={{
          width: 44, height: 44, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center',
          background: goal.trim() ? 'var(--blue)' : 'var(--fill-secondary)',
          color: goal.trim() ? '#fff' : 'var(--ink-tertiary)',
          boxShadow: goal.trim() ? '0 6px 16px rgba(0,122,255,0.34)' : 'none',
          transition: 'all 180ms var(--spring)', marginTop: 6,
        }}>
          <Icon name="arrowRight" size={20} stroke={2.4} style={{ transform: 'rotate(-90deg)' }} />
        </button>
      </div>

      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 16, paddingTop: 16, borderTop: '0.5px solid var(--separator)', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Effort</span>
          <EffortDial value={effort} onChange={setEffort} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Autonomy</span>
          <div style={{ position: 'relative', display: 'inline-flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 9 }}>
            <div style={{ position: 'absolute', top: 2, bottom: 2, left: `calc(${ai * 33.333}% + 2px)`, width: `calc(33.333% - 4px)`,
              background: 'var(--bg-elevated)', borderRadius: 7, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 280ms var(--spring)' }} />
            {AUTONOMY.map(a => (
              <button key={a.key} onClick={() => setAutonomy(a.key)} title={a.hint} style={{
                position: 'relative', zIndex: 1, padding: '6px 13px', font: '700 11px/1 var(--font-text)', letterSpacing: '0.03em',
                color: autonomy === a.key ? 'var(--ink)' : 'var(--ink-secondary)', cursor: 'pointer', whiteSpace: 'nowrap',
              }}>{a.label}</button>
            ))}
          </div>
        </div>

        <span style={{ flex: 1 }} />

        {/* live estimate */}
        <div style={{ textAlign: 'right' }}>
          <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 5 }}>Pre-run estimate</div>
          <div key={effort} className="estimate" style={{ font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)' }}>
            ≈ ${est.cost} <span style={{ color: 'var(--ink-tertiary)' }}>·</span> ~{est.mins} min <span style={{ color: 'var(--ink-tertiary)', fontWeight: 400 }}>at {effort}</span>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12, font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>
        {AUTONOMY[ai].hint}
      </div>
    </div>
  );
}

interface SubProject { id: string; name: string; branch: string; tint: string; spent: number; cap: number; jobs: number }
const SUBPROJECTS: SubProject[] = [
  { id: 's1', name: 'Auth service', branch: 'auth-refactor', tint: 'var(--blue)', spent: 8.20, cap: 20, jobs: 1 },
  { id: 's2', name: 'Rate limiter', branch: 'ratelimit',     tint: 'var(--purple)', spent: 2.10, cap: 15, jobs: 1 },
  { id: 's3', name: 'API docs',     branch: 'docs-site',     tint: 'var(--teal)', spent: 4.60, cap: 10, jobs: 0 },
  { id: 's4', name: 'CI pipeline',  branch: 'ci-hardening',  tint: 'var(--indigo)', spent: 3.50, cap: 12, jobs: 0 },
];

function SubProjects() {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <ZoneLabel icon="gitMerge" tint="var(--blue)">Sub-projects · {SUBPROJECTS.length}</ZoneLabel>
        <span style={{ flex: 1 }} />
        <button className="link-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)' }}>
          <Icon name="plus" size={14} stroke={2.4} /> New branch
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(208px, 1fr))', gap: 12 }}>
        {SUBPROJECTS.map(s => {
          const pct = Math.min(100, (s.spent / s.cap) * 100);
          return (
            <div key={s.id} className="sub-card" style={{
              background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)',
              boxShadow: 'var(--card-shadow)', padding: 14, cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: s.tint, flexShrink: 0 }} />
                <span style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                {s.jobs > 0 && <span className="breathe" style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--purple)' }} />}
              </div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', marginBottom: 12 }}>
                <Icon name="gitMerge" size={12} /> {s.branch}
              </div>
              <div style={{ height: 4, borderRadius: 2, background: 'var(--fill-secondary)', overflow: 'hidden', marginBottom: 6 }}>
                <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: s.tint }} />
              </div>
              <div style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>
                <b style={{ color: 'var(--ink)', fontWeight: 600 }}>${s.spent.toFixed(2)}</b> / ${s.cap}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RecentJobs({ jobs }: { jobs: ProjectJob[] }) {
  return (
    <div>
      <ZoneLabel icon="jobs" tint="var(--purple)">Recent jobs</ZoneLabel>
      <div style={{ background: 'var(--bg-grouped)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
        {jobs.map((j, i) => (
          <div key={j.id} className="recent-row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
            borderBottom: i < jobs.length - 1 ? '0.5px solid var(--separator)' : 'none', cursor: 'pointer' }}>
            <JobStatusIcon status={j.status} />
            <span style={{ flex: 1, minWidth: 0, font: '500 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.name}</span>
            <ShapeChip shape={j.shape} />
            <span style={{ width: 56, textAlign: 'right', font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>${j.cost}</span>
            <span style={{ width: 52, textAlign: 'right', font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{j.duration}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────── Instructions tab (from pd-tabs.jsx) ───────────────── */
const INSTRUCTION_DOC = `You maintain the Atlas API — a TypeScript service on Fastify + Postgres.

Architecture
Keep handlers thin. Business logic lives in services/, data access in repositories/. Never import a repository directly from a route.

Style
Match the existing code. Prefer composition over inheritance. No new dependencies without noting why in the PR description.

Testing
Every behavioral change ships with a test. Run the suite before opening a PR; a red suite never reaches review.

Pull requests
One concern per PR. Write a plain-language summary a reviewer can skim in 30 seconds. Link the issue.`;

const RESOLVED: { origin: string; tint: string; text: string }[] = [
  { origin: 'Workspace', tint: 'var(--indigo)', text: 'Write plainly. No emoji in code, comments, or PRs. Cite sources for any external claim.' },
  { origin: 'Project', tint: 'var(--blue)', text: 'Maintain the Atlas API — TypeScript, Fastify, Postgres. Thin handlers; logic in services/.' },
  { origin: 'Sub-project', tint: 'var(--purple)', text: 'auth-refactor: migrating sessions to short-lived JWTs. Keep the legacy cookie path until v2 ships.' },
];

const GUARDRAILS: { text: string; origin: string }[] = [
  { text: 'Never publish or deploy without a gate', origin: 'Workspace rule' },
  { text: 'Hard budget cap — stop at $50, no exceptions', origin: 'Project rule' },
  { text: 'Never force-push to main', origin: 'Workspace rule' },
];

function InstructionsTab() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 360px', gap: 20, alignItems: 'start' }}>
      {/* editor */}
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '0.5px solid var(--separator)' }}>
          <Icon name="terminal" size={16} style={{ color: 'var(--ink-secondary)' }} />
          <span style={{ font: '600 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink)' }}>instructions.md</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 20, padding: '0 8px', borderRadius: 'var(--r-pill)',
            background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>v7</span>
          <span style={{ flex: 1 }} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--green)' }}>
            <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--green)' }} /> Saved
          </span>
        </div>
        <textarea defaultValue={INSTRUCTION_DOC} spellCheck={false} style={{
          width: '100%', maxWidth: 680, display: 'block', margin: '0 auto', border: 'none', outline: 'none', background: 'transparent', resize: 'none',
          font: '400 var(--fs-body)/1.7 var(--font-text)', color: 'var(--ink)', padding: '24px 28px', minHeight: 520, boxSizing: 'border-box',
        }} />
      </div>

      {/* resolved rail */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', padding: 16,
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
          <div style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 4 }}>Resolved view</div>
          <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 14 }}>What the agent actually sees, concatenated in order.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {RESOLVED.map((r, i) => (
              <div key={i} style={{ position: 'relative', paddingLeft: 14 }}>
                <span style={{ position: 'absolute', left: 0, top: 4, bottom: 4, width: 3, borderRadius: 2, background: r.tint }} />
                <div style={{ font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: r.tint, marginBottom: 5 }}>{r.origin}</div>
                <div style={{ font: '400 var(--fs-footnote)/1.45 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty' }}>{r.text}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', padding: 16,
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
            <Icon name="lock" size={14} style={{ color: 'var(--ink-secondary)' }} />
            <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Hard guardrails</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {GUARDRAILS.map((g, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 10,
                background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)' }}>
                <Icon name="lock" size={14} style={{ color: 'var(--ink-tertiary)', flexShrink: 0, marginTop: 1 }} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', font: '500 var(--fs-footnote)/1.35 var(--font-text)', color: 'var(--ink)' }}>{g.text}</span>
                  <span style={{ display: 'block', font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 3 }}>{g.origin}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────── Skills & tools tab (from pd-tabs.jsx) ───────────────── */
interface SkillDef { name: string; ver: string; on: boolean }
const SKILLS: SkillDef[] = [
  { name: 'TypeScript engineer', ver: '2.4.0', on: true },
  { name: 'PR author', ver: '1.8.1', on: true },
  { name: 'Test writer', ver: '3.0.2', on: true },
  { name: 'Postgres migrator', ver: '1.2.0', on: false },
];
interface McpDef { name: string; scope: string; tint: string; on: boolean }
const MCP: McpDef[] = [
  { name: 'GitHub', scope: 'read-write · 12 tools', tint: 'var(--ink)', on: true },
  { name: 'Postgres (prod)', scope: 'read-only · 3 tools', tint: 'var(--teal)', on: true },
  { name: 'Linear', scope: 'read-only · 5 tools', tint: 'var(--indigo)', on: true },
  { name: 'Sentry', scope: 'read-only · 4 tools', tint: 'var(--orange)', on: false },
];

function SkillRow({ s, last }: { s: SkillDef; last?: boolean }) {
  const [on, setOn] = React.useState(s.on);
  return (
    <Row last={last}>
      <span style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
        background: 'var(--fill-tertiary)', color: 'var(--blue)', border: '0.5px solid var(--separator)' }}>
        <Icon name="spark" size={18} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{s.name}</span>
          <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)',
            font: '600 var(--fs-caption)/18px var(--font-mono)', color: 'var(--ink-secondary)' }}>v{s.ver}</span>
          <span title="Signature verified" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--green)',
            font: '600 var(--fs-caption)/1 var(--font-text)' }}><Icon name="shield" size={13} /></span>
        </span>
      </span>
      <Switch on={on} onChange={setOn} />
    </Row>
  );
}

function McpRow({ m, last }: { m: McpDef; last?: boolean }) {
  const [on, setOn] = React.useState(m.on);
  return (
    <Row last={last}>
      <span style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
        background: `color-mix(in srgb, ${m.tint} 13%, transparent)`, color: m.tint, border: '0.5px solid var(--separator)' }}>
        <Icon name="cpu" size={18} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{m.name}</span>
        <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.2 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 2 }}>{m.scope}</span>
      </span>
      <Switch on={on} onChange={setOn} />
    </Row>
  );
}

function SkillsTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 720 }}>
      <GroupedList header="Starter skills">
        {SKILLS.map((s, i) => <SkillRow key={s.name} s={s} last={i === SKILLS.length - 1} />)}
      </GroupedList>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 12, marginBottom: 12,
          background: 'rgba(255,149,0,0.10)', border: '0.5px solid rgba(255,149,0,0.3)' }}>
          <Icon name="shield" size={18} style={{ color: 'var(--orange)', flexShrink: 0 }} />
          <span style={{ font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink)' }}>
            <b style={{ fontWeight: 600 }}>Deny by default.</b> Agents can only reach the MCP servers you enable here, with the scopes shown.
          </span>
        </div>
        <GroupedList header="Allowed MCP servers" footer={
          <button className="link-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)' }}>
            <Icon name="plus" size={14} stroke={2.4} /> Add from registry
          </button>}>
          {MCP.map((m, i) => <McpRow key={m.name} m={m} last={i === MCP.length - 1} />)}
        </GroupedList>
      </div>
    </div>
  );
}

/* ───────────────── Budget tab (from pd-tabs.jsx) ───────────────── */
interface BudgetBar { name: string; cost: number; tint: string }
const BUDGET_BARS: BudgetBar[] = [
  { name: 'Refactor auth service', cost: 8.40, tint: 'var(--purple)' },
  { name: 'Nightly test suite', cost: 6.10, tint: 'var(--teal)' },
  { name: 'Dependency audit', cost: 4.20, tint: 'var(--blue)' },
  { name: 'OG image generation', cost: 2.90, tint: 'var(--indigo)' },
  { name: 'Misc / chat', cost: 1.30, tint: 'var(--ink-tertiary)' },
];

function BudgetTab() {
  const [cap, setCap] = React.useState(50);
  const spent = 22.90;
  const ring = 2 * Math.PI * 52;
  const frac = Math.min(1, spent / cap);
  const maxBar = Math.max(...BUDGET_BARS.map(b => b.cost));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '300px minmax(0,1fr)', gap: 20, alignItems: 'start' }}>
      {/* gauge card */}
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)',
        padding: 22, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', alignSelf: 'flex-start' }}>This month</div>
        <svg width="180" height="180" viewBox="0 0 128 128" style={{ transform: 'rotate(-90deg)', margin: '14px 0 6px' }}>
          <circle cx="64" cy="64" r="52" fill="none" stroke="var(--fill-secondary)" strokeWidth="11" />
          <circle cx="64" cy="64" r="52" fill="none" stroke={frac >= 0.9 ? 'var(--red)' : frac >= 0.75 ? 'var(--orange)' : 'var(--green)'} strokeWidth="11" strokeLinecap="round"
            strokeDasharray={ring} strokeDashoffset={ring * (1 - frac)} />
        </svg>
        <div style={{ font: '600 var(--fs-title1)/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>${spent.toFixed(2)}</div>
        <div style={{ font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 4 }}>of ${cap}.00 cap · {Math.round(frac * 100)}%</div>

        {/* hard cap stepper */}
        <div style={{ width: '100%', marginTop: 20, paddingTop: 18, borderTop: '0.5px solid var(--separator)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
            <Icon name="lock" size={14} style={{ color: 'var(--red)' }} />
            <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>Hard cap</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 4, borderRadius: 12, border: '1.5px solid var(--red)',
            background: 'rgba(255,59,48,0.05)' }}>
            <button onClick={() => setCap(c => Math.max(10, c - 5))} className="step-btn" style={{ width: 38, height: 38, borderRadius: 9, display: 'grid', placeItems: 'center',
              background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 20px/1 var(--font-text)' }}>−</button>
            <span style={{ flex: 1, textAlign: 'center', font: '600 var(--fs-title2)/1 var(--font-mono)', color: 'var(--ink)' }}>${cap}</span>
            <button onClick={() => setCap(c => Math.min(500, c + 5))} className="step-btn" style={{ width: 38, height: 38, borderRadius: 9, display: 'grid', placeItems: 'center',
              background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 20px/1 var(--font-text)' }}>+</button>
          </div>
          <div style={{ font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 9 }}>
            Jobs stop the moment spend would cross this line. Raising it asks for confirmation.
          </div>
        </div>
      </div>

      {/* per-job bars */}
      <div style={{ background: 'var(--bg-grouped)', borderRadius: 18, border: '0.5px solid var(--separator)', padding: 20,
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
        <div style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 18 }}>Spend by job</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {BUDGET_BARS.map((b, i) => (
            <div key={i}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 7 }}>
                <span style={{ flex: 1, font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink)' }}>{b.name}</span>
                <span style={{ font: '600 var(--fs-subhead)/1 var(--font-mono)', color: 'var(--ink)' }}>${b.cost.toFixed(2)}</span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: 'var(--fill-secondary)', overflow: 'hidden' }}>
                <div style={{ width: `${(b.cost / maxBar) * 100}%`, height: '100%', borderRadius: 4, background: b.tint }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────────────── Settings tab (from pd-tabs.jsx) ───────────────── */
function SettingsTab() {
  return (
    <div style={{ maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 22 }}>
      <GroupedList header="Project">
        <Row><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Name</span>
          <span style={{ font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>Atlas API</span></Row>
        <Row><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Template</span>
          <span style={{ font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>Code</span></Row>
        <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Default branch</span>
          <span style={{ font: '400 var(--fs-body)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>main</span></Row>
      </GroupedList>
      <GroupedList header="Danger zone" footer="Archiving stops all jobs and hides the project. You can restore it within 30 days.">
        <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--red)' }}>Archive project</span>
          <Icon name="chevronRight" size={16} style={{ color: 'var(--ink-tertiary)' }} /></Row>
      </GroupedList>
    </div>
  );
}

/* ───────────────── page assembly (from pd-app.jsx) ───────────────── */
const TABS: { key: string; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'instructions', label: 'Instructions' },
  { key: 'skills', label: 'Skills & tools' },
  { key: 'budget', label: 'Budget' },
  { key: 'settings', label: 'Settings' },
];

function Breadcrumb({ name }: { name: string }) {
  const navigate = useNavigate();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10, font: '500 var(--fs-subhead)/1 var(--font-text)' }}>
      <a onClick={() => navigate('/projects')} className="crumb" style={{ color: 'var(--ink-secondary)', textDecoration: 'none', cursor: 'pointer' }}>{WORKSPACE}</a>
      <Icon name="chevronRight" size={14} style={{ color: 'var(--ink-tertiary)' }} />
      <a onClick={() => navigate('/projects')} className="crumb" style={{ color: 'var(--ink-secondary)', textDecoration: 'none', cursor: 'pointer' }}>Projects</a>
      <Icon name="chevronRight" size={14} style={{ color: 'var(--ink-tertiary)' }} />
      <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{name}</span>
    </div>
  );
}

function GateBanner({ gate, onApprove, onDismiss }: { gate: boolean; onApprove: () => void; onDismiss: () => void }) {
  if (!gate) return null;
  return (
    <div className="gate-banner" style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', marginBottom: 20,
      background: 'var(--bg-elevated)', borderRadius: 14, border: '1px solid rgba(255,149,0,0.4)',
      boxShadow: '0 0 0 4px rgba(255,149,0,0.12), var(--card-shadow)',
    }}>
      <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
        background: 'rgba(255,149,0,0.15)', color: 'var(--orange)' }}>
        <Icon name="enter" size={19} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', font: '600 var(--fs-callout)/1.25 var(--font-text)', color: 'var(--ink)' }}>A job is waiting at a gate</span>
        <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 2 }}>Merge PR #482 — auth refactor · 12 files · +840 −210</span>
      </span>
      <button onClick={onDismiss} style={{ height: 34, padding: '0 14px', borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Review</button>
      <button onClick={onApprove} className="primary-cta" style={{ height: 34, padding: '0 16px', borderRadius: 8, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Approve &amp; merge</button>
    </div>
  );
}

export default function ProjectDetail() {
  const { id: routeId } = useParams<{ id: string }>();
  const [tab, setTab] = React.useState('overview');
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [gate, setGate] = React.useState(false);

  // live data
  const [projectId, setProjectId] = React.useState<string | null>(routeId ?? null);
  const [project, setProject] = React.useState<Project | null>(null);
  const [jobs, setJobs] = React.useState<Job[]>([]);

  // Resolve the project id: route param wins, else first project in the workspace.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (routeId) { if (!cancelled) setProjectId(routeId); return; }
      try {
        const projects = await api.listProjects();
        if (!cancelled && projects[0]) setProjectId(projects[0].id);
      } catch { /* fail soft */ }
    })();
    return () => { cancelled = true; };
  }, [routeId]);

  const refetchJobs = React.useCallback(async () => {
    if (!projectId) return;
    try {
      const next = await api.listJobs(projectId);
      setJobs(next);
    } catch { /* fail soft */ }
  }, [projectId]);

  // Load project header + jobs when the id resolves.
  React.useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const [p, js] = await Promise.all([api.getProject(projectId), api.listJobs(projectId)]);
        if (cancelled) return;
        setProject(p);
        setJobs(js);
      } catch { /* fail soft — render empty */ }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  // LIVE: refetch this project's jobs on any job update.
  React.useEffect(() => {
    if (!projectId) return;
    const unsub = api.subscribe({ onJob: () => { void refetchJobs(); } });
    return unsub;
  }, [projectId, refetchJobs]);

  // ⌘K + g
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
      if (e.key === 'g' && !e.metaKey && !e.ctrlKey && document.activeElement?.tagName !== 'TEXTAREA') { setGate(true); setTab('overview'); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const tabIdx = TABS.findIndex(t => t.key === tab);

  const projectJobs = jobs.map(toProjectJob);
  const projectName = project?.name ?? 'Project';
  const projectColor = project?.color ? `var(--${project.color})` : 'var(--blue)';
  const runningCount = jobs.filter(j => j.status === 'running').length;

  return (
    <AppShell active="projects" onSearch={() => setPaletteOpen(true)} budget={{ spent: 22.90, cap: 50, animateKey: 0 }}>
      <style>{PAGE_CSS}</style>

      {/* header block */}
      <div style={{ padding: '24px 28px 0' }}>
        <Breadcrumb name={projectName} />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <span style={{ width: 52, height: 52, borderRadius: 15, flexShrink: 0, display: 'grid', placeItems: 'center',
            background: `color-mix(in srgb, ${projectColor} 15%, transparent)`, color: projectColor }}>
            <Icon name="terminal" size={28} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>{projectName}</h1>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 11px', borderRadius: 'var(--r-pill)',
                background: 'rgba(52,199,89,0.16)', color: 'var(--green)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
                <span className="breathe" style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--green)' }} /> Active · {runningCount} running
              </span>
            </div>
            <div style={{ font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 7 }}>Code · 4 sub-projects · TypeScript, Fastify, Postgres</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <button className="split-quiet" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 15px', borderRadius: 'var(--r-pill)',
              background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>
              <Icon name="layers" size={16} /> Run from template
            </button>
            <button onClick={() => setPaletteOpen(true)} className="primary-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 18px', borderRadius: 'var(--r-pill)',
              background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.30)' }}>
              <Icon name="plus" size={16} stroke={2.4} /> New job
            </button>
          </div>
        </div>
      </div>

      {/* sticky tab bar */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, padding: '14px 28px 12px', marginTop: 18,
        background: 'color-mix(in srgb, var(--bg) 86%, transparent)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '0.5px solid var(--separator)' }}>
        <div style={{ position: 'relative', display: 'inline-flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 11 }}>
          <div className="tab-pill" style={{ position: 'absolute', top: 3, bottom: 3, left: `${tabIdx * 116 + 3}px`, width: 116,
            background: 'var(--bg-elevated)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 280ms var(--spring)' }} />
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              position: 'relative', zIndex: 1, width: 116, padding: '8px 0', textAlign: 'center',
              font: `${tab === t.key ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`,
              color: tab === t.key ? 'var(--ink)' : 'var(--ink-secondary)', transition: 'color 160ms ease',
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* tab content */}
      <div style={{ padding: '22px 28px 36px' }}>
        {tab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
            <GateBanner gate={gate} onApprove={() => setGate(false)} onDismiss={() => setGate(false)} />
            <GoalComposer projectId={projectId} onRun={() => { void refetchJobs(); }} />
            <SubProjects />
            <RecentJobs jobs={projectJobs.slice(0, 5)} />
          </div>
        )}
        {tab === 'jobs' && <JobsTab jobs={projectJobs} />}
        {tab === 'instructions' && <InstructionsTab />}
        {tab === 'skills' && <SkillsTab />}
        {tab === 'budget' && <BudgetTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
