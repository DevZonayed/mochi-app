/* Scheduler — data model + week calendar grid (iOS Calendar aesthetic). */

const SCHED_PROJ = {
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

// recurring rules → expand to week occurrences
const SCHED_RULES = [
  { id: 'r1', proj: 'atlas',   name: 'Dependency audit',  time: 6.0,  days: [0,1,2,3,4,5,6], trig: 'clock' },
  { id: 'r2', proj: 'content', name: 'Weekly report',     time: 8.0,  days: [0],             trig: 'clock' },
  { id: 'r3', proj: 'scan',    name: 'Market open scan',  time: 9.5,  days: [0,1,2,3,4],     trig: 'clock' },
  { id: 'r4', proj: 'infra',   name: 'CI hardening',      time: 11.0, days: [1,3],           trig: 'webhook' },
  { id: 'r5', proj: 'scan',    name: 'Competitor digest', time: 14.0, days: [0,1,2,3,4,5,6], trig: 'clock' },
  { id: 'r6', proj: 'content', name: 'Newsletter draft',  time: 16.5, days: [0,2,4],         trig: 'clock' },
  { id: 'r7', proj: 'atlas',   name: 'Nightly tests',     time: 18.0, days: [0,1,2,3,4,5,6], trig: 'clock' },
  { id: 'r8', proj: 'brand',   name: 'Asset backup',      time: 21.0, days: [0,1,2,3,4,5,6], trig: 'clock' },
];

function expandWeek() {
  const ev = [];
  SCHED_RULES.forEach(r => r.days.forEach(day => {
    // market scan on Tue (day1) was missed (machine asleep)
    const missed = (r.id === 'r3' && day === 1);
    ev.push({ ...r, day, missed });
  }));
  return ev;
}

function fmtHour(h) {
  const hh = Math.floor(h);
  const ampm = hh < 12 ? 'AM' : 'PM';
  const disp = hh % 12 === 0 ? 12 : hh % 12;
  return `${disp} ${ampm}`;
}
function fmtTime(t) {
  const hh = Math.floor(t), mm = Math.round((t - hh) * 60);
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

function CalendarView({ nowTime, onPick }) {
  const events = React.useMemo(expandWeek, []);
  const hours = [];
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

Object.assign(window, { SCHED_PROJ, WEEK_DAYS, TODAY_IDX, SCHED_RULES, expandWeek, fmtHour, fmtTime, CalendarView });
