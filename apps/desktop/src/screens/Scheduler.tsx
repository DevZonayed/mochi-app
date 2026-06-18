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
import { api, type Schedule, type Project, type ChatSession } from '../lib/api';

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

  .cal-scroll::-webkit-scrollbar { width: 11px; height: 11px; }
`;

// ──────────────────────────────────────────────────────────────────────────
// Data model + helpers (sc-calendar / sc-list)
// ──────────────────────────────────────────────────────────────────────────

interface ProjMeta { name: string; color: string }

// Grid: a vertical hour scale at ROW_H px/hour. The window defaults to
// 06:00–22:00 and widens to include any schedule that falls outside it.
const ROW_H = 48;
const DEFAULT_GRID_START = 6, DEFAULT_GRID_END = 22;
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

interface WeekDay { d: string; n: number }

// The real current week (Mon..Sun containing today) + which column is today.
function buildWeek(): { weekDays: WeekDay[]; todayIdx: number } {
  const now = new Date();
  const todayIdx = (now.getDay() + 6) % 7; // Mon=0 .. Sun=6
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - todayIdx);
  const weekDays = WEEKDAY_LABELS.map((d, i) => {
    const dt = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return { d, n: dt.getDate() };
  });
  return { weekDays, todayIdx };
}

// 'HH:MM' → hour as a float (9.5 = 09:30); null when empty/unparseable.
function timeToHour(time: string): number | null {
  const m = (time || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h > 23 || mm > 59) return null;
  return h + mm / 60;
}

/* Which grid columns (Mon=0..Sun=6) a schedule fires on — mirrors the cron
   runner's cadenceDays() exactly so the calendar matches when jobs actually
   run. JS getDay() for column `col` is (col+1)%7 (Mon=1..Sat=6, Sun=0). */
function cadenceColumns(s: Schedule): number[] {
  const c = (s.cadence || '').toLowerCase().trim();
  let days: Set<number> | null;
  if (!c || c === '*' || c === 'daily' || /every\s*day/.test(c)) days = null;
  else if (c === 'weekly') days = new Set([new Date(s.createdAt).getDay()]);
  else if (/weekday|mon\s*-\s*fri|monday to friday/.test(c)) days = new Set([1, 2, 3, 4, 5]);
  else if (/weekend/.test(c)) days = new Set([0, 6]);
  else {
    const map: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const d = Object.keys(map).filter(k => c.includes(k)).map(k => map[k]);
    days = d.length ? new Set(d) : null;
  }
  const cols: number[] = [];
  for (let col = 0; col < 7; col++) { if (!days || days.has((col + 1) % 7)) cols.push(col); }
  return cols;
}

// One placed chip: a live schedule on a specific day-column at a specific hour.
interface CalOccurrence { schedule: Schedule; col: number; hour: number }

function expandSchedules(schedules: Schedule[]): CalOccurrence[] {
  const out: CalOccurrence[] = [];
  schedules.forEach(s => {
    const hour = timeToHour(s.time);
    if (hour == null) return; // on-demand / no time → not placeable on the grid
    cadenceColumns(s).forEach(col => out.push({ schedule: s, col, hour }));
  });
  return out;
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

interface CalendarViewProps { schedules: Schedule[]; projMeta: Record<string, ProjMeta>; onPick: (s: Schedule) => void }

function CalendarView({ schedules, projMeta, onPick }: CalendarViewProps) {
  const { weekDays, todayIdx } = React.useMemo(buildWeek, []);
  const occ = React.useMemo(() => expandSchedules(schedules), [schedules]);
  // widen the visible window to include any schedule outside the 6–22 default
  const gridStart = React.useMemo(() => Math.max(0, occ.reduce((a, o) => Math.min(a, Math.floor(o.hour)), DEFAULT_GRID_START)), [occ]);
  const gridEnd = React.useMemo(() => Math.min(23, occ.reduce((a, o) => Math.max(a, Math.ceil(o.hour)), DEFAULT_GRID_END)), [occ]);
  const hours: number[] = [];
  for (let h = gridStart; h <= gridEnd; h++) hours.push(h);

  // real wall-clock now-line, ticked every 30s
  const [nowHour, setNowHour] = React.useState(() => { const n = new Date(); return n.getHours() + n.getMinutes() / 60; });
  React.useEffect(() => {
    const tick = () => { const n = new Date(); setNowHour(n.getHours() + n.getMinutes() / 60); };
    const t = setInterval(tick, 30000);
    return () => clearInterval(t);
  }, []);
  const nowVisible = nowHour >= gridStart && nowHour <= gridEnd;
  const nowTop = (nowHour - gridStart) * ROW_H;
  const fallback: ProjMeta = { name: 'Workspace', color: 'var(--ink-tertiary)' };

  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden', boxShadow: 'var(--card-shadow)',
      display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* day header row */}
      <div style={{ display: 'grid', gridTemplateColumns: `56px repeat(7, 1fr)`, borderBottom: '0.5px solid var(--separator)', flexShrink: 0 }}>
        <div style={{ borderRight: '0.5px solid var(--separator)' }} />
        {weekDays.map((d, i) => {
          const today = i === todayIdx;
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
      <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }} className="cal-scroll">
        <div style={{ display: 'grid', gridTemplateColumns: `56px repeat(7, 1fr)`, position: 'relative' }}>
          {/* hour gutter */}
          <div style={{ borderRight: '0.5px solid var(--separator)' }}>
            {hours.map(h => (
              <div key={h} style={{ height: ROW_H, position: 'relative' }}>
                <span style={{ position: 'absolute', top: -7, right: 8, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{h === gridStart ? '' : fmtHour(h)}</span>
              </div>
            ))}
          </div>

          {/* day columns */}
          {weekDays.map((d, di) => (
            <div key={di} style={{ position: 'relative', borderRight: di < 6 ? '0.5px solid var(--separator)' : 'none',
              background: di === todayIdx ? 'color-mix(in srgb, var(--red) 3%, transparent)' : 'transparent' }}>
              {/* hour lines */}
              {hours.map(h => <div key={h} style={{ height: ROW_H, borderBottom: '0.5px solid var(--separator)' }} />)}
              {/* live schedule chips */}
              {occ.filter(o => o.col === di).map((o, i) => {
                const p = (o.schedule.projectId && projMeta[o.schedule.projectId]) || fallback;
                const top = (o.hour - gridStart) * ROW_H;
                const dim = !o.schedule.enabled;
                return (
                  <button key={o.schedule.id + ':' + i} onClick={() => onPick(o.schedule)} className="sched-chip" style={{
                    position: 'absolute', top: top + 2, left: 3, right: 3, height: 30, borderRadius: 7, display: 'flex', alignItems: 'center', gap: 5, padding: '0 7px',
                    background: `color-mix(in srgb, ${p.color} 14%, var(--bg-elevated))`,
                    border: `1px solid color-mix(in srgb, ${p.color} 35%, transparent)`,
                    borderLeft: `3px solid ${p.color}`, textAlign: 'left', overflow: 'hidden', opacity: dim ? 0.45 : 1 }}
                    title={`${o.schedule.title}${dim ? ' · paused' : ''} · ${fmtTime(o.hour)}`}>
                    <Icon name="clock" size={11} style={{ color: p.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-caption)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.schedule.title}</span>
                  </button>
                );
              })}
            </div>
          ))}

          {/* real red now-line across grid */}
          {nowVisible && (
            <div className="cal-nowline" style={{ position: 'absolute', left: 56, right: 0, top: nowTop, height: 0, zIndex: 5, pointerEvents: 'none' }}>
              <div style={{ position: 'relative', borderTop: '1.5px solid var(--red)' }}>
                <span style={{ position: 'absolute', left: `calc(${todayIdx} / 7 * 100%)`, top: -4, width: 9, height: 9, borderRadius: '50%', background: 'var(--red)' }} />
              </div>
            </div>
          )}
        </div>

        {/* honest empty state — no schedules this week */}
        {occ.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none', padding: 24 }}>
            <div style={{ textAlign: 'center', maxWidth: 320 }}>
              <div style={{ font: '600 var(--fs-callout)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Nothing scheduled this week</div>
              <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 4 }}>Create a schedule and it appears here on its day &amp; time.</div>
            </div>
          </div>
        )}
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
  paused: boolean;
}

interface ScheduleRowProps { s: SchedRow; last: boolean; onPick: (s: SchedRow) => void; projMeta: ProjMeta; onToggle: (id: string, nextEnabled: boolean) => void; onDelete: (id: string) => void }

function ScheduleRow({ s, last, onPick, projMeta, onToggle, onDelete }: ScheduleRowProps) {
  const [paused, setPaused] = React.useState(s.paused);
  const [hover, setHover] = React.useState(false);
  React.useEffect(() => { setPaused(s.paused); }, [s.paused]);
  const p = projMeta;
  return (
    <div className="sched-row" onClick={() => onPick(s)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ display: 'grid', gridTemplateColumns: '1.7fr 1.5fr 1fr 88px', alignItems: 'center', gap: 14,
      padding: '13px 16px', borderBottom: last ? 'none' : '0.5px solid var(--separator)', cursor: 'pointer', opacity: paused ? 0.6 : 1, transition: 'opacity 200ms ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span style={{ width: 9, height: 9, borderRadius: 5, background: p.color, flexShrink: 0 }} />
        <span style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
      </div>
      <span style={{ font: '400 var(--fs-subhead)/1.2 var(--font-text)', color: 'var(--ink-secondary)' }}>{s.cron}</span>
      <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', whiteSpace: 'nowrap', color: paused ? 'var(--ink-tertiary)' : 'var(--ink)' }}>{s.next === '—' ? '—' : s.next.startsWith('in') ? s.next : `in ${s.next}`}</span>
      <span style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }} onClick={e => e.stopPropagation()}>
        <button title="Remove schedule" onClick={() => onDelete(s.id)} style={{ width: 24, height: 24, borderRadius: 7, display: 'grid', placeItems: 'center',
          background: 'transparent', color: 'var(--ink-tertiary)', opacity: hover ? 1 : 0, transition: 'opacity 140ms ease', cursor: 'pointer' }}>
          <Icon name="x" size={14} />
        </button>
        <Switch on={!paused} onChange={v => { setPaused(!v); onToggle(s.id, v); }} />
      </span>
    </div>
  );
}

interface ListViewProps { onPick: (s: SchedRow) => void; rows: SchedRow[]; projMeta: Record<string, ProjMeta>; onToggle: (id: string, nextEnabled: boolean) => void; onDelete: (id: string) => void }

function ListView({ onPick, rows: allRows, projMeta, onToggle, onDelete }: ListViewProps) {
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
              {rows.map((s, i) => <ScheduleRow key={s.id} s={s} last={i === rows.length - 1} onPick={onPick} projMeta={p} onToggle={onToggle} onDelete={onDelete} />)}
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

interface ParsedWhen { time: string; cron: string; summary: string; label: string; everyMinutes?: number }

// tiny natural-language → cron parser (demo-grade)
function parseWhen(text: string): ParsedWhen {
  const t = text.toLowerCase().trim();
  const dayMap: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  // Interval cadence: "every 2 hours" / "every 90 min".
  const iv = t.match(/every\s+(\d+)\s*(h|hour|hours|m|min|mins|minute|minutes)\b/);
  if (iv) {
    const n = parseInt(iv[1], 10);
    const everyMinutes = /^h/.test(iv[2]) ? n * 60 : n;
    const label = everyMinutes % 60 === 0 ? `Every ${everyMinutes / 60}h` : `Every ${everyMinutes}m`;
    return { time: '', cron: '', summary: label, label: 'interval', everyMinutes };
  }
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

export interface ScheduleSaveData { id?: string; title: string; time: string; cadence: string; projectId?: string; sessionId?: string; prompt?: string; everyMinutes?: number; catchUp?: boolean }

interface ScheduleSheetProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: ScheduleSaveData) => void;
  initial: Schedule | null;
  projects: Project[];
}

/** Reconstruct a "when" phrase from a saved schedule so the parser round-trips on edit. */
function whenFromSchedule(s: Schedule): string {
  if (s.everyMinutes && s.everyMinutes > 0) {
    return s.everyMinutes % 60 === 0 ? `every ${s.everyMinutes / 60} hours` : `every ${s.everyMinutes} minutes`;
  }
  const cad = (s.cadence && s.cadence !== 'daily' && s.cadence !== 'once') ? s.cadence : 'every day';
  return `${cad} ${s.time || '09:00'}`;
}

function ScheduleSheet({ open, onClose, onSave, initial, projects }: ScheduleSheetProps) {
  const [when, setWhen] = React.useState('every weekday 9am');
  const [projectId, setProjectId] = React.useState('');
  const [sessionId, setSessionId] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [catchUp, setCatchUp] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [sessions, setSessions] = React.useState<ChatSession[]>([]);
  React.useEffect(() => {
    if (!open) return;
    setWhen(initial ? whenFromSchedule(initial) : 'every weekday 9am');
    setProjectId(initial?.projectId ?? '');
    setSessionId(initial?.sessionId ?? '');
    setPrompt(initial?.prompt ?? '');
    setCatchUp(!!initial?.catchUp);
    setAdvanced(false);
  }, [open, initial]);
  // Load the chosen project's sessions so a recurring run can target one chat.
  React.useEffect(() => {
    if (!open || !projectId) { setSessions([]); return; }
    let alive = true;
    api.listSessions(projectId).then(rows => { if (alive) setSessions(rows); }).catch(() => { if (alive) setSessions([]); });
    return () => { alive = false; };
  }, [open, projectId]);
  if (!open) return null;

  const parsed = parseWhen(when);
  const save = () => onSave({
    id: initial?.id,
    title: prompt.trim() ? prompt.trim().slice(0, 60) : parsed.summary,
    time: parsed.time, cadence: parsed.label,
    everyMinutes: parsed.everyMinutes,
    projectId: projectId || undefined,
    sessionId: sessionId || undefined,
    prompt: prompt.trim() || undefined,
    catchUp,
  });

  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32,
      background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 520, maxHeight: '100%', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated)', borderRadius: 20, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', overflow: 'hidden' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '18px 20px', borderBottom: '0.5px solid var(--separator)' }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, font: '700 var(--fs-title2)/1.1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>{initial ? 'Edit schedule' : 'New schedule'}</h2>
            <p style={{ margin: '3px 0 0', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Fires on this Mac at its time. Turn on catch-up so a missed run still fires later the same day.</p>
          </div>
          <button onClick={onClose} className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="x" size={18} /></button>
        </div>

        <div style={{ padding: 20, overflowY: 'auto' }}>
          {/* 1 project */}
          <SheetSection n="1" title="Project">
            <label className="sheet-pick" style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 52, padding: '10px 14px',
              background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)' }}>
              <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 14%, transparent)', color: 'var(--blue)' }}><Icon name="layers" size={16} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 3 }}>Project</span>
                <select value={projectId} onChange={e => setProjectId(e.target.value)} className="sel" style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>
                  <option value="">No project (workspace)</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </span>
              <Icon name="chevronDown" size={16} style={{ color: 'var(--ink-tertiary)' }} />
            </label>
            {projectId && sessions.length > 0 && (
              <label className="sheet-pick" style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 46, marginTop: 8, padding: '8px 14px',
                background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 3 }}>Run in chat (optional)</span>
                  <select value={sessionId} onChange={e => setSessionId(e.target.value)} className="sel" style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>
                    <option value="">Any chat in the project</option>
                    {sessions.map(se => <option key={se.id} value={se.id}>{se.title}</option>)}
                  </select>
                </span>
                <Icon name="chevronDown" size={16} style={{ color: 'var(--ink-tertiary)' }} />
              </label>
            )}
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
              <span style={{ font: '500 var(--fs-footnote)/1.3 var(--font-mono)', whiteSpace: 'nowrap', color: 'var(--ink-secondary)' }}>{parsed.summary}</span>
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

          {/* 3 what fires */}
          <SheetSection n="3" title="What runs">
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3}
              placeholder="What should run each time? e.g. Pull ~50 WhatsApp messages, summarize the conversation, and send me the summary in my private chat."
              style={{ width: '100%', resize: 'vertical', padding: '11px 14px', background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)',
                font: '400 var(--fs-body)/1.4 var(--font-text)', color: 'var(--ink)', outline: 'none' }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, cursor: 'pointer' }}>
              <Switch on={catchUp} onChange={setCatchUp} />
              <span style={{ font: '500 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Catch up if missed — if the Mac was asleep at the scheduled time, run it later the same day.</span>
            </label>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 12, padding: '12px 14px', background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)' }}>
              <Icon name="shield" size={15} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 1 }} />
              <span style={{ font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-secondary)' }}>
                Each firing creates a real job and runs it through your engine routing on this Mac — it shows up in Jobs and on your phone like any hand-started run, and its cost lands in Costs.
              </span>
            </div>
          </SheetSection>
        </div>

        {/* footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 14, padding: '14px 20px', borderTop: '0.5px solid var(--separator)' }}>
          <button onClick={onClose} style={{ height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={save} className="primary-cta" style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>{initial ? 'Save changes' : 'Save schedule'}</button>
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

// ──────────────────────────────────────────────────────────────────────────
// Scheduler page root (sc-app)
// ──────────────────────────────────────────────────────────────────────────

// derive a human cron line from the API's time + cadence fields
function cronLine(s: Schedule): string {
  if (s.everyMinutes && s.everyMinutes > 0) {
    const h = Math.floor(s.everyMinutes / 60), m = s.everyMinutes % 60;
    return `Every ${h ? `${h}h` : ''}${m ? ` ${m}m` : ''}`.trim() + (s.catchUp ? ' · catch-up' : '');
  }
  const cad = (s.cadence || '').trim();
  const time = (s.time || '').trim();
  if (!cad && !time) return 'On demand';
  if (!time) return cad;
  const base = (!cad || /every\s*day/i.test(cad) || cad === '*') ? `Every day at ${time}` : `${cad} at ${time}`;
  return base + (s.catchUp ? ' · catch-up' : '');
}

// derive a relative "next run" string from the API's nextRun timestamp
function nextLine(nextRun: number | null): string {
  if (!nextRun) return '—';
  const ms = nextRun - Date.now();
  if (ms <= 0) return 'due now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

export default function Scheduler() {
  const [view, setView] = React.useState('calendar');
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Schedule | null>(null);
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

  const onDelete = React.useCallback(async (id: string) => {
    const prev = schedules;
    setSchedules(p => p.filter(s => s.id !== id));
    try {
      await api.deleteSchedule(id);
    } catch {
      setSchedules(prev); // restore on failure
    }
  }, [schedules]);

  const onSaveSchedule = React.useCallback(async (data: ScheduleSaveData) => {
    setSheetOpen(false);
    try {
      if (data.id) {
        await api.updateSchedule(data.id, {
          title: data.title, prompt: data.prompt, time: data.time, cadence: data.cadence,
          everyMinutes: data.everyMinutes, catchUp: data.catchUp,
          sessionId: data.sessionId, projectId: data.projectId,
        });
      } else {
        await api.createSchedule({
          title: data.title, projectId: data.projectId, time: data.time, cadence: data.cadence,
          everyMinutes: data.everyMinutes, catchUp: data.catchUp, prompt: data.prompt, sessionId: data.sessionId,
        });
      }
      await loadSchedules();
    } catch { /* fail soft */ }
  }, [loadSchedules]);

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const openNew = () => { setEditing(null); setSheetOpen(true); };
  const openEdit = (row: SchedRow) => { setEditing(schedules.find(s => s.id === row.id) ?? null); setSheetOpen(true); };
  const openFromCalendar = (s: Schedule) => { setEditing(s); setSheetOpen(true); };

  return (
    <AppShell active="scheduler" onSearch={() => setPaletteOpen(true)}>
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
          Schedules fire on this Mac while Maestro is running. A missed time rolls forward — or, with catch-up on, still runs later the same day.
        </div>

        {/* body */}
        <div style={{ flex: 1, minHeight: 0, overflowY: view === 'list' ? 'auto' : 'hidden', paddingBottom: view === 'list' ? 28 : 0 }}>
          {view === 'calendar'
            ? <CalendarView schedules={schedules} projMeta={projMeta} onPick={openFromCalendar} />
            : <ListView onPick={openEdit} rows={rows} projMeta={projMeta} onToggle={onToggle} onDelete={onDelete} />}
        </div>
      </div>

      <ScheduleSheet open={sheetOpen} onClose={() => setSheetOpen(false)} onSave={onSaveSchedule} initial={editing} projects={projects} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
