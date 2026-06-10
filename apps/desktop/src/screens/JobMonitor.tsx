/* Job Monitor — ported from the design prototype (jm-app / jm-timeline /
   jm-inspector). Swim-lane timeline + table view, live now-line drift + cost
   ticking, inspector slide-over, cancel flow, and ⌘K command palette.
   Visual output (inline styles, classNames, var(--…) variables, SVG geometry,
   animation class names) is preserved exactly. */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '../lib/icons';
import { Spinner } from '../lib/ui';
import { AppShell } from '../lib/appShell';

/* ── page-specific CSS lifted from <Job Monitor.html>'s <style> ── */
const styles = `
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .filter-chip { transition: background 140ms ease, color 140ms ease, filter 140ms ease; }
  .filter-chip:hover { filter: brightness(0.97); }
  .cancel-btn:hover { background: rgba(255,59,48,0.2); }
  .cancel-confirm:hover { background: var(--red); filter: brightness(0.92); }
  .row-act:hover { background: rgba(255,59,48,0.12); color: var(--red); }

  /* capsules */
  .capsule:hover { transform: translateY(-1px); box-shadow: var(--card-shadow); z-index: 4; }
  .cap-running { box-shadow: 0 0 0 0 color-mix(in srgb, var(--purple) 40%, transparent); animation: capBreathe 2s ease-in-out infinite; }
  @keyframes capBreathe {
    0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--purple) 36%, transparent); }
    50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--purple) 16%, transparent); }
  }
  .cap-cancelling { animation: capCancel 360ms var(--spring) forwards; }
  @keyframes capCancel {
    0% { box-shadow: 0 0 0 3px rgba(255,59,48,0.5); }
    40% { background: rgba(255,59,48,0.3); transform: scaleX(0.96); }
    100% { background: var(--bg-elevated); border-color: color-mix(in srgb, var(--red) 55%, transparent); }
  }

  /* now-line pulse */
  .now-dot { animation: nowPulse 1.8s ease-in-out infinite; }
  @keyframes nowPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(0,122,255,0.45); } 50% { box-shadow: 0 0 0 6px rgba(0,122,255,0); } }
  .now-line::after { content: ''; position: absolute; inset: 0 -6px; background: linear-gradient(90deg, transparent, rgba(0,122,255,0.12), transparent); }

  .cursor-blink { animation: blink 1.1s step-end infinite; color: currentColor; }
  @keyframes blink { 50% { opacity: 0; } }

  .mon-row:hover { background: var(--fill-tertiary) !important; }

  /* inspector slide-over — frozen-clock-safe entrance */
  .inspector-in { animation: inspectorIn 240ms var(--spring); }
  @keyframes inspectorIn { from { transform: translateX(22px); } to { transform: none; } }

  /* palette — frozen-clock-safe */
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
  .sheet-pop { animation: sheetPop 220ms var(--spring); }
  @keyframes sheetPop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }

  .tl-scroll::-webkit-scrollbar, .inspector ::-webkit-scrollbar { width: 9px; height: 9px; }
  .tl-scroll::-webkit-scrollbar-thumb, .inspector ::-webkit-scrollbar-thumb { background: var(--fill-secondary); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
`;

/* ────────────────────────────────────────────────────────────────────────
   Data model + timeline (swim-lane) view  [from jm-timeline.jsx]
   ──────────────────────────────────────────────────────────────────────── */

// time axis in "minutes": now sits at NOW_MIN; axis spans 0..AXIS_MAX
const NOW_MIN = 60, AXIS_MAX = 96, PX = 10.6, LANE_LABEL = 158, LANE_H = 60, TRACK_W = AXIS_MAX * PX;

type Status = 'running' | 'gated' | 'queued' | 'failed' | 'done' | 'scheduled';

interface Lane {
  id: string;
  name: string;
  color: string;
  capped?: boolean;
}

const LANES: Lane[] = [
  { id: 'atlas',   name: 'Atlas API',     color: 'var(--blue)' },
  { id: 'brand',   name: 'Brand Refresh', color: 'var(--teal)' },
  { id: 'content', name: 'Q3 Content',    color: 'var(--purple)' },
  { id: 'scan',    name: 'Market Scan',   color: 'var(--indigo)', capped: true },
  { id: 'infra',   name: 'Infra / CI',    color: 'var(--orange)' },
];

interface Job {
  id: string;
  lane: string;
  name: string;
  status: Status;
  start: number;
  end?: number;
  dur?: number;
  cost: number;
  shape: string;
  trigger: string;
  effort: string;
  autonomy: string;
  last: string;
  _liveCost?: number;
}

// status: running | gated | queued | failed | done | scheduled
const MON_JOBS: Job[] = [
  { id: 'm1',  lane: 'atlas',   name: 'Refactor auth service', status: 'running',   start: 44, end: 60, cost: 0.42, shape: 'pbr',      trigger: 'hand',    effort: 'DEEP',     autonomy: 'Gated', last: 'patching 3 call sites in routes/' },
  { id: 'm2',  lane: 'atlas',   name: 'Add rate-limiter tests',status: 'running',   start: 53, end: 60, cost: 0.21, shape: 'fanout',   trigger: 'webhook', effort: 'BALANCED', autonomy: 'Gated', last: 'asserting retry-after header' },
  { id: 'm3',  lane: 'atlas',   name: 'Nightly test suite',    status: 'scheduled', start: 72, dur: 9,  cost: 0,    shape: 'pipeline', trigger: 'clock',   effort: 'FAST',     autonomy: 'Unattended', last: 'queued for 18:00' },
  { id: 'm4',  lane: 'brand',   name: 'Export icon set @3x',   status: 'running',   start: 55, end: 60, cost: 0.12, shape: 'fanout',   trigger: 'hand',    effort: 'BALANCED', autonomy: 'Gated', last: 'optimizing with pngquant…' },
  { id: 'm5',  lane: 'brand',   name: 'Generate OG images',    status: 'done',      start: 28, end: 41, cost: 0.34, shape: 'fanout',   trigger: 'hand',    effort: 'BALANCED', autonomy: 'Gated', last: 'zipped 24 assets' },
  { id: 'm6',  lane: 'brand',   name: 'Newsletter hero',       status: 'queued',    start: 60, dur: 5,  cost: 0,    shape: 'single',   trigger: 'hand',    effort: 'BALANCED', autonomy: 'Plan first', last: 'waiting for a slot' },
  { id: 'm7',  lane: 'content', name: 'Draft launch thread',   status: 'gated',     start: 49, end: 58, cost: 0.07, shape: 'single',   trigger: 'chat',    effort: 'BALANCED', autonomy: 'Gated', last: 'awaiting your review' },
  { id: 'm8',  lane: 'content', name: 'Newsletter draft',      status: 'scheduled', start: 79, dur: 10, cost: 0,    shape: 'pipeline', trigger: 'clock',   effort: 'BALANCED', autonomy: 'Gated', last: 'queued for 16:30' },
  { id: 'm9',  lane: 'scan',    name: 'Competitor digest',     status: 'failed',    start: 38, end: 47, cost: 1.20, shape: 'pipeline', trigger: 'clock',   effort: 'DEEP',     autonomy: 'Unattended', last: 'stopped — project cap reached' },
  { id: 'm10', lane: 'scan',    name: 'Trend summary',         status: 'queued',    start: 60, dur: 6,  cost: 0,    shape: 'single',   trigger: 'clock',   effort: 'FAST',     autonomy: 'Unattended', last: 'blocked by budget cap' },
  { id: 'm11', lane: 'infra',   name: 'Dependency audit',      status: 'done',      start: 18, end: 31, cost: 0.12, shape: 'pipeline', trigger: 'clock',   effort: 'FAST',     autonomy: 'Unattended', last: 'no advisories found' },
  { id: 'm12', lane: 'infra',   name: 'Deploy preview',        status: 'failed',    start: 47, end: 49, cost: 0.02, shape: 'single',   trigger: 'webhook', effort: 'FAST',     autonomy: 'Unattended', last: 'build error: missing env' },
  { id: 'm13', lane: 'infra',   name: 'CI hardening',          status: 'running',   start: 54, end: 60, cost: 0.18, shape: 'pbr',      trigger: 'hand',    effort: 'BALANCED', autonomy: 'Gated', last: 'rotating CI tokens' },
];

const STATUS_META: Record<Status, { label: string; tint: string }> = {
  running:   { label: 'Running',   tint: 'var(--purple)' },
  gated:     { label: 'Gated',     tint: 'var(--orange)' },
  queued:    { label: 'Queued',    tint: 'var(--ink-secondary)' },
  failed:    { label: 'Failed',    tint: 'var(--red)' },
  done:      { label: 'Done',      tint: 'var(--green)' },
  scheduled: { label: 'Scheduled', tint: 'var(--teal)' },
};

function axisLabel(min: number): string {
  const d = min - NOW_MIN;
  if (d === 0) return 'now';
  return (d > 0 ? '+' : '') + d + 'm';
}

interface CapsuleProps {
  job: Job;
  nowMin: number;
  onClick: (job: Job) => void;
  selected: boolean;
}

function Capsule({ job, nowMin, onClick, selected }: CapsuleProps) {
  const end = job.status === 'running' ? nowMin : (job.end != null ? job.end : job.start + (job.dur ?? 0));
  const left = job.start * PX;
  const width = Math.max((end - job.start) * PX, 64);
  const m = STATUS_META[job.status];
  const cost = job.status === 'running' ? job._liveCost ?? job.cost : job.cost;

  const base: React.CSSProperties = { position: 'absolute', left, width, top: 10, height: 40, borderRadius: 11,
    display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px', cursor: 'pointer', overflow: 'hidden',
    boxSizing: 'border-box', transition: 'width 800ms linear, box-shadow 140ms ease, transform 140ms ease' };
  const fills: Record<Status, React.CSSProperties> = {
    running: { background: 'linear-gradient(120deg, color-mix(in srgb, var(--purple) 26%, var(--bg-elevated)), color-mix(in srgb, var(--purple) 14%, var(--bg-elevated)))',
      border: '1px solid color-mix(in srgb, var(--purple) 45%, transparent)', color: 'var(--ink)' },
    gated: { background: 'rgba(255,149,0,0.16)', border: '1px solid color-mix(in srgb, var(--orange) 55%, transparent)', color: 'var(--ink)' },
    queued: { background: 'var(--bg-elevated)', border: '1.5px dashed var(--separator-strong)', color: 'var(--ink-secondary)' },
    failed: { background: 'var(--bg-elevated)', border: '1.5px solid color-mix(in srgb, var(--red) 55%, transparent)', color: 'var(--ink)' },
    done: { background: 'var(--fill-secondary)', border: '1px solid var(--separator)', color: 'var(--ink-secondary)' },
    scheduled: { background: 'transparent', border: '1.5px dashed color-mix(in srgb, var(--teal) 55%, transparent)', color: 'var(--ink-secondary)' },
  };
  const icon: Record<Status, React.ReactNode> = { running: <Spinner size={12} color="var(--purple)" />, gated: <Icon name="pause" size={13} style={{ color: 'var(--orange)' }} />,
    queued: <Icon name="clock" size={13} />, failed: <Icon name="x" size={13} stroke={2.6} style={{ color: 'var(--red)' }} />,
    done: <Icon name="check" size={13} stroke={2.6} style={{ color: 'var(--green)' }} />, scheduled: <Icon name="clock" size={13} style={{ color: 'var(--teal)' }} /> };

  return (
    <div data-cap={job.id} onClick={() => onClick(job)} className={`capsule cap-${job.status}`} style={{ ...base, ...fills[job.status],
      boxShadow: selected ? `0 0 0 2px var(--blue), var(--card-shadow)` : 'none' }}>
      <span style={{ flexShrink: 0, display: 'grid', placeItems: 'center' }}>{icon[job.status]}</span>
      <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-footnote)/1 var(--font-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job.name}</span>
      {(job.status === 'running' || job.status === 'gated' || job.status === 'failed' || job.status === 'done') && cost > 0 && (
        <span style={{ flexShrink: 0, font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>${cost.toFixed(2)}</span>
      )}
    </div>
  );
}

interface TimelineProps {
  jobs: Job[];
  nowMin: number;
  onSelect: (job: Job) => void;
  selectedId: string | null;
}

function Timeline({ jobs, nowMin, onSelect, selectedId }: TimelineProps) {
  const ticks: number[] = [];
  for (let m = 0; m <= AXIS_MAX; m += 12) ticks.push(m);
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      {/* scroll region */}
      <div style={{ overflowX: 'auto', overflowY: 'hidden' }} className="tl-scroll">
        <div style={{ minWidth: LANE_LABEL + TRACK_W, position: 'relative' }}>
          {/* axis header */}
          <div style={{ display: 'flex', height: 34, borderBottom: '0.5px solid var(--separator)', position: 'sticky', top: 0, background: 'var(--bg-grouped)', zIndex: 3 }}>
            <div style={{ width: LANE_LABEL, flexShrink: 0, borderRight: '0.5px solid var(--separator)', display: 'flex', alignItems: 'center', padding: '0 14px',
              font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Project</div>
            <div style={{ position: 'relative', width: TRACK_W, flexShrink: 0 }}>
              {ticks.map(m => (
                <span key={m} style={{ position: 'absolute', left: m * PX, top: 0, height: '100%', display: 'flex', alignItems: 'center',
                  transform: 'translateX(-50%)', font: `${m === NOW_MIN ? 700 : 500} var(--fs-caption)/1 var(--font-mono)`,
                  color: m === NOW_MIN ? 'var(--blue)' : 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{axisLabel(m)}</span>
              ))}
            </div>
          </div>

          {/* lanes */}
          <div style={{ position: 'relative' }}>
            {/* now-line spanning all lanes */}
            <div className="now-line" style={{ position: 'absolute', left: LANE_LABEL + nowMin * PX, top: 0, bottom: 0, width: 2, zIndex: 2,
              background: 'var(--blue)', transition: 'left 800ms linear' }}>
              <span className="now-dot" style={{ position: 'absolute', top: -4, left: -4, width: 10, height: 10, borderRadius: '50%', background: 'var(--blue)' }} />
            </div>

            {LANES.map(lane => {
              const laneJobs = jobs.filter(j => j.lane === lane.id);
              return (
                <div key={lane.id} style={{ display: 'flex', height: LANE_H, borderBottom: '0.5px solid var(--separator)' }}>
                  {/* label */}
                  <div style={{ width: LANE_LABEL, flexShrink: 0, borderRight: '0.5px solid var(--separator)', borderLeft: `3px solid ${lane.color}`,
                    display: 'flex', alignItems: 'center', gap: 9, padding: '0 14px', position: 'sticky', left: 0, background: 'var(--bg-grouped)', zIndex: 1 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: lane.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lane.name}</span>
                    {lane.capped && <span title="Budget cap reached" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, height: 18, padding: '0 6px', borderRadius: 'var(--r-pill)',
                      background: 'rgba(255,59,48,0.14)', color: 'var(--red)', font: '600 var(--fs-caption)/1 var(--font-text)', flexShrink: 0 }}><Icon name="lock" size={10} /> Cap</span>}
                  </div>
                  {/* track */}
                  <div style={{ position: 'relative', width: TRACK_W, flexShrink: 0, opacity: lane.capped ? 0.62 : 1 }}>
                    {laneJobs.map(j => <Capsule key={j.id} job={j} nowMin={nowMin} onClick={onSelect} selected={selectedId === j.id} />)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Shared atoms borrowed by this page (ShapeChip from pd-jobs, Segmented from
   pj-cards) — inlined because they are not exported by the shared library.
   ──────────────────────────────────────────────────────────────────────── */

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

interface SegmentedOption {
  key: string;
  label: string;
  icon: IconName;
}
interface SegmentedProps {
  value: string;
  onChange: (key: string) => void;
  options: SegmentedOption[];
}
function Segmented({ value, onChange, options }: SegmentedProps) {
  const i = options.findIndex(o => o.key === value);
  return (
    <div style={{ position: 'relative', display: 'inline-flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 9 }}>
      <div style={{ position: 'absolute', top: 2, bottom: 2, left: `calc(${i * 50}% + 2px)`, width: `calc(50% - 4px)`,
        background: 'var(--bg-elevated)', borderRadius: 7, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 240ms var(--spring)' }} />
      {options.map(o => (
        <button key={o.key} onClick={() => onChange(o.key)} style={{
          position: 'relative', zIndex: 1, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px',
          font: '600 var(--fs-subhead)/1 var(--font-text)', color: value === o.key ? 'var(--ink)' : 'var(--ink-secondary)' }}>
          <Icon name={o.icon} size={15} /> {o.label}
        </button>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Command palette (from cc-palette.jsx) — inlined; not exported by shared lib.
   ──────────────────────────────────────────────────────────────────────── */

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

/* ────────────────────────────────────────────────────────────────────────
   Table view + inspector slide-over + cancel sheet  [from jm-inspector.jsx]
   ──────────────────────────────────────────────────────────────────────── */

const EFFORT_TINT: Record<string, string> = { FAST: 'var(--green)', BALANCED: 'var(--blue)', DEEP: 'var(--orange)', MAX: 'var(--red)' };
const MON_TRIG_ICON: Record<string, IconName> = { hand: 'play', clock: 'clock', chat: 'command', webhook: 'bolt' };

function laneOf(id: string): Lane {
  return LANES.find(l => l.id === id) as Lane;
}

function MonStatus({ status }: { status: Status }) {
  const m = STATUS_META[status];
  const node = {
    running: <Spinner size={12} color={m.tint} />, gated: <Icon name="pause" size={13} />,
    queued: <Icon name="clock" size={13} />, failed: <Icon name="x" size={13} stroke={2.6} />,
    done: <Icon name="check" size={13} stroke={2.6} />, scheduled: <Icon name="clock" size={13} />,
  }[status];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: m.tint, font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
      {node} {m.label}
    </span>
  );
}

interface MonTableProps {
  jobs: Job[];
  onSelect: (job: Job) => void;
  selectedId: string | null;
  onCancel: (job: Job) => void;
}

function MonTable({ jobs, onSelect, selectedId, onCancel }: MonTableProps) {
  const cols = '1.1fr 1.8fr 1.1fr 0.7fr 1fr 0.8fr 0.7fr 0.8fr 0.7fr 64px';
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, alignItems: 'center', gap: 12, padding: '11px 16px',
        borderBottom: '0.5px solid var(--separator)', background: 'var(--fill-tertiary)' }}>
        {['Project', 'Job', 'Shape', 'Trigger', 'Status', 'Effort', 'Cost', 'Started', 'Duration', ''].map((h, i) => (
          <span key={i} style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)',
            textAlign: i === 6 ? 'right' : 'left' }}>{h}</span>
        ))}
      </div>
      {jobs.map((j, i) => {
        const lane = laneOf(j.lane);
        const dur = j.status === 'scheduled' ? `~${j.dur}m` : j.end != null ? `${j.end - j.start}m` : '—';
        const started = j.status === 'scheduled' ? `in ${j.start - NOW_MIN}m` : `${NOW_MIN - j.start}m ago`;
        return (
          <div key={j.id} onClick={() => onSelect(j)} className="mon-row" style={{ display: 'grid', gridTemplateColumns: cols, alignItems: 'center', gap: 12,
            padding: '12px 16px', borderBottom: i < jobs.length - 1 ? '0.5px solid var(--separator)' : 'none', cursor: 'pointer',
            background: selectedId === j.id ? 'var(--fill-tertiary)' : 'transparent' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: lane.color, flexShrink: 0 }} />
              <span style={{ font: '500 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lane.name}</span>
            </span>
            <span style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.name}</span>
            <span><ShapeChip shape={j.shape} /></span>
            <span title={j.trigger} style={{ color: 'var(--ink-tertiary)' }}><Icon name={MON_TRIG_ICON[j.trigger]} size={15} /></span>
            <span><MonStatus status={j.status} /></span>
            <span style={{ font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.03em', color: EFFORT_TINT[j.effort] }}>{j.effort}</span>
            <span style={{ textAlign: 'right', font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>{j.cost > 0 ? '$' + j.cost.toFixed(2) : '—'}</span>
            <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{started}</span>
            <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{dur}</span>
            <span style={{ display: 'inline-flex', gap: 4, justifyContent: 'flex-end' }}>
              {(j.status === 'running' || j.status === 'gated') && (
                <button onClick={e => { e.stopPropagation(); onCancel(j); }} className="row-act" title="Cancel" style={{ width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Inspector slide-over ── */
interface InspectorProps {
  job: Job | null;
  onClose: () => void;
  onCancel: (job: Job) => void;
}

function Inspector({ job, onClose, onCancel }: InspectorProps) {
  const navigate = useNavigate();
  if (!job) return null;
  const lane = laneOf(job.lane);
  const m = STATUS_META[job.status];
  const cost = job.status === 'running' ? job._liveCost ?? job.cost : job.cost;
  const cap = job.lane === 'scan' ? 30 : 50;
  return (
    <div className="inspector inspector-in" data-open="true" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 380, zIndex: 40,
      background: 'var(--bg-elevated)',
      borderLeft: '0.5px solid var(--separator)', boxShadow: '-12px 0 40px rgba(10,15,40,0.18)', display: 'flex', flexDirection: 'column' }}>
      <React.Fragment>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 18px 16px', borderBottom: '0.5px solid var(--separator)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: lane.color, flexShrink: 0, marginTop: 7 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)', textWrap: 'pretty' }}>{job.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{lane.name}</span>
                <span style={{ color: 'var(--ink-tertiary)' }}>·</span>
                <MonStatus status={job.status} />
              </div>
            </div>
            <button onClick={onClose} className="tb-icon" style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)', flexShrink: 0 }}>
              <Icon name="x" size={17} />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>
            {/* chips */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Tag icon="bolt" tint={EFFORT_TINT[job.effort]}>{job.effort}</Tag>
              <Tag icon="shield" tint="var(--blue)">{job.autonomy}</Tag>
              <Tag icon={MON_TRIG_ICON[job.trigger]} tint="var(--ink-secondary)">{job.trigger}</Tag>
              <ShapeChip shape={job.shape} />
            </div>

            {/* live last line */}
            <div>
              <Label>Live output</Label>
              <div style={{ background: 'var(--bg-elevated)', borderRadius: 10, border: '0.5px solid var(--separator)', padding: '12px 14px',
                font: '400 var(--fs-footnote)/1.5 var(--font-mono)', color: 'var(--ink-secondary)' }}>
                <span style={{ color: m.tint, marginRight: 6 }}>›</span>{job.last}
                {job.status === 'running' && <span className="cursor-blink" style={{ marginLeft: 2 }}>▍</span>}
              </div>
            </div>

            {/* budget mini-meter */}
            <div>
              <Label>Project budget</Label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--fill-secondary)', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(100, (cost + (job.lane === 'scan' ? 28.8 : 22) ) / cap * 100)}%`, height: '100%', borderRadius: 4,
                    background: job.lane === 'scan' ? 'var(--red)' : 'var(--green)' }} />
                </div>
                <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>
                  ${(cost + (job.lane === 'scan' ? 28.8 : 22)).toFixed(2)} / ${cap}
                </span>
              </div>
              {job.lane === 'scan' && <div style={{ font: '500 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--red)', marginTop: 7 }}>Project cap reached — jobs are blocked.</div>}
            </div>

            {/* this run cost */}
            <div style={{ display: 'flex', gap: 10 }}>
              <Stat label="This run" value={cost > 0 ? `$${cost.toFixed(2)}` : '—'} />
              <Stat label={job.status === 'scheduled' ? 'Starts in' : 'Elapsed'} value={job.status === 'scheduled' ? `${job.start - NOW_MIN}m` : `${NOW_MIN - job.start}m`} />
            </div>
          </div>

          {/* actions */}
          <div style={{ display: 'flex', gap: 10, padding: 16, borderTop: '0.5px solid var(--separator)' }}>
            <a onClick={() => navigate('/session-transcript')} className="primary-cta" style={{ flex: 1, height: 42, borderRadius: 'var(--r-pill)', textDecoration: 'none', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>
              <Icon name="terminal" size={16} /> Open transcript
            </a>
            {(job.status === 'running' || job.status === 'gated') && (
              <button onClick={() => onCancel(job)} className="cancel-btn" style={{ height: 42, padding: '0 18px', borderRadius: 'var(--r-pill)',
                background: 'rgba(255,59,48,0.12)', color: 'var(--red)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
            )}
          </div>
        </React.Fragment>
    </div>
  );
}

function Tag({ icon, tint, children }: { icon: IconName; tint: string; children?: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)',
      background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint, font: '600 var(--fs-footnote)/1 var(--font-text)', textTransform: 'capitalize' }}>
      <Icon name={icon} size={13} /> {children}
    </span>
  );
}
function Label({ children }: { children?: React.ReactNode }) {
  return <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 8 }}>{children}</div>;
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: 1, background: 'var(--bg-elevated)', borderRadius: 10, border: '0.5px solid var(--separator)', padding: '10px 12px' }}>
      <div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 5 }}>{label}</div>
      <div style={{ font: '600 var(--fs-headline)/1 var(--font-mono)', color: 'var(--ink)' }}>{value}</div>
    </div>
  );
}

interface CancelSheetProps {
  job: Job | null;
  onClose: () => void;
  onConfirm: (job: Job) => void;
}

function CancelSheet({ job, onClose, onConfirm }: CancelSheetProps) {
  if (!job) return null;
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 90, display: 'grid', placeItems: 'center', padding: 40,
      background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 420, background: 'var(--bg-elevated)', borderRadius: 18,
        border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', overflow: 'hidden' }}>
        <div style={{ padding: '24px 24px 18px', textAlign: 'center' }}>
          <span style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(255,59,48,0.14)', color: 'var(--red)', display: 'grid', placeItems: 'center', margin: '0 auto 14px' }}>
            <Icon name="alert" size={24} />
          </span>
          <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Cancel this job?</h2>
          <p style={{ margin: 0, font: '400 var(--fs-subhead)/1.45 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>
            “{job.name}” will stop immediately. Work in progress is discarded and you’ll be billed for ${(job._liveCost ?? job.cost).toFixed(2)} already spent.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, padding: '0 18px 18px' }}>
          <button onClick={onClose} style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Keep running</button>
          <button onClick={() => onConfirm(job)} className="cancel-confirm" style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: 'var(--red)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(255,59,48,0.32)' }}>Cancel job</button>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Page assembly  [from jm-app.jsx]
   ──────────────────────────────────────────────────────────────────────── */

const MON_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'gated', label: 'Gated' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'failed', label: 'Failed' },
];

function CounterPill({ n, label, tint }: { n: number; label: string; tint: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 11px', borderRadius: 'var(--r-pill)',
      background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint, font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
      <b style={{ font: '700 var(--fs-callout)/1 var(--font-mono)' }}>{n}</b> {label}
    </span>
  );
}

export default function JobMonitor() {
  const [view, setView] = React.useState('timeline');
  const [filter, setFilter] = React.useState('all');
  const [jobs, setJobs] = React.useState<Job[]>(() => MON_JOBS.map(j => ({ ...j, _liveCost: j.cost })));
  const [nowMin, setNowMin] = React.useState(NOW_MIN);
  const [sel, setSel] = React.useState<Job | null>(null);
  const [cancelJob, setCancelJob] = React.useState<Job | null>(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  // live drift: advance now-line + tick running costs
  React.useEffect(() => {
    const t = setInterval(() => {
      setNowMin(n => (n < 67 ? +(n + 0.08).toFixed(2) : n));
      setJobs(js => js.map(j => j.status === 'running' ? { ...j, _liveCost: +((j._liveCost ?? j.cost) + 0.002 + Math.random() * 0.004).toFixed(3) } : j));
    }, 900);
    return () => clearInterval(t);
  }, []);

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } if (e.key === 'Escape') setSel(null); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const counts = {
    running: jobs.filter(j => j.status === 'running').length,
    gated: jobs.filter(j => j.status === 'gated').length,
    queued: jobs.filter(j => j.status === 'queued').length,
  };
  const shown = jobs.filter(j => filter === 'all' || j.status === filter);

  const doCancel = (job: Job) => {
    const capEl = document.querySelector(`[data-cap="${job.id}"]`);
    if (capEl) capEl.classList.add('cap-cancelling');
    setCancelJob(null);
    setTimeout(() => {
      setJobs(js => js.map(j => j.id === job.id ? { ...j, status: 'failed', end: Math.round(nowMin), last: 'cancelled by operator' } : j));
      setSel(s => s && s.id === job.id ? { ...s, status: 'failed', last: 'cancelled by operator' } : s);
    }, 360);
  };

  return (
    <AppShell active="jobs" onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }}>
      <style>{styles}</style>
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '24px 28px 0', height: '100%' }}>
        {/* header row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Jobs</h1>
          <div style={{ display: 'inline-flex', gap: 8 }}>
            <CounterPill n={counts.running} label="running" tint="var(--purple)" />
            <CounterPill n={counts.gated} label="gated" tint="var(--orange)" />
            <CounterPill n={counts.queued} label="queued" tint="var(--ink-secondary)" />
          </div>
          <span style={{ flex: 1 }} />
          <Segmented value={view} onChange={setView}
            options={[{ key: 'timeline', label: 'Timeline', icon: 'sliders' }, { key: 'table', label: 'Table', icon: 'jobs' }]} />
        </div>

        {/* filters */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
          <button className="filter-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)',
            background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
            All projects <Icon name="chevronDown" size={14} />
          </button>
          <span style={{ width: 1, height: 20, background: 'var(--separator)' }} />
          {MON_FILTERS.map(f => {
            const on = filter === f.key;
            const c = f.key === 'all' ? jobs.length : jobs.filter(j => j.status === f.key).length;
            return (
              <button key={f.key} onClick={() => setFilter(f.key)} className="filter-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)',
                background: on ? 'var(--blue)' : 'var(--fill-secondary)', color: on ? '#fff' : 'var(--ink-secondary)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
                {f.label}
                <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 'var(--r-pill)', background: on ? 'rgba(255,255,255,0.25)' : 'var(--fill-secondary)',
                  color: on ? '#fff' : 'var(--ink-tertiary)', font: '700 var(--fs-caption)/18px var(--font-mono)', textAlign: 'center' }}>{c}</span>
              </button>
            );
          })}
        </div>

        {/* board */}
        <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 28 }}>
          {view === 'timeline'
            ? <Timeline jobs={shown} nowMin={nowMin} onSelect={setSel} selectedId={sel && sel.id} />
            : <MonTable jobs={shown} onSelect={setSel} selectedId={sel && sel.id} onCancel={setCancelJob} />}
        </div>
      </main>

      <Inspector job={sel} onClose={() => setSel(null)} onCancel={setCancelJob} />
      <CancelSheet job={cancelJob} onClose={() => setCancelJob(null)} onConfirm={doCancel} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
