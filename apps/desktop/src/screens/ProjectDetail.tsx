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
  ModelSwitcher,
  ProviderGlyph,
  type EffortStop,
} from '../lib/ui';
import { AppShell, useWorkspaceName } from '../lib/appShell';
import { api, IS_LOCAL, type Project, type Job, type Effort, type RepoInfo, type ChatSession, type EngineId } from '../lib/api';

const KIND_LABEL: Record<string, string> = { coding: 'Code', content: 'Content', research: 'Research', general: 'Project' };
function shortHomePath(p: string): string {
  const m = p.match(/^\/Users\/[^/]+\/(.*)$/);
  return m ? `~/${m[1]}` : p;
}

/* ───────────────── page-specific CSS (from Project Detail.html <style>) ───────────────── */
const PAGE_CSS = `
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes caretBlink { 50% { opacity: 0; } }
  .chat-caret { animation: caretBlink 1s steps(2) infinite; }
  .sess-row:hover { background: var(--fill-tertiary); }
  .sess-row .sess-x { opacity: 0; transition: opacity 120ms ease; }
  .sess-row:hover .sess-x { opacity: 1; }
  .sess-x:hover { color: var(--red); }

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
  cancelled: 'failed',
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
  const [engine, setEngine] = React.useState('auto');
  const [autonomy, setAutonomy] = React.useState('gated');
  const [running, setRunning] = React.useState(false);
  const est = EFFORT_EST[effort];
  const ai = AUTONOMY.findIndex(a => a.key === autonomy);

  const run = async () => {
    const text = goal.trim();
    if (!text || !projectId || running) return;
    setRunning(true);
    try {
      await api.createAndRunJob({
        projectId, input: text || 'New job', effort: EFFORT_TO_API[effort],
        ...(engine === 'claude' || engine === 'codex' ? { engine } : {}),
      });
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
          <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Engine</span>
          <ModelSwitcher value={engine} onChange={setEngine} compact />
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

        {/* effort guide — runs on your subscription, so no per-run dollar estimate */}
        <div style={{ textAlign: 'right' }}>
          <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 5 }}>Depth</div>
          <div key={effort} className="estimate" style={{ font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)' }}>
            ~{est.mins} min <span style={{ color: 'var(--ink-tertiary)', fontWeight: 400 }}>at {effort}</span>
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

function InstructionsTab({ projectId, project, onSaved }: { projectId: string | null; project: Project | null; onSaved: (instructions: string) => void }) {
  const [text, setText] = React.useState(project?.instructions ?? '');
  const [state, setState] = React.useState<'idle' | 'saving' | 'saved'>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = React.useRef(project?.instructions ?? '');

  // Re-seed when the project loads/changes.
  React.useEffect(() => {
    setText(project?.instructions ?? '');
    lastSaved.current = project?.instructions ?? '';
    setState('idle');
  }, [project?.id]);

  // Debounced persistence: 700ms after the last keystroke, save via updateProject.
  const onChange = (v: string) => {
    setText(v);
    if (!projectId) return;
    setState('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (v === lastSaved.current) { setState('saved'); return; }
      try {
        await api.updateProject(projectId, { instructions: v });
        lastSaved.current = v;
        setState('saved');
        onSaved(v);
      } catch { setState('idle'); }
    }, 700);
  };
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // The exact prompt the engine builds (engine.ts): instructions, a separator,
  // then the goal you type for each job.
  const resolvedPreview = (text.trim() ? `${text.trim()}\n\n---\n\n` : '') + '<your goal for the job>';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 360px', gap: 20, alignItems: 'start' }}>
      {/* editor */}
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '0.5px solid var(--separator)' }}>
          <Icon name="terminal" size={16} style={{ color: 'var(--ink-secondary)' }} />
          <span style={{ font: '600 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink)' }}>instructions.md</span>
          <span style={{ flex: 1 }} />
          {state === 'saving'
            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}><Spinner size={11} /> Saving…</span>
            : state === 'saved'
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--green)' }}><span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--green)' }} /> Saved</span>
              : <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Auto-saves</span>}
        </div>
        <textarea value={text} onChange={e => onChange(e.target.value)} spellCheck={false}
          placeholder="Standing instructions for this project — the agent reads these before every job. e.g. the stack, conventions, what to never touch, how to open PRs…"
          style={{
            width: '100%', maxWidth: 680, display: 'block', margin: '0 auto', border: 'none', outline: 'none', background: 'transparent', resize: 'none',
            font: '400 var(--fs-body)/1.7 var(--font-text)', color: 'var(--ink)', padding: '24px 28px', minHeight: 520, boxSizing: 'border-box',
          }} />
      </div>

      {/* resolved rail — honest: exactly what the engine concatenates */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', padding: 16,
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
          <div style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 4 }}>Resolved view</div>
          <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 14 }}>What the agent actually sees, in order, on every run.</div>
          <pre style={{ margin: 0, font: '400 var(--fs-caption)/1.55 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{resolvedPreview}</pre>
        </div>

        {project?.path && (
          <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', padding: 16,
            backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
              <Icon name={project.repoUrl ? 'gitMerge' : 'folder'} size={14} style={{ color: 'var(--ink-secondary)' }} />
              <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Workspace folder</span>
            </div>
            <div style={{ font: '400 var(--fs-footnote)/1.5 var(--font-mono)', color: 'var(--ink)', wordBreak: 'break-all' }}>{project.path}</div>
            <div style={{ font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 8 }}>Jobs in this project run inside this folder on your Mac.</div>
          </div>
        )}
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
/* ───────────────── Chat tab — converse with the agent like a chat app ─────────────────
   Each turn is a real Job (sessionId set): the engine streams partial output into
   job.output, so replies render live. Sessions are first-class: rail on the left,
   thread + composer on the right. Claude turns resume their SDK session (full
   context); codex turns carry stitched history. */

const CHAT_PROSE: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word' };
const CHAT_CODE: React.CSSProperties = {
  margin: '6px 0', padding: '10px 12px', borderRadius: 10, background: 'var(--fill-tertiary)',
  border: '0.5px solid var(--separator)', overflowX: 'auto', font: '400 var(--fs-caption)/1.55 var(--font-mono)', color: 'var(--ink)',
};

/** Light chat-body renderer: ``` fenced blocks become code cards, the rest stays prose. */
function renderChatBody(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const fence = /```[a-zA-Z0-9_+-]*\n?/g;
  let idx = 0, inCode = false, key = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    const chunk = text.slice(idx, m.index);
    if (chunk.trim()) out.push(inCode
      ? <pre key={key++} style={CHAT_CODE}>{chunk.replace(/\n$/, '')}</pre>
      : <span key={key++} style={CHAT_PROSE}>{chunk}</span>);
    inCode = !inCode;
    idx = m.index + m[0].length;
  }
  const tail = text.slice(idx);
  if (tail.trim()) out.push(inCode
    ? <pre key={key++} style={CHAT_CODE}>{tail.replace(/\n$/, '')}</pre>
    : <span key={key++} style={CHAT_PROSE}>{tail}</span>);
  return out;
}

const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

function UserBubble({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ maxWidth: '76%', padding: '10px 14px', borderRadius: '16px 16px 4px 16px', background: 'var(--blue)',
        color: '#fff', font: '400 var(--fs-body)/1.5 var(--font-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {text}
      </div>
    </div>
  );
}

function AssistantTurn({ job, onRetry }: { job: Job; onRetry: (input: string) => void }) {
  const live = job.status === 'running' || job.status === 'pending';
  const engineLabel = job.engine === 'codex' ? 'Codex' : 'Claude Code';
  const provider = job.engine === 'codex' ? 'openai' as const : 'anthropic' as const;
  const hasText = !!(job.output && job.output.length > 0);
  return (
    <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
      <span style={{ width: 28, height: 28, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', marginTop: 2,
        background: 'var(--fill-secondary)', color: 'var(--ink)', border: '0.5px solid var(--separator)' }}>
        {live && !hasText ? <Spinner size={13} color="var(--purple)" /> : <ProviderGlyph provider={provider} size={15} />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>{engineLabel}</span>
          {job.model && job.model !== job.engine && (
            <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{job.model}</span>
          )}
          {live && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--purple)' }}>
              <span className="breathe" style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--purple)' }} />
              {hasText ? 'streaming' : (job.stage || 'working…')}
            </span>
          )}
        </div>
        {hasText && (
          <div style={{ font: '400 var(--fs-body)/1.55 var(--font-text)', color: 'var(--ink)' }}>
            {renderChatBody(job.output ?? '')}
            {live && <span className="chat-caret" style={{ color: 'var(--purple)', fontWeight: 700 }}>▍</span>}
          </div>
        )}
        {!hasText && live && (
          <div style={{ font: '400 var(--fs-footnote)/1.45 var(--font-text)', color: 'var(--ink-tertiary)', fontStyle: 'italic' }}>
            {job.stage || 'Working on it — the reply streams in here…'}
          </div>
        )}
        {job.status === 'failed' && (
          <div style={{ marginTop: 6, padding: '10px 12px', borderRadius: 10, background: 'rgba(255,59,48,0.09)',
            border: '0.5px solid rgba(255,59,48,0.3)', font: '400 var(--fs-footnote)/1.45 var(--font-text)', color: 'var(--red)' }}>
            {job.error ?? 'The run failed.'}
            <button onClick={() => onRetry(job.input)} style={{ marginLeft: 10, font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--red)', textDecoration: 'underline', cursor: 'pointer' }}>Retry</button>
          </div>
        )}
        {job.status === 'cancelled' && (
          <div style={{ marginTop: 4, font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Stopped.</div>
        )}
        {job.status === 'done' && (
          <div style={{ marginTop: 6, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>
            {job.cost > 0 ? `$${job.cost.toFixed(2)} · ` : ''}{job.tokens > 0 ? `${job.tokens >= 1000 ? (job.tokens / 1000).toFixed(1) + 'k' : job.tokens} tok · ` : ''}{fmtDuration(job.updatedAt - job.createdAt)}
          </div>
        )}
      </div>
    </div>
  );
}

function ChatPane({ projectId, project }: { projectId: string | null; project: Project | null }) {
  const [sessions, setSessions] = React.useState<ChatSession[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [turns, setTurns] = React.useState<Job[]>([]);
  const [text, setText] = React.useState('');
  const [engine, setEngine] = React.useState('auto');
  const [effort, setEffort] = React.useState<EffortStop>('BALANCED');
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameVal, setRenameVal] = React.useState('');
  const [sendError, setSendError] = React.useState('');
  const activeRef = React.useRef<string | null>(null);
  activeRef.current = activeId;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stickBottom = React.useRef(true);
  const taRef = React.useRef<HTMLTextAreaElement>(null);

  // Sessions for this project (most recent first; open the latest by default).
  // Reset the open thread whenever the project changes — a stale session id
  // from another project would make sends 404.
  React.useEffect(() => {
    setActiveId(null);
    setTurns([]);
    if (!projectId) { setSessions([]); return; }
    let alive = true;
    api.listSessions(projectId)
      .then(ss => { if (alive) { setSessions(ss); setActiveId(ss[0]?.id ?? null); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [projectId]);

  // Turns of the open session (ascending — a chat thread).
  React.useEffect(() => {
    if (!activeId) { setTurns([]); return; }
    let alive = true;
    api.listJobs(undefined, activeId)
      .then(js => { if (alive) setTurns([...js].sort((a, b) => a.createdAt - b.createdAt)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [activeId]);

  // LIVE: streamed job updates land directly in the open thread.
  React.useEffect(() => {
    const unsub = api.subscribe({
      onJob: (j) => {
        if (!j.sessionId || j.sessionId !== activeRef.current) return;
        setTurns(ts => {
          const i = ts.findIndex(t => t.id === j.id);
          if (i === -1) return [...ts, j].sort((a, b) => a.createdAt - b.createdAt);
          const next = ts.slice(); next[i] = j; return next;
        });
      },
      onSession: (s) => {
        if (s.deleted) {
          setSessions(ss => ss.filter(x => x.id !== s.id));
          if (activeRef.current === s.id) setActiveId(null);
          return;
        }
        if (projectId && s.projectId !== projectId) return;
        setSessions(ss => {
          const i = ss.findIndex(x => x.id === s.id);
          const next = i === -1 ? [s, ...ss] : ss.map(x => (x.id === s.id ? s : x));
          return [...next].sort((a, b) => b.updatedAt - a.updatedAt);
        });
      },
    });
    return unsub;
  }, [projectId]);

  // Stick to the bottom while streaming unless the user scrolled up.
  const onScroll = () => {
    const el = scrollRef.current; if (!el) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const streaming = !!lastTurn && (lastTurn.status === 'running' || lastTurn.status === 'pending');

  const sendText = async (raw: string) => {
    const t = raw.trim();
    if (!t || !projectId || streaming) return;
    setText('');
    setSendError('');
    if (taRef.current) taRef.current.style.height = 'auto';
    stickBottom.current = true;
    try {
      const resp = await api.sendChat({
        projectId, text: t, sessionId: activeRef.current ?? undefined,
        effort: EFFORT_TO_API[effort],
        ...(engine === 'claude' || engine === 'codex' ? { engine: engine as EngineId } : {}),
      });
      setSessions(ss => (ss.some(s => s.id === resp.session.id) ? ss : [resp.session, ...ss]));
      if (activeRef.current !== resp.session.id) setActiveId(resp.session.id);
      else setTurns(ts => [...ts.filter(x => x.id !== resp.job.id), resp.job].sort((a, b) => a.createdAt - b.createdAt));
    } catch (e) {
      setText(raw); // nothing lost — restore the draft
      setSendError(e instanceof Error ? e.message : 'Could not send — try again.');
    }
  };

  const stop = () => { if (lastTurn) void api.cancelJob(lastTurn.id).catch(() => {}); };

  const newChat = () => { setActiveId(null); setTurns([]); setText(''); taRef.current?.focus(); };

  const removeSession = (id: string) => {
    void api.deleteSession(id).catch(() => {});
    setSessions(ss => ss.filter(s => s.id !== id));
    if (activeRef.current === id) setActiveId(null);
  };

  const commitRename = (id: string) => {
    const title = renameVal.trim();
    setRenamingId(null);
    if (!title) return;
    setSessions(ss => ss.map(s => (s.id === id ? { ...s, title } : s)));
    void api.renameSession(id, title).catch(() => {});
  };

  const autoGrow = () => {
    const el = taRef.current; if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(150, el.scrollHeight) + 'px';
  };

  return (
    <div style={{ display: 'flex', gap: 14, height: 'calc(100vh - 252px)', minHeight: 420 }}>
      {/* sessions rail */}
      <div style={{ width: 232, flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-grouped)',
        borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 10px' }}>
          <span style={{ flex: 1, font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>Chats</span>
          <button onClick={newChat} title="New chat" style={{ width: 26, height: 26, borderRadius: 8, display: 'grid', placeItems: 'center',
            background: 'var(--fill-secondary)', color: 'var(--ink)', cursor: 'pointer' }}>
            <Icon name="plus" size={14} stroke={2.4} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {sessions.length === 0 && (
            <div style={{ padding: '18px 10px', font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-tertiary)', textAlign: 'center' }}>
              No chats yet.<br />Say what you want built.
            </div>
          )}
          {sessions.map(s => {
            const active = s.id === activeId;
            return (
              <div key={s.id} className="sess-row" onClick={() => setActiveId(s.id)} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
                background: active ? 'var(--fill-secondary)' : 'transparent' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {renamingId === s.id ? (
                    <input autoFocus value={renameVal} onChange={e => setRenameVal(e.target.value)} onClick={e => e.stopPropagation()}
                      onBlur={() => commitRename(s.id)} onKeyDown={e => { if (e.key === 'Enter') commitRename(s.id); if (e.key === 'Escape') setRenamingId(null); }}
                      style={{ width: '100%', border: '1px solid var(--blue)', borderRadius: 6, padding: '2px 6px', background: 'var(--bg)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1.3 var(--font-text)' }} />
                  ) : (
                    <span onDoubleClick={e => { e.stopPropagation(); setRenamingId(s.id); setRenameVal(s.title); }}
                      style={{ display: 'block', font: `${active ? 600 : 500} var(--fs-footnote)/1.3 var(--font-text)`, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.title}
                    </span>
                  )}
                  <span style={{ display: 'block', font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>{relativeTime(s.updatedAt)}</span>
                </span>
                <button className="sess-x" title="Delete chat" onClick={e => { e.stopPropagation(); removeSession(s.id); }}
                  style={{ width: 20, height: 20, borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', cursor: 'pointer', flexShrink: 0 }}>
                  <Icon name="x" size={12} stroke={2.4} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* thread + composer */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-elevated)',
        borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
        <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', padding: '20px 22px' }}>
          <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
            {turns.length === 0 && (
              <div style={{ padding: '64px 20px', textAlign: 'center' }}>
                <span style={{ width: 52, height: 52, borderRadius: 16, display: 'inline-grid', placeItems: 'center', marginBottom: 14,
                  background: 'color-mix(in srgb, var(--blue) 12%, transparent)', color: 'var(--blue)' }}>
                  <Icon name="terminal" size={26} />
                </span>
                <div style={{ font: '700 var(--fs-title2)/1.25 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)', marginBottom: 6 }}>
                  What should we build{project?.name ? ` in ${project.name}` : ''}?
                </div>
                <div style={{ font: '400 var(--fs-subhead)/1.5 var(--font-text)', color: 'var(--ink-secondary)', maxWidth: 400, margin: '0 auto' }}>
                  Describe it like you'd tell a teammate — the agent works in this project's folder and the reply streams here live.
                </div>
              </div>
            )}
            {turns.map(t => (
              <React.Fragment key={t.id}>
                <UserBubble text={t.input} />
                <AssistantTurn job={t} onRetry={(input) => { void sendText(input); }} />
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* composer */}
        <div style={{ borderTop: '0.5px solid var(--separator)', padding: '12px 14px', background: 'color-mix(in srgb, var(--bg) 30%, var(--bg-elevated))' }}>
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            {sendError && (
              <div style={{ marginBottom: 8, padding: '8px 11px', borderRadius: 9, background: 'rgba(255,59,48,0.09)',
                font: '500 var(--fs-caption)/1.35 var(--font-text)', color: 'var(--red)' }}>{sendError}</div>
            )}
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <textarea ref={taRef} value={text} rows={1} onChange={e => { setText(e.target.value); autoGrow(); }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendText(text); } }}
                placeholder={projectId ? `Message the agent… (Enter to send, Shift+Enter for a new line)` : 'Pick a project first'}
                disabled={!projectId}
                style={{ flex: 1, resize: 'none', border: '1px solid var(--separator-strong)', outline: 'none', borderRadius: 13,
                  background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-body)/1.5 var(--font-text)', padding: '10px 13px',
                  minHeight: 22, maxHeight: 150, boxSizing: 'content-box' }} />
              {streaming ? (
                <button onClick={stop} title="Stop the run" style={{ width: 40, height: 40, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center',
                  background: 'rgba(255,59,48,0.13)', color: 'var(--red)', cursor: 'pointer' }}>
                  <span style={{ width: 13, height: 13, borderRadius: 3.5, background: 'currentColor' }} />
                </button>
              ) : (
                <button onClick={() => { void sendText(text); }} disabled={!text.trim() || !projectId} title="Send" style={{
                  width: 40, height: 40, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center',
                  background: text.trim() ? 'var(--blue)' : 'var(--fill-secondary)', color: text.trim() ? '#fff' : 'var(--ink-tertiary)',
                  boxShadow: text.trim() ? '0 5px 14px rgba(0,122,255,0.32)' : 'none', cursor: text.trim() ? 'pointer' : 'default',
                  transition: 'all 160ms var(--spring)' }}>
                  <Icon name="arrowRight" size={18} stroke={2.4} style={{ transform: 'rotate(-90deg)' }} />
                </button>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 9 }}>
              <ModelSwitcher compact value={engine} onChange={setEngine} />
              <EffortDial compact value={effort} onChange={setEffort} />
              <span style={{ flex: 1 }} />
              {streaming && lastTurn && (
                <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>
                  {lastTurn.stage || 'working…'}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const TABS: { key: string; label: string }[] = [
  { key: 'chat', label: 'Chat' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'instructions', label: 'Instructions' },
  { key: 'skills', label: 'Skills & tools' },
  { key: 'budget', label: 'Budget' },
  { key: 'settings', label: 'Settings' },
];

function Breadcrumb({ name }: { name: string }) {
  const navigate = useNavigate();
  const workspaceName = useWorkspaceName();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10, font: '500 var(--fs-subhead)/1 var(--font-text)' }}>
      <a onClick={() => navigate('/projects')} className="crumb" style={{ color: 'var(--ink-secondary)', textDecoration: 'none', cursor: 'pointer' }}>{workspaceName}</a>
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
        <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Review it in Approvals to let the run continue.</span>
      </span>
      <button onClick={onDismiss} style={{ height: 34, padding: '0 14px', borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Dismiss</button>
      <button onClick={onApprove} className="primary-cta" style={{ height: 34, padding: '0 16px', borderRadius: 8, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Open Approvals</button>
    </div>
  );
}

export default function ProjectDetail() {
  const { id: routeId } = useParams<{ id: string }>();
  const [tab, setTab] = React.useState('chat');
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  // live data
  const [projectId, setProjectId] = React.useState<string | null>(routeId ?? null);
  const [project, setProject] = React.useState<Project | null>(null);
  const [repo, setRepo] = React.useState<RepoInfo | null>(null);
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
        if (p.path) { api.getProjectRepo(projectId).then(r => { if (!cancelled) setRepo(r); }).catch(() => {}); }
        else setRepo(null);
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

  // ⌘K
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const tabIdx = TABS.findIndex(t => t.key === tab);

  const projectJobs = jobs.map(toProjectJob);
  const projectName = project?.name ?? 'Project';
  const projectColor = project?.color ? `var(--${project.color})` : 'var(--blue)';
  const runningCount = jobs.filter(j => j.status === 'running').length;

  return (
    <AppShell active="projects" onSearch={() => setPaletteOpen(true)}>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{KIND_LABEL[project?.kind ?? ''] ?? 'Project'}</span>
              {project?.path && (
                <>
                  <span style={{ color: 'var(--ink-tertiary)' }}>·</span>
                  <span title={project.path} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)', maxWidth: 280,
                    background: 'var(--fill-tertiary)', font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>
                    <Icon name={project.repoUrl ? 'gitMerge' : 'folder'} size={12} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortHomePath(project.path)}</span>
                  </span>
                  {repo?.branch && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)',
                      background: 'color-mix(in srgb, var(--purple) 14%, transparent)', color: 'var(--purple)', font: '600 var(--fs-caption)/1 var(--font-mono)' }}>
                      <Icon name="gitMerge" size={11} /> {repo.branch}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {project?.path && IS_LOCAL && (
              <button onClick={() => { if (project?.path) void api.revealPath(project.path); }} className="split-quiet" title="Reveal in Finder" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 15px', borderRadius: 'var(--r-pill)',
                background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>
                <Icon name="folder" size={16} /> Reveal
              </button>
            )}
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

      {/* tab content — chat pins to the viewport; other tabs scroll the page */}
      <div style={{ padding: tab === 'chat' ? '16px 28px 18px' : '22px 28px 36px' }}>
        {tab === 'chat' && <ChatPane projectId={projectId} project={project} />}
        {tab === 'jobs' && <JobsTab jobs={projectJobs} />}
        {tab === 'instructions' && <InstructionsTab projectId={projectId} project={project} onSaved={(ins) => setProject(p => p ? { ...p, instructions: ins } : p)} />}
        {tab === 'skills' && <SkillsTab />}
        {tab === 'budget' && <BudgetTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
