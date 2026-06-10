/* Scheduler — durable per-project cron. Week calendar + list views with a
   live now-line, a frosted new/edit schedule sheet, and the ⌘K palette.
   Ported from the design prototype (sc-app / sc-calendar / sc-list / sc-sheet)
   to an ES-module TypeScript React screen. Visual output is unchanged.

   The prototype's WindowFrame + Sidebar + Toolbar chrome maps onto the shared
   <AppShell>; cross-page location.href navigation is handled by AppShell's
   react-router useNavigate. Segmented and CommandPalette are not exported by
   the shared library, so they are inlined here. */

import React from 'react';
import { Icon, type IconName } from '../lib/icons';
import { Switch } from '../lib/ui';
import { AppShell } from '../lib/appShell';
import { api, type Schedule, type Project } from '../lib/api';

// page-specific CSS lifted from Scheduler.html <style> (hover/animation hooks)
const SCHEDULER_CSS = `
  .link-btn:hover { text-decoration: underline; }
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .step-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 55%, var(--ink) 8%); }
  .sched-chip { transition: transform 120ms var(--spring), box-shadow 140ms ease, filter 140ms ease; cursor: pointer; }
  .sched-chip:hover { transform: translateY(-1px); box-shadow: var(--card-shadow); filter: brightness(1.02); z-index: 6; }
  .sched-row:hover { background: var(--fill-tertiary); }
  .sheet-pick:hover { background: var(--fill-tertiary); }
  .sel { cursor: pointer; -webkit-appearance: none; appearance: none; }

  /* parse line gentle morph (frozen-clock-safe) */
  .parse-line { animation: parseMorph 320ms var(--spring); }
  @keyframes parseMorph { from { transform: translateY(-2px); } to { transform: none; } }

  /* sheet + palette — frozen-clock-safe */
  .sheet-pop { animation: sheetPop 220ms var(--spring); }
  @keyframes sheetPop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }

  .cal-scroll::-webkit-scrollbar { width: 9px; height: 9px; }
`;

// ──────────────────────────────────────────────────────────────────────────
// Data model + helpers (sc-calendar / sc-list)
// ──────────────────────────────────────────────────────────────────────────

interface ProjMeta { name: string; color: string }

const SCHED_PROJ: Record<string, ProjMeta> = {
  atlas:   { name: 'Atlas API',     color: 'var(--blue)' },
  content: { name: 'Q3 Content',    color: 'var(--purple)' },
  scan:    { name: 'Market Scan',   color: 'var(--indigo)' },
  brand:   { name: 'Brand Refresh', color: 'var(--teal)' },
  infra:   { name: 'Infra / CI',    color: 'var(--orange)' },
};

// week: Mon Jun 15 – Sun Jun 21 2026, today = Wed (idx 2)
const WEEK_DAYS = [
  { d: 'Mon', n: 15 }, { d: 'Tue', n: 16 }, { d: 'Wed', n: 17 }, { d: 'Thu', n: 18 },
  { d: 'Fri', n: 19 }, { d: 'Sat', n: 20 }, { d: 'Sun', n: 21 },
];
const TODAY_IDX = 2;
const GRID_START = 6, GRID_END = 22, ROW_H = 48; // hours 6..22

interface SchedRule {
  id: string;
  proj: string;
  name: string;
  time: number;
  days: number[];
  trig: 'clock' | 'webhook';
}

// recurring rules → expand to week occurrences
const SCHED_RULES: SchedRule[] = [
  { id: 'r1', proj: 'atlas',   name: 'Dependency audit',  time: 6.0,  days: [0,1,2,3,4,5,6], trig: 'clock' },
  { id: 'r2', proj: 'content', name: 'Weekly report',     time: 8.0,  days: [0],             trig: 'clock' },
  { id: 'r3', proj: 'scan',    name: 'Market open scan',  time: 9.5,  days: [0,1,2,3,4],     trig: 'clock' },
  { id: 'r4', proj: 'infra',   name: 'CI hardening',      time: 11.0, days: [1,3],           trig: 'webhook' },
  { id: 'r5', proj: 'scan',    name: 'Competitor digest', time: 14.0, days: [0,1,2,3,4,5,6], trig: 'clock' },
  { id: 'r6', proj: 'content', name: 'Newsletter draft',  time: 16.5, days: [0,2,4],         trig: 'clock' },
  { id: 'r7', proj: 'atlas',   name: 'Nightly tests',     time: 18.0, days: [0,1,2,3,4,5,6], trig: 'clock' },
  { id: 'r8', proj: 'brand',   name: 'Asset backup',      time: 21.0, days: [0,1,2,3,4,5,6], trig: 'clock' },
];

interface SchedEvent extends SchedRule { day: number; missed: boolean }

function expandWeek(): SchedEvent[] {
  const ev: SchedEvent[] = [];
  SCHED_RULES.forEach(r => r.days.forEach(day => {
    // market scan on Tue (day1) was missed (machine asleep)
    const missed = (r.id === 'r3' && day === 1);
    ev.push({ ...r, day, missed });
  }));
  return ev;
}

function fmtHour(h: number): string {
  const hh = Math.floor(h);
  const ampm = hh < 12 ? 'AM' : 'PM';
  const disp = hh % 12 === 0 ? 12 : hh % 12;
  return `${disp} ${ampm}`;
}
function fmtTime(t: number): string {
  const hh = Math.floor(t), mm = Math.round((t - hh) * 60);
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Calendar view (sc-calendar)
// ──────────────────────────────────────────────────────────────────────────

interface CalendarViewProps { nowTime: number; onPick: (e: SchedEvent) => void }

function CalendarView({ nowTime, onPick }: CalendarViewProps) {
  const events = React.useMemo(expandWeek, []);
  const hours: number[] = [];
  for (let h = GRID_START; h <= GRID_END; h++) hours.push(h);
  const nowTop = (nowTime - GRID_START) * ROW_H;

  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden', boxShadow: 'var(--card-shadow)',
      display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* day header row */}
      <div style={{ display: 'grid', gridTemplateColumns: `56px repeat(7, 1fr)`, borderBottom: '0.5px solid var(--separator)', flexShrink: 0 }}>
        <div style={{ borderRight: '0.5px solid var(--separator)' }} />
        {WEEK_DAYS.map((d, i) => {
          const today = i === TODAY_IDX;
          return (
            <div key={i} style={{ padding: '10px 0', textAlign: 'center', borderRight: i < 6 ? '0.5px solid var(--separator)' : 'none' }}>
              <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: today ? 'var(--red)' : 'var(--ink-tertiary)', marginBottom: 6 }}>{d.d}</div>
              <div style={{ width: 28, height: 28, margin: '0 auto', borderRadius: '50%', display: 'grid', placeItems: 'center',
                background: today ? 'var(--red)' : 'transparent', color: today ? '#fff' : 'var(--ink)', font: `${today ? 700 : 600} var(--fs-callout)/1 var(--font-text)` }}>{d.n}</div>
            </div>
          );
        })}
      </div>

      {/* scroll grid */}
      <div style={{ flex: 1, overflowY: 'auto' }} className="cal-scroll">
        <div style={{ display: 'grid', gridTemplateColumns: `56px repeat(7, 1fr)`, position: 'relative' }}>
          {/* hour gutter */}
          <div style={{ borderRight: '0.5px solid var(--separator)' }}>
            {hours.map(h => (
              <div key={h} style={{ height: ROW_H, position: 'relative' }}>
                <span style={{ position: 'absolute', top: -7, right: 8, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{h === GRID_START ? '' : fmtHour(h)}</span>
              </div>
            ))}
          </div>

          {/* day columns */}
          {WEEK_DAYS.map((d, di) => (
            <div key={di} style={{ position: 'relative', borderRight: di < 6 ? '0.5px solid var(--separator)' : 'none',
              background: di === TODAY_IDX ? 'color-mix(in srgb, var(--red) 3%, transparent)' : 'transparent' }}>
              {/* hour lines */}
              {hours.map(h => <div key={h} style={{ height: ROW_H, borderBottom: '0.5px solid var(--separator)' }} />)}
              {/* events */}
              {events.filter(e => e.day === di).map((e, i) => {
                const p = SCHED_PROJ[e.proj];
                const top = (e.time - GRID_START) * ROW_H;
                return (
                  <button key={i} onClick={() => onPick(e)} className="sched-chip" style={{
                    position: 'absolute', top: top + 2, left: 3, right: 3, height: 30, borderRadius: 7, display: 'flex', alignItems: 'center', gap: 5, padding: '0 7px',
                    background: e.missed ? 'transparent' : `color-mix(in srgb, ${p.color} 14%, var(--bg-elevated))`,
                    border: e.missed ? '1.5px dashed var(--orange)' : `1px solid color-mix(in srgb, ${p.color} 35%, transparent)`,
                    borderLeft: e.missed ? '1.5px dashed var(--orange)' : `3px solid ${p.color}`, textAlign: 'left', overflow: 'hidden' }}
                    title={e.missed ? 'Missed — fired on wake (policy: fire-now)' : `${e.name} · ${fmtTime(e.time)}`}>
                    <Icon name={e.missed ? 'alert' : (e.trig === 'webhook' ? 'bolt' : 'clock')} size={11} style={{ color: e.missed ? 'var(--orange)' : p.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-caption)/1.1 var(--font-text)', color: e.missed ? 'var(--orange)' : 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.name}</span>
                  </button>
                );
              })}
            </div>
          ))}

          {/* red now-line across grid (today) */}
          <div className="cal-nowline" style={{ position: 'absolute', left: 56, right: 0, top: nowTop, height: 0, zIndex: 5, pointerEvents: 'none' }}>
            <div style={{ position: 'relative', borderTop: '1.5px solid var(--red)' }}>
              <span style={{ position: 'absolute', left: `calc(${TODAY_IDX} / 7 * 100%)`, top: -4, width: 9, height: 9, borderRadius: '50%', background: 'var(--red)' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// List view (sc-list)
// ──────────────────────────────────────────────────────────────────────────

interface SchedRow {
  id: string;
  proj: string;
  name: string;
  cron: string;
  next: string;
  conc: number;
  misfire: string;
  paused: boolean;
  blocked?: boolean;
}

function MisfireChip({ policy }: { policy: string }) {
  const tint = ({ 'Fire now': 'var(--blue)', 'Skip': 'var(--ink-secondary)', 'Coalesce': 'var(--teal)' } as Record<string, string>)[policy];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)',
      background: `color-mix(in srgb, ${tint} 12%, transparent)`, color: tint, font: '600 var(--fs-caption)/1 var(--font-text)', whiteSpace: 'nowrap' }}>
      <Icon name="refresh" size={11} /> {policy}
    </span>
  );
}

interface ScheduleRowProps { s: SchedRow; last: boolean; onPick: (s: SchedRow) => void; projMeta: ProjMeta; onToggle: (id: string, nextEnabled: boolean) => void }

function ScheduleRow({ s, last, onPick, projMeta, onToggle }: ScheduleRowProps) {
  const [paused, setPaused] = React.useState(s.paused);
  React.useEffect(() => { setPaused(s.paused); }, [s.paused]);
  const p = projMeta;
  return (
    <div className="sched-row" onClick={() => onPick(s)} style={{ display: 'grid', gridTemplateColumns: '1.7fr 1.5fr 1fr 0.9fr 1.1fr 60px', alignItems: 'center', gap: 14,
      padding: '13px 16px', borderBottom: last ? 'none' : '0.5px solid var(--separator)', cursor: 'pointer', opacity: paused ? 0.6 : 1, transition: 'opacity 200ms ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span style={{ width: 9, height: 9, borderRadius: 5, background: p.color, flexShrink: 0 }} />
        <span style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
      </div>
      <span style={{ font: '400 var(--fs-subhead)/1.2 var(--font-text)', color: 'var(--ink-secondary)' }}>{s.cron}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {s.blocked
          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)', background: 'rgba(255,59,48,0.14)', color: 'var(--red)', font: '600 var(--fs-caption)/1 var(--font-text)' }}><Icon name="lock" size={11} /> Blocked — cap</span>
          : <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', whiteSpace: 'nowrap', color: paused ? 'var(--ink-tertiary)' : 'var(--ink)' }}>{s.next.startsWith('in') ? s.next : `in ${s.next}`}</span>}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
        <Icon name="layers" size={13} style={{ color: 'var(--ink-tertiary)' }} /> {s.conc}×
      </span>
      <span><MisfireChip policy={s.misfire} /></span>
      <span style={{ display: 'flex', justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
        <Switch on={!paused} onChange={v => { setPaused(!v); onToggle(s.id, v); }} />
      </span>
    </div>
  );
}

interface ListViewProps { onPick: (s: SchedRow) => void; rows: SchedRow[]; projMeta: Record<string, ProjMeta>; onToggle: (id: string, nextEnabled: boolean) => void }

function ListView({ onPick, rows: allRows, projMeta, onToggle }: ListViewProps) {
  const fallbackMeta: ProjMeta = { name: 'Workspace', color: 'var(--ink-tertiary)' };
  const byProj: Record<string, SchedRow[]> = {};
  allRows.forEach(s => { (byProj[s.proj] = byProj[s.proj] || []).push(s); });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {Object.entries(byProj).map(([proj, rows]) => {
        const p = projMeta[proj] ?? fallbackMeta;
        return (
          <div key={proj}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11, padding: '0 2px' }}>
              <span style={{ width: 9, height: 9, borderRadius: 5, background: p.color }} />
              <span style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>{p.name}</span>
              <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>· {rows.length}</span>
            </div>
            <div style={{ background: 'var(--bg-grouped)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden',
              backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
              {rows.map((s, i) => <ScheduleRow key={s.id} s={s} last={i === rows.length - 1} onPick={onPick} projMeta={p} onToggle={onToggle} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// New/Edit schedule sheet (sc-sheet)
// ──────────────────────────────────────────────────────────────────────────

interface ParsedWhen { time: string; cron: string; summary: string; label: string }

// tiny natural-language → cron parser (demo-grade)
function parseWhen(text: string): ParsedWhen {
  const t = text.toLowerCase().trim();
  const dayMap: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  let time = '09:00', cron = '0 9 * * *', summary = 'Every day at 09:00';
  const tm = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  let hh = 9, mm = 0;
  if (tm) {
    hh = parseInt(tm[1], 10); mm = tm[2] ? parseInt(tm[2], 10) : 0;
    if (tm[3] === 'pm' && hh < 12) hh += 12;
    if (tm[3] === 'am' && hh === 12) hh = 0;
  }
  time = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  let dayPart = '*', label = 'Every day';
  if (/weekday|every weekday|mon-fri|monday to friday/.test(t)) { dayPart = '1-5'; label = 'Weekdays'; }
  else {
    const found = Object.keys(dayMap).filter(k => t.includes(k));
    if (found.length) {
      const dayNum: Record<string, number> = { sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6 };
      dayPart = found.map(k => dayNum[k]).join(',');
      label = found.map(k => dayMap[k]).join(', ');
    }
  }
  cron = `${mm} ${hh} * * ${dayPart}`;
  summary = `${label} at ${time}`;
  return { time, cron, summary, label };
}

function SheetSection({ n, title, children }: { n: string; title: string; children?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ width: 20, height: 20, borderRadius: 6, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '700 var(--fs-caption)/1 var(--font-mono)' }}>{n}</span>
        <span style={{ font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

interface StepperProps { value: number; set: (v: number) => void; min?: number; max?: number; suffix?: string }

function Stepper({ value, set, min = 0, max = 10, suffix }: StepperProps) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, background: 'var(--fill-secondary)', borderRadius: 9 }}>
      <button onClick={() => set(Math.max(min, value - 1))} className="step-btn" style={{ width: 30, height: 30, borderRadius: 7, display: 'grid', placeItems: 'center', color: 'var(--ink)', font: '600 18px/1 var(--font-text)' }}>−</button>
      <span style={{ minWidth: 46, textAlign: 'center', font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)' }}>{value}{suffix}</span>
      <button onClick={() => set(Math.min(max, value + 1))} className="step-btn" style={{ width: 30, height: 30, borderRadius: 7, display: 'grid', placeItems: 'center', color: 'var(--ink)', font: '600 18px/1 var(--font-text)' }}>+</button>
    </div>
  );
}

function SheetPick({ icon, label, value, tint, last }: { icon: IconName; label: string; value: string; tint: string; last?: boolean }) {
  return (
    <button className="sheet-pick" style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 52, padding: '10px 14px', textAlign: 'left',
      borderBottom: last ? 'none' : '0.5px solid var(--separator)' }}>
      <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${tint} 14%, transparent)`, color: tint }}><Icon name={icon} size={16} /></span>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 3 }}>{label}</span>
        <span style={{ display: 'block', font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>{value}</span>
      </span>
      <Icon name="chevronDown" size={16} style={{ color: 'var(--ink-tertiary)' }} />
    </button>
  );
}

interface ScheduleSheetProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: { title: string; time: string; cadence: string }) => void;
  initial: SchedEvent | SchedRow | null;
}

function ScheduleSheet({ open, onClose, onSave }: ScheduleSheetProps) {
  const [when, setWhen] = React.useState('every weekday 9am');
  const [advanced, setAdvanced] = React.useState(false);
  const [misfire, setMisfire] = React.useState('fire');
  const [retries, setRetries] = React.useState(2);
  const [backoff, setBackoff] = React.useState('Exponential');
  const [conc, setConc] = React.useState(1);
  const [cap, setCap] = React.useState<string | number>(0.5);
  React.useEffect(() => { if (open) { setWhen('every weekday 9am'); setAdvanced(false); setMisfire('fire'); setRetries(2); setConc(1); setCap(0.5); } }, [open]);
  if (!open) return null;

  const parsed = parseWhen(when);
  const perMonthRuns = parsed.label === 'Weekdays' ? 22 : parsed.label === 'Every day' ? 30 : 4;
  const monthly = (0.18 * perMonthRuns).toFixed(2);
  const misfireOpts = [
    { key: 'fire', label: 'Fire now', hint: 'Run immediately when the Mac wakes.' },
    { key: 'skip', label: 'Skip', hint: 'Drop the missed run; wait for the next.' },
    { key: 'coalesce', label: 'Coalesce', hint: 'Collapse multiple misses into one run.' },
  ];
  const mi = misfireOpts.findIndex(o => o.key === misfire);

  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32,
      background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 520, maxHeight: '100%', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated)', borderRadius: 20, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', overflow: 'hidden' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '18px 20px', borderBottom: '0.5px solid var(--separator)' }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, font: '700 var(--fs-title2)/1.1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>New schedule</h2>
            <p style={{ margin: '3px 0 0', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Durable — it survives sleep, restarts, and resumes from checkpoint.</p>
          </div>
          <button onClick={onClose} className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="x" size={18} /></button>
        </div>

        <div style={{ padding: 20, overflowY: 'auto' }}>
          {/* 1 project + template */}
          <SheetSection n="1" title="Project & job">
            <div style={{ background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)', overflow: 'hidden' }}>
              <SheetPick icon="layers" label="Project" value="Atlas API" tint="var(--blue)" />
              <SheetPick icon="terminal" label="Job template" value="Nightly tests" tint="var(--purple)" last />
            </div>
          </SheetSection>

          {/* 2 when */}
          <SheetSection n="2" title="When">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 46, padding: '0 14px', background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)' }}>
              <Icon name="calendar" size={17} style={{ color: 'var(--ink-tertiary)', flexShrink: 0 }} />
              <input value={when} onChange={e => setWhen(e.target.value)} placeholder="every Monday 9am"
                style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }} />
            </div>
            <div className="parse-line" key={parsed.summary} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, padding: '0 4px' }}>
              <Icon name="check" size={14} stroke={2.6} style={{ color: 'var(--green)', flexShrink: 0 }} />
              <span style={{ font: '500 var(--fs-footnote)/1.3 var(--font-mono)', whiteSpace: 'nowrap', color: 'var(--ink-secondary)' }}>{parsed.summary} · next: 17 Jun</span>
            </div>
            <button onClick={() => setAdvanced(a => !a)} className="link-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 10, font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)' }}>
              <Icon name="chevronRight" size={13} style={{ transform: advanced ? 'rotate(90deg)' : 'none', transition: 'transform 180ms var(--spring)' }} /> Advanced cron
            </button>
            {advanced && (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, height: 42, padding: '0 14px', background: 'var(--fill-tertiary)', borderRadius: 10, border: '0.5px solid var(--separator)' }}>
                <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>cron</span>
                <input defaultValue={parsed.cron} key={parsed.cron} style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: '500 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)' }} />
              </div>
            )}
          </SheetSection>

          {/* 3 durability */}
          <SheetSection n="3" title="Durability">
            <div style={{ background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)', padding: 14 }}>
              <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 9 }}>Misfire policy</div>
              <div style={{ position: 'relative', display: 'flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 9, marginBottom: 8 }}>
                <div style={{ position: 'absolute', top: 2, bottom: 2, left: `calc(${mi} * (100% - 4px) / 3 + 2px)`, width: `calc((100% - 4px) / 3)`, background: 'var(--bg-elevated)', borderRadius: 7, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 240ms var(--spring)' }} />
                {misfireOpts.map(o => (
                  <button key={o.key} onClick={() => setMisfire(o.key)} style={{ flex: 1, position: 'relative', zIndex: 1, padding: '7px 0', font: '600 var(--fs-footnote)/1 var(--font-text)', color: misfire === o.key ? 'var(--ink)' : 'var(--ink-secondary)' }}>{o.label}</button>
                ))}
              </div>
              <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 16 }}>{misfireOpts[mi].hint}</div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 14, borderTop: '0.5px solid var(--separator)' }}>
                <span style={{ flex: 1, font: '500 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>Retries</span>
                <Stepper value={retries} set={setRetries} min={0} max={5} />
                <select value={backoff} onChange={e => setBackoff(e.target.value)} className="sel" style={{ height: 34, padding: '0 10px', borderRadius: 8, border: '0.5px solid var(--separator)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '500 var(--fs-footnote)/1 var(--font-text)' }}>
                  <option>Exponential</option><option>Linear</option><option>Fixed</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
                <span style={{ flex: 1, font: '500 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>Concurrency limit</span>
                <Stepper value={conc} set={setConc} min={1} max={8} />
              </div>
            </div>
          </SheetSection>

          {/* 4 budget */}
          <SheetSection n="4" title="Budget">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 46, padding: '0 14px', background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)' }}>
              <span style={{ font: '500 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)', flex: 1 }}>Per-run cap</span>
              <span style={{ font: '500 22px/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>$</span>
              <input value={cap} onChange={e => setCap(e.target.value)} style={{ width: 56, border: 'none', outline: 'none', background: 'transparent', textAlign: 'right', font: '600 22px/1 var(--font-mono)', color: 'var(--ink)' }} />
            </div>
            <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 8, padding: '0 4px' }}>Project has <b style={{ color: 'var(--ink)', fontWeight: 600 }}>$31.40</b> left this month.</div>
          </SheetSection>
        </div>

        {/* footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderTop: '0.5px solid var(--separator)' }}>
          <div style={{ flex: 1, font: '500 var(--fs-footnote)/1.3 var(--font-mono)', color: 'var(--ink-secondary)' }}>
            ≈ <b style={{ color: 'var(--ink)', fontWeight: 600 }}>$0.18</b>/run · ≈ <b style={{ color: 'var(--ink)', fontWeight: 600 }}>${monthly}</b>/mo
          </div>
          <button onClick={onClose} style={{ height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={() => onSave({ title: parsed.summary, time: parsed.time, cadence: parsed.label })} className="primary-cta" style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Save schedule</button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Segmented control (inlined from pj-cards — not exported by the shared lib)
// ──────────────────────────────────────────────────────────────────────────

interface SegmentedOption { key: string; label: string; icon: IconName }

function Segmented({ value, onChange, options }: { value: string; onChange: (key: string) => void; options: SegmentedOption[] }) {
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
  { group: 'Recent', icon: 'send', label: 'Publish "Launch week" thread', hint: 'Q3 Content' },
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
// Scheduler page root (sc-app)
// ──────────────────────────────────────────────────────────────────────────

// derive a human cron line from the API's time + cadence fields
function cronLine(s: Schedule): string {
  const cad = (s.cadence || '').trim();
  const time = (s.time || '').trim();
  if (!cad && !time) return 'On demand';
  if (!time) return cad;
  if (!cad || /every\s*day/i.test(cad) || cad === '*') return `Every day at ${time}`;
  return `${cad} at ${time}`;
}

// derive a relative "next run" string from the API's nextRun timestamp
function nextLine(nextRun: number | null): string {
  if (!nextRun) return '—';
  const ms = nextRun - Date.now();
  if (ms <= 0) return 'in 7m';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

export default function Scheduler() {
  const [view, setView] = React.useState('calendar');
  const [nowTime, setNowTime] = React.useState(14.62); // 14:37
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<SchedEvent | SchedRow | null>(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [schedules, setSchedules] = React.useState<Schedule[]>([]);
  const [projects, setProjects] = React.useState<Project[]>([]);

  const loadSchedules = React.useCallback(async () => {
    try {
      const list = await api.listSchedules();
      setSchedules(list);
    } catch { /* fail soft — leave empty */ }
  }, []);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [sched, projs] = await Promise.all([api.listSchedules(), api.listProjects()]);
        if (!alive) return;
        setSchedules(sched);
        setProjects(projs);
      } catch { /* fail soft — leave empty */ }
    })();
    return () => { alive = false; };
  }, []);

  // project meta keyed by projectId (color name -> var(--name)); '' = unassigned
  const projMeta = React.useMemo<Record<string, ProjMeta>>(() => {
    const m: Record<string, ProjMeta> = {};
    projects.forEach(p => { m[p.id] = { name: p.name, color: `var(--${p.color})` }; });
    return m;
  }, [projects]);

  // adapt live schedules into the existing SchedRow shape the list renders
  const rows = React.useMemo<SchedRow[]>(() => schedules.map(s => ({
    id: s.id,
    proj: s.projectId ?? '',
    name: s.title,
    cron: cronLine(s),
    next: nextLine(s.nextRun),
    conc: 1,
    misfire: 'Fire now',
    paused: !s.enabled,
  })), [schedules]);

  const onToggle = React.useCallback(async (id: string, nextEnabled: boolean) => {
    setSchedules(prev => prev.map(s => s.id === id ? { ...s, enabled: nextEnabled } : s));
    try {
      await api.toggleSchedule(id, nextEnabled);
    } catch {
      // revert on failure
      setSchedules(prev => prev.map(s => s.id === id ? { ...s, enabled: !nextEnabled } : s));
    }
  }, []);

  const onCreateSchedule = React.useCallback(async (data: { title: string; time: string; cadence: string }) => {
    setSheetOpen(false);
    try {
      await api.createSchedule(data);
      await loadSchedules();
    } catch { /* fail soft */ }
  }, [loadSchedules]);

  // live now-line
  React.useEffect(() => {
    const t = setInterval(() => setNowTime(n => (n < 21.9 ? +(n + 0.0025).toFixed(4) : n)), 1500);
    return () => clearInterval(t);
  }, []);
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const openNew = () => { setEditing(null); setSheetOpen(true); };
  const openEdit = (s: SchedEvent | SchedRow) => { setEditing(s); setSheetOpen(true); };

  return (
    <AppShell active="scheduler" budget={{ spent: 38.20, cap: 200, animateKey: 0 }} onSearch={() => setPaletteOpen(true)}>
      <style>{SCHEDULER_CSS}</style>

      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '24px 28px 0' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 6 }}>
          <div>
            <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Scheduler</h1>
          </div>
          <span style={{ flex: 1 }} />
          <Segmented value={view} onChange={setView} options={[{ key: 'calendar', label: 'Calendar', icon: 'calendar' }, { key: 'list', label: 'List', icon: 'jobs' }]} />
          <button onClick={openNew} className="primary-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)',
            background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.30)' }}>
            <Icon name="plus" size={16} stroke={2.4} /> New schedule
          </button>
        </div>
        {/* durability reassurance */}
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 18, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>
          <Icon name="shield" size={14} style={{ color: 'var(--green)' }} />
          Schedules run even while you sleep — if the Mac sleeps too, the job resumes from checkpoint on wake.
        </div>

        {/* body */}
        <div style={{ flex: 1, minHeight: 0, overflowY: view === 'list' ? 'auto' : 'hidden', paddingBottom: view === 'list' ? 28 : 0 }}>
          {view === 'calendar'
            ? <CalendarView nowTime={nowTime} onPick={openEdit} />
            : <ListView onPick={openEdit} rows={rows} projMeta={projMeta} onToggle={onToggle} />}
        </div>
      </div>

      <ScheduleSheet open={sheetOpen} onClose={() => setSheetOpen(false)} onSave={onCreateSchedule} initial={editing} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
