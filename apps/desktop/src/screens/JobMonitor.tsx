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
import { api, type Job as ApiJob, type Project } from '../lib/api';

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

/* Real time axis. The window spans the earliest job start → max(now, latest
   end); capsules are positioned by their REAL createdAt/updatedAt and packed
   into stacked sub-rows per lane so they never overlap, no matter how many
   jobs cluster at the same moment. */
const LANE_LABEL = 158, TRACK_W = 1000, LANE_MIN_H = 60;
const CAP_H = 38, CAP_GAP = 6, LANE_PAD = 11; // capsule height, vertical gap between sub-rows, lane padding
const MIN_CAP_W = 96, CAP_GAP_X = 8;          // min capsule width + min horizontal gap used by the packer
const MINUTE = 60_000, HOUR = 3_600_000;

type Status = 'running' | 'gated' | 'queued' | 'failed' | 'done' | 'scheduled' | 'cancelled';

interface Lane {
  id: string;
  name: string;
  color: string;
  capped?: boolean;
}

/* Swim-lanes are built live from projects (id/name/color). laneOf() falls back
   to an "Unassigned" lane for any job whose project is missing. */
function lanesFromProjects(projects: Project[]): Lane[] {
  return projects.map(p => ({ id: p.id, name: p.name, color: `var(--${p.color})` }));
}

interface Job {
  id: string;
  lane: string;
  name: string;
  status: Status;
  startMs: number;        // real createdAt
  endMs: number | null;   // real updatedAt; null = still running (capsule extends to now)
  cost: number;
  tokens: number;
  shape: string;
  trigger: string;
  effort: string;
  autonomy: string;
  engine: string;
  model: string;
  sessionId?: string;
  output: string;
  last: string;
  _liveCost?: number;
}

// status: running | gated | queued | failed | done | scheduled
const STATUS_META: Record<Status, { label: string; tint: string }> = {
  running:   { label: 'Running',   tint: 'var(--purple)' },
  gated:     { label: 'Gated',     tint: 'var(--orange)' },
  queued:    { label: 'Queued',    tint: 'var(--ink-secondary)' },
  failed:    { label: 'Failed',    tint: 'var(--red)' },
  done:      { label: 'Done',      tint: 'var(--green)' },
  scheduled: { label: 'Scheduled', tint: 'var(--teal)' },
  cancelled: { label: 'Cancelled', tint: 'var(--ink-tertiary)' },
};

/* Human label for an absolute timestamp relative to `now`. */
function axisLabel(ts: number, now: number): string {
  const d = ts - now;
  if (Math.abs(d) < 45_000) return 'now';
  const sign = d < 0 ? '-' : '+';
  const a = Math.abs(d);
  if (a < HOUR) return sign + Math.round(a / MINUTE) + 'm';
  const h = Math.floor(a / HOUR), m = Math.round((a % HOUR) / MINUTE);
  return sign + h + 'h' + (m ? ' ' + m + 'm' : '');
}

/* Compact duration / "ago" formatters shared by the table + inspector. */
function fmtDur(ms: number): string {
  if (ms < MINUTE) return Math.max(1, Math.round(ms / 1000)) + 's';
  if (ms < HOUR) { const m = Math.floor(ms / MINUTE), s = Math.round((ms % MINUTE) / 1000); return m + 'm' + (s ? ' ' + s + 's' : ''); }
  const h = Math.floor(ms / HOUR), m = Math.round((ms % HOUR) / MINUTE);
  return h + 'h' + (m ? ' ' + m + 'm' : '');
}
function fmtAgo(ms: number): string {
  if (ms < 0) return 'in ' + fmtDur(-ms);
  if (ms < MINUTE) return 'just now';
  return fmtDur(ms) + ' ago';
}

/* ── live-API → local timeline Job adapter ──
   The local Job/Status model and the synthetic "minutes" time axis are purely
   presentational. We map each api Job onto it so the existing render code is
   unchanged: api status → local status, projectId → lane, cost/tokens through,
   and a synthetic start/end derived from status+progress so capsules land in a
   sensible spot relative to the now-line. */
function statusFromApi(s: ApiJob['status']): Status {
  // pending shows under the Scheduled/Queued/Gated buckets; we surface it as 'scheduled'
  if (s === 'pending') return 'scheduled';
  return s; // 'running' | 'done' | 'failed' all share names with the local model
}

const SHAPE_BY_EFFORT: Record<string, string> = { fast: 'single', balanced: 'fanout', deep: 'pbr', max: 'pipeline' };

function mapApiJob(j: ApiJob): Job {
  const status = statusFromApi(j.status);
  const effort = j.effort.toUpperCase();
  const last = j.error ?? (j.phase || j.stage) ?? '';
  return {
    id: j.id,
    lane: j.projectId,
    name: j.title,
    status,
    // real placement: start = when it was created, end = last update (null while running)
    startMs: j.createdAt,
    endMs: status === 'running' ? null : j.updatedAt,
    cost: j.cost,
    tokens: j.tokens,
    shape: SHAPE_BY_EFFORT[j.effort] ?? 'single',
    trigger: 'hand',
    effort: (effort in EFFORT_TINT ? effort : 'BALANCED'),
    autonomy: 'Gated',
    engine: j.engine ?? 'claude',
    model: j.model ?? '',
    sessionId: j.sessionId,
    output: j.output ?? '',
    last,
    _liveCost: j.cost,
  };
}

interface CapsuleProps {
  job: Job;
  left: number;
  width: number;
  top: number;
  onClick: (job: Job) => void;
  selected: boolean;
}

function Capsule({ job, left, width, top, onClick, selected }: CapsuleProps) {
  const cost = job.status === 'running' ? job._liveCost ?? job.cost : job.cost;

  const base: React.CSSProperties = { position: 'absolute', left, width, top, height: CAP_H, borderRadius: 11,
    display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px', cursor: 'pointer', overflow: 'hidden',
    boxSizing: 'border-box', transition: 'width 600ms linear, box-shadow 140ms ease, transform 140ms ease' };
  const fills: Record<Status, React.CSSProperties> = {
    running: { background: 'linear-gradient(120deg, color-mix(in srgb, var(--purple) 26%, var(--bg-elevated)), color-mix(in srgb, var(--purple) 14%, var(--bg-elevated)))',
      border: '1px solid color-mix(in srgb, var(--purple) 45%, transparent)', color: 'var(--ink)' },
    gated: { background: 'rgba(255,149,0,0.16)', border: '1px solid color-mix(in srgb, var(--orange) 55%, transparent)', color: 'var(--ink)' },
    queued: { background: 'var(--bg-elevated)', border: '1.5px dashed var(--separator-strong)', color: 'var(--ink-secondary)' },
    failed: { background: 'var(--bg-elevated)', border: '1.5px solid color-mix(in srgb, var(--red) 55%, transparent)', color: 'var(--ink)' },
    done: { background: 'var(--fill-secondary)', border: '1px solid var(--separator)', color: 'var(--ink-secondary)' },
    scheduled: { background: 'transparent', border: '1.5px dashed color-mix(in srgb, var(--teal) 55%, transparent)', color: 'var(--ink-secondary)' },
    cancelled: { background: 'var(--fill-tertiary)', border: '1px solid var(--separator)', color: 'var(--ink-tertiary)' },
  };
  const icon: Record<Status, React.ReactNode> = { running: <Spinner size={12} color="var(--purple)" />, gated: <Icon name="pause" size={13} style={{ color: 'var(--orange)' }} />,
    queued: <Icon name="clock" size={13} />, failed: <Icon name="x" size={13} stroke={2.6} style={{ color: 'var(--red)' }} />,
    done: <Icon name="check" size={13} stroke={2.6} style={{ color: 'var(--green)' }} />, scheduled: <Icon name="clock" size={13} style={{ color: 'var(--teal)' }} />,
    cancelled: <Icon name="x" size={13} stroke={2.6} style={{ color: 'var(--ink-tertiary)' }} /> };

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
  lanes: Lane[];
  nowMs: number;
  onSelect: (job: Job) => void;
  selectedId: string | null;
}

/* Greedy interval packing: place each job in the first sub-row whose last
   capsule's right edge clears this one's left edge (+ a gap). Returns each
   job's pixel box and the number of sub-rows the lane needs. */
function packLane(laneJobs: Job[], x: (t: number) => number, nowMs: number) {
  const sorted = [...laneJobs].sort((a, b) => a.startMs - b.startMs);
  const rowEdges: number[] = []; // right px edge of the last capsule per row
  const placed = sorted.map(j => {
    const left = x(j.startMs);
    const width = Math.max(MIN_CAP_W, x(j.endMs ?? nowMs) - left);
    let r = rowEdges.findIndex(edge => left >= edge + CAP_GAP_X);
    if (r === -1) { r = rowEdges.length; }
    rowEdges[r] = left + width;
    return { job: j, left, width, top: LANE_PAD + r * (CAP_H + CAP_GAP) };
  });
  return { placed, rows: Math.max(1, rowEdges.length) };
}

function Timeline({ jobs, lanes, nowMs, onSelect, selectedId }: TimelineProps) {
  // Open scrolled to "now" (the right edge) — active work matters most; the
  // user can scroll left through history. One-shot so it never fights scrolling.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const didScroll = React.useRef(false);
  React.useEffect(() => {
    if (!didScroll.current && scrollRef.current && jobs.length) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
      didScroll.current = true;
    }
  }, [jobs.length]);

  // real time window across all shown jobs (+ now), floored + padded
  const starts = jobs.map(j => j.startMs);
  const ends = jobs.map(j => j.endMs ?? nowMs);
  let t0 = starts.length ? Math.min(...starts) : nowMs - HOUR;
  let t1 = Math.max(nowMs, ...(ends.length ? ends : [nowMs]));
  if (t1 - t0 < 5 * MINUTE) t0 = t1 - 5 * MINUTE; // keep short single runs from being hairlines
  const pad = (t1 - t0) * 0.04;
  t0 -= pad; t1 += pad;
  const span = (t1 - t0) || 1;
  const x = (t: number) => ((t - t0) / span) * TRACK_W;

  const TICKS = 6;
  const ticks: number[] = [];
  for (let i = 0; i <= TICKS; i++) ticks.push(t0 + (span * i) / TICKS);

  const laneLayout = lanes.map(lane => {
    const { placed, rows } = packLane(jobs.filter(j => j.lane === lane.id), x, nowMs);
    const height = Math.max(LANE_MIN_H, LANE_PAD * 2 + rows * CAP_H + (rows - 1) * CAP_GAP);
    return { lane, placed, height };
  });

  const nowX = x(nowMs);
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      {/* scroll region */}
      <div ref={scrollRef} style={{ overflowX: 'auto', overflowY: 'hidden' }} className="tl-scroll">
        <div style={{ minWidth: LANE_LABEL + TRACK_W, position: 'relative' }}>
          {/* axis header */}
          <div style={{ display: 'flex', height: 34, borderBottom: '0.5px solid var(--separator)', position: 'sticky', top: 0, background: 'var(--bg-grouped)', zIndex: 3 }}>
            <div style={{ width: LANE_LABEL, flexShrink: 0, borderRight: '0.5px solid var(--separator)', display: 'flex', alignItems: 'center', padding: '0 14px',
              font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Project</div>
            <div style={{ position: 'relative', width: TRACK_W, flexShrink: 0 }}>
              {ticks.map((t, i) => {
                const near = Math.abs(t - nowMs) < span / TICKS / 2;
                return (
                  <span key={i} style={{ position: 'absolute', left: x(t), top: 0, height: '100%', display: 'flex', alignItems: 'center',
                    transform: 'translateX(-50%)', font: `${near ? 700 : 500} var(--fs-caption)/1 var(--font-mono)`,
                    color: near ? 'var(--blue)' : 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{axisLabel(t, nowMs)}</span>
                );
              })}
            </div>
          </div>

          {/* lanes */}
          <div style={{ position: 'relative' }}>
            {/* now-line spanning all lanes */}
            {nowX >= 0 && nowX <= TRACK_W && (
              <div className="now-line" style={{ position: 'absolute', left: LANE_LABEL + nowX, top: 0, bottom: 0, width: 2, zIndex: 2, background: 'var(--blue)' }}>
                <span className="now-dot" style={{ position: 'absolute', top: -4, left: -4, width: 10, height: 10, borderRadius: '50%', background: 'var(--blue)' }} />
              </div>
            )}

            {laneLayout.map(({ lane, placed, height }) => (
              <div key={lane.id} style={{ display: 'flex', minHeight: height, borderBottom: '0.5px solid var(--separator)' }}>
                {/* label */}
                <div style={{ width: LANE_LABEL, flexShrink: 0, borderRight: '0.5px solid var(--separator)', borderLeft: `3px solid ${lane.color}`,
                  display: 'flex', alignItems: 'center', gap: 9, padding: '0 14px', position: 'sticky', left: 0, background: 'var(--bg-grouped)', zIndex: 1 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: lane.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lane.name}</span>
                </div>
                {/* track */}
                <div style={{ position: 'relative', width: TRACK_W, flexShrink: 0 }}>
                  {placed.map(({ job, left, width, top }) => (
                    <Capsule key={job.id} job={job} left={left} width={width} top={top} onClick={onSelect} selected={selectedId === job.id} />
                  ))}
                </div>
              </div>
            ))}
            {laneLayout.length === 0 && (
              <div style={{ padding: '40px 0', textAlign: 'center', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>No jobs yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Segmented control (inlined from pj-cards — not exported by the shared lib).
   ──────────────────────────────────────────────────────────────────────── */

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

/* ────────────────────────────────────────────────────────────────────────
   Table view + inspector slide-over + cancel sheet  [from jm-inspector.jsx]
   ──────────────────────────────────────────────────────────────────────── */

const EFFORT_TINT: Record<string, string> = { FAST: 'var(--green)', BALANCED: 'var(--blue)', DEEP: 'var(--orange)', MAX: 'var(--red)' };

function laneOf(lanes: Lane[], id: string): Lane {
  return lanes.find(l => l.id === id) ?? { id, name: 'Unassigned', color: 'var(--ink-secondary)' };
}

function MonStatus({ status }: { status: Status }) {
  const m = STATUS_META[status];
  const node = {
    running: <Spinner size={12} color={m.tint} />, gated: <Icon name="pause" size={13} />,
    queued: <Icon name="clock" size={13} />, failed: <Icon name="x" size={13} stroke={2.6} />,
    done: <Icon name="check" size={13} stroke={2.6} />, scheduled: <Icon name="clock" size={13} />,
    cancelled: <Icon name="x" size={13} stroke={2.6} />,
  }[status];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: m.tint, font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
      {node} {m.label}
    </span>
  );
}

/* A human one-liner of what the agent is actually doing / did — the thing you
   want to see without clicking in. Running → its latest live line; done → a
   concise lead from the result; failed → the error. Real output, not stats. */
function cleanLine(s: string): string {
  return s.replace(/^[#>\-*\s]+/, '').replace(/\*\*|__|[`*_]/g, '').trim();
}
function activityLine(j: Job): string {
  const lines = (j.output || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (j.status === 'failed') return cleanLine((j.last || lines[0] || 'Run failed')).slice(0, 240) || 'Run failed';
  if (j.status === 'running') return (cleanLine(lines[lines.length - 1] || j.last || '') || 'Working…').slice(0, 240);
  if (j.status === 'done') {
    const lead = lines.find(l => !/^[#`]/.test(l) && cleanLine(l).length > 1) || lines[0] || '';
    return (cleanLine(lead) || 'Completed').slice(0, 240);
  }
  if (j.status === 'cancelled') return 'Cancelled';
  return j.last || 'Queued';
}
/** Where a job's transcript lives: a chat thread for session jobs, else the
    read-only transcript screen. */
function transcriptHref(j: Job): string {
  return j.sessionId ? `/project-detail/${j.lane}?s=${encodeURIComponent(j.sessionId)}` : `/session-transcript/${j.id}`;
}

interface ActivityListProps {
  jobs: Job[];
  lanes: Lane[];
  nowMs: number;
  onCancel: (job: Job) => void;
}

/* One scannable job row: status + title + a live line of what the agent is
   doing, with light meta. Click to expand its recent output inline — no
   slide-over, no drilling through panels just to see what happened. */
function ActivityRow({ job, lane, nowMs, onCancel, open, onToggle }: { job: Job; lane: Lane; nowMs: number; onCancel: (j: Job) => void; open: boolean; onToggle: () => void }) {
  const navigate = useNavigate();
  const m = STATUS_META[job.status];
  const running = job.status === 'running';
  const when = job.endMs ?? nowMs;
  const out = (job.output || '').trim();
  const tail = out.length > 5000 ? '…' + out.slice(-5000) : out;
  return (
    <div style={{ borderBottom: '0.5px solid var(--separator)' }}>
      <div onClick={onToggle} className="mon-row" style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '13px 16px', cursor: 'pointer' }}>
        <span style={{ width: 26, height: 26, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${m.tint} 14%, transparent)`, color: m.tint }}>
          {running ? <Spinner size={13} color={m.tint} /> : job.status === 'failed' ? <Icon name="x" size={14} stroke={2.6} /> : job.status === 'done' ? <Icon name="check" size={14} stroke={2.8} /> : <Icon name="clock" size={13} />}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job.name}</span>
            <span style={{ flexShrink: 0, font: '600 var(--fs-caption)/1 var(--font-text)', color: m.tint }}>{m.label}</span>
          </span>
          <span style={{ display: 'block', marginTop: 3, font: `400 var(--fs-footnote)/1.35 var(--font-${running ? 'mono' : 'text'})`, color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {activityLine(job)}{running && <span className="cursor-blink" style={{ marginLeft: 2 }}>▍</span>}
          </span>
        </span>
        <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: 140, overflow: 'hidden' }}><span style={{ width: 7, height: 7, borderRadius: 4, background: lane.color, flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lane.name}</span></span>
          {job.cost > 0 && <span style={{ color: 'var(--ink-secondary)' }}>${job.cost.toFixed(2)}</span>}
          <span>{fmtAgo(nowMs - when)}</span>
          <Icon name="chevronDown" size={15} style={{ color: 'var(--ink-tertiary)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms var(--spring)' }} />
        </span>
      </div>
      {open && (
        <div style={{ padding: '0 16px 14px 55px' }}>
          <div className="tl-scroll" style={{ maxHeight: 300, overflowY: 'auto', background: 'var(--bg-grouped)', borderRadius: 10, border: '0.5px solid var(--separator)', padding: '12px 14px',
            font: '400 var(--fs-footnote)/1.55 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {tail || (running ? 'Working…' : 'No output recorded.')}
            {running && <span className="cursor-blink" style={{ marginLeft: 2, color: m.tint }}>▍</span>}
          </div>
          <div style={{ display: 'flex', gap: 9, marginTop: 10 }}>
            <button onClick={e => { e.stopPropagation(); navigate(transcriptHref(job)); }} className="primary-cta" style={{ height: 36, padding: '0 15px', borderRadius: 'var(--r-pill)', border: 'none', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 7, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
              <Icon name={job.sessionId ? 'command' : 'terminal'} size={14} /> {job.sessionId ? 'Open chat' : 'Open transcript'}
            </button>
            {running && <button onClick={e => { e.stopPropagation(); onCancel(job); }} className="cancel-btn" style={{ height: 36, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'rgba(255,59,48,0.12)', color: 'var(--red)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Cancel</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityList({ jobs, lanes, nowMs, onCancel }: ActivityListProps) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const sorted = [...jobs].sort((a, b) => (b.endMs ?? nowMs) - (a.endMs ?? nowMs) || b.startMs - a.startMs);
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      {sorted.map(j => (
        <ActivityRow key={j.id} job={j} lane={laneOf(lanes, j.lane)} nowMs={nowMs} onCancel={onCancel} open={openId === j.id} onToggle={() => setOpenId(id => (id === j.id ? null : j.id))} />
      ))}
      {sorted.length === 0 && <div style={{ padding: '44px 0', textAlign: 'center', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>No jobs yet — run one to see it here.</div>}
    </div>
  );
}

/* ── Inspector slide-over ── */
interface InspectorProps {
  job: Job | null;
  lanes: Lane[];
  nowMs: number;
  onClose: () => void;
  onCancel: (job: Job) => void;
}

function Inspector({ job, lanes, nowMs, onClose, onCancel }: InspectorProps) {
  const navigate = useNavigate();
  if (!job) return null;
  const lane = laneOf(lanes, job.lane);
  const m = STATUS_META[job.status];
  const cost = job.status === 'running' ? job._liveCost ?? job.cost : job.cost;
  const elapsedMs = (job.endMs ?? nowMs) - job.startMs;
  const out = (job.output || '').trim();
  const tail = out.length > 6000 ? '…' + out.slice(-6000) : out;
  const modelShort = job.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const openTranscript = () => {
    if (job.sessionId) navigate(`/project-detail/${job.lane}?s=${job.sessionId}`);
    else navigate(`/session-transcript/${job.id}`);
  };
  return (
    <div className="inspector inspector-in" data-open="true" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 400, zIndex: 40,
      background: 'var(--bg-elevated)',
      borderLeft: '0.5px solid var(--separator)', boxShadow: '-12px 0 40px rgba(10,15,40,0.18)', display: 'flex', flexDirection: 'column' }}>
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

      <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
        {/* chips: real effort + engine/model */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Tag icon="bolt" tint={EFFORT_TINT[job.effort]}>{job.effort}</Tag>
          <Tag icon="terminal" tint="var(--ink-secondary)">{job.engine === 'codex' ? 'Codex' : 'Claude Code'}{modelShort ? ` · ${modelShort}` : ''}</Tag>
        </div>

        {/* real run stats */}
        <div style={{ display: 'flex', gap: 10 }}>
          <Stat label="Cost" value={cost > 0 ? `$${cost.toFixed(2)}` : '—'} />
          <Stat label="Tokens" value={job.tokens > 0 ? job.tokens.toLocaleString() : '—'} />
          <Stat label={job.status === 'running' ? 'Elapsed' : 'Duration'} value={fmtDur(Math.max(0, elapsedMs))} />
        </div>

        {/* real output preview */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Label>{job.status === 'running' ? 'Live output' : 'Output'}</Label>
          <div className="inspector" style={{ flex: 1, minHeight: 120, overflowY: 'auto', background: 'var(--bg-grouped)', borderRadius: 10, border: '0.5px solid var(--separator)', padding: '12px 14px',
            font: '400 var(--fs-footnote)/1.55 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {tail ? tail : <span style={{ color: 'var(--ink-tertiary)' }}>{job.last || (job.status === 'running' ? 'Working…' : 'No output recorded.')}</span>}
            {job.status === 'running' && <span className="cursor-blink" style={{ marginLeft: 2, color: m.tint }}>▍</span>}
          </div>
        </div>
      </div>

      {/* actions */}
      <div style={{ display: 'flex', gap: 10, padding: 16, borderTop: '0.5px solid var(--separator)' }}>
        <button onClick={openTranscript} className="primary-cta" style={{ flex: 1, height: 42, borderRadius: 'var(--r-pill)', cursor: 'pointer', border: 'none',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>
          <Icon name={job.sessionId ? 'command' : 'terminal'} size={16} /> {job.sessionId ? 'Open chat' : 'Open transcript'}
        </button>
        {job.status === 'running' && (
          <button onClick={() => onCancel(job)} className="cancel-btn" style={{ height: 42, padding: '0 18px', borderRadius: 'var(--r-pill)',
            background: 'rgba(255,59,48,0.12)', color: 'var(--red)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
        )}
      </div>
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
            “{job.name}” will stop immediately on this Mac. Partial output so far is kept; the run won’t continue.
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
  const [view, setView] = React.useState('list');
  const [filter, setFilter] = React.useState('all');
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [lanes, setLanes] = React.useState<Lane[]>([]);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const [sel, setSel] = React.useState<Job | null>(null);
  const [cancelJob, setCancelJob] = React.useState<Job | null>(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  // live load: projects → swim-lanes, jobs → timeline. Re-runnable for refetch.
  const refetch = React.useCallback(async () => {
    try {
      const [apiProjects, apiJobs] = await Promise.all([api.listProjects(), api.listJobs()]);
      setLanes(lanesFromProjects(apiProjects));
      const mapped = apiJobs.map(mapApiJob);
      setJobs(mapped);
      // keep the open inspector live (cost/output/status) as job events stream in
      setSel(s => s ? (mapped.find(x => x.id === s.id) ?? null) : null);
    } catch {
      /* fail soft — leave whatever we have */
    }
  }, []);

  React.useEffect(() => { void refetch(); }, [refetch]);

  // LIVE: SSE job updates → refetch the board
  React.useEffect(() => {
    const unsubscribe = api.subscribe({ onJob: () => { void refetch(); } });
    return unsubscribe;
  }, [refetch]);

  // real now-line: advance the wall clock so running capsules + elapsed tick
  React.useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 5000);
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
    // Real cancel: abort the run on the Mac. The job event refetches the board
    // into its true 'cancelled' state; optimistically reflect it meanwhile.
    setJobs(js => js.map(j => j.id === job.id ? { ...j, status: 'cancelled', endMs: Date.now(), last: 'cancelling…' } : j));
    setSel(s => s && s.id === job.id ? { ...s, status: 'cancelled', last: 'cancelling…' } : s);
    void api.cancelJob(job.id).catch(() => { void refetch(); });
  };

  return (
    <AppShell active="jobs" onSearch={() => setPaletteOpen(true)}>
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
            options={[{ key: 'list', label: 'Activity', icon: 'jobs' }, { key: 'timeline', label: 'Timeline', icon: 'sliders' }]} />
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
            ? <Timeline jobs={shown} lanes={lanes} nowMs={nowMs} onSelect={setSel} selectedId={sel ? sel.id : null} />
            : <ActivityList jobs={shown} lanes={lanes} nowMs={nowMs} onCancel={setCancelJob} />}
        </div>
      </main>

      <Inspector job={sel} lanes={lanes} nowMs={nowMs} onClose={() => setSel(null)} onCancel={setCancelJob} />
      <CancelSheet job={cancelJob} onClose={() => setCancelJob(null)} onConfirm={doCancel} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
