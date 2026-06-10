/* Scheduler — list view (grouped by project) + schedule chip inspector. */

const SCHED_ROWS = [
  { id: 's1', proj: 'atlas',   name: 'Dependency audit',  cron: 'Every day at 06:00',          next: '15h 23m', conc: 1, misfire: 'Coalesce', paused: false },
  { id: 's2', proj: 'atlas',   name: 'Nightly tests',     cron: 'Every day at 18:00',          next: '3h 23m',  conc: 1, misfire: 'Fire now', paused: false },
  { id: 's3', proj: 'content', name: 'Weekly report',     cron: 'Every Monday at 08:00',       next: '4d 17h',  conc: 1, misfire: 'Skip', paused: false },
  { id: 's4', proj: 'content', name: 'Newsletter draft',  cron: 'Mon, Wed, Fri at 16:30',      next: '1h 53m',  conc: 1, misfire: 'Fire now', paused: false },
  { id: 's5', proj: 'scan',    name: 'Market open scan',  cron: 'Weekdays at 09:30',           next: '18h 53m', conc: 2, misfire: 'Fire now', paused: false, blocked: true },
  { id: 's6', proj: 'scan',    name: 'Competitor digest', cron: 'Every day at 14:00',          next: 'in 7m',   conc: 1, misfire: 'Skip', paused: true },
  { id: 's7', proj: 'brand',   name: 'Asset backup',      cron: 'Every day at 21:00',          next: '6h 23m',  conc: 1, misfire: 'Coalesce', paused: false },
  { id: 's8', proj: 'infra',   name: 'CI hardening',      cron: 'Tue & Thu at 11:00',          next: '21h 23m', conc: 3, misfire: 'Skip', paused: false },
];

function MisfireChip({ policy }) {
  const tint = { 'Fire now': 'var(--blue)', 'Skip': 'var(--ink-secondary)', 'Coalesce': 'var(--teal)' }[policy];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)',
      background: `color-mix(in srgb, ${tint} 12%, transparent)`, color: tint, font: '600 var(--fs-caption)/1 var(--font-text)', whiteSpace: 'nowrap' }}>
      <Icon name="refresh" size={11} /> {policy}
    </span>
  );
}

function ScheduleRow({ s, last, onToggle, onPick }) {
  const [paused, setPaused] = React.useState(s.paused);
  const p = SCHED_PROJ[s.proj];
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
        <Switch on={!paused} onChange={v => setPaused(!v)} />
      </span>
    </div>
  );
}

function ListView({ onPick }) {
  const byProj = {};
  SCHED_ROWS.forEach(s => { (byProj[s.proj] = byProj[s.proj] || []).push(s); });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {Object.entries(byProj).map(([proj, rows]) => {
        const p = SCHED_PROJ[proj];
        return (
          <div key={proj}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11, padding: '0 2px' }}>
              <span style={{ width: 9, height: 9, borderRadius: 5, background: p.color }} />
              <span style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>{p.name}</span>
              <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>· {rows.length}</span>
            </div>
            <div style={{ background: 'var(--bg-grouped)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden',
              backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
              {rows.map((s, i) => <ScheduleRow key={s.id} s={s} last={i === rows.length - 1} onPick={onPick} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

Object.assign(window, { SCHED_ROWS, MisfireChip, ScheduleRow, ListView });
