/* Audit Log & Run History — Runs list + replay, forensic Audit table. */

const RUNS = [
  { day: 'Today', items: [
    { proj: 'Atlas API', tint: 'var(--blue)', name: 'Refactor auth service', out: 'done', shape: 'pbr', cost: '0.58', dur: '6:12', time: '14:08' },
    { proj: 'Q3 Content', tint: 'var(--purple)', name: 'Draft launch thread', out: 'done', shape: 'single', cost: '0.07', dur: '0:52', time: '11:40' },
    { proj: 'Market Scan', tint: 'var(--indigo)', name: 'Competitor digest', out: 'failed', shape: 'pipeline', cost: '1.20', dur: '4:01', time: '09:30' },
  ]},
  { day: 'Yesterday', items: [
    { proj: 'Brand Refresh', tint: 'var(--teal)', name: 'Export icon set @3x', out: 'done', shape: 'fanout', cost: '0.34', dur: '5:40', time: '18:22' },
    { proj: 'Infra / CI', tint: 'var(--orange)', name: 'Deploy preview', out: 'cancelled', shape: 'single', cost: '0.02', dur: '0:12', time: '16:05' },
  ]},
  { day: 'June 8', items: [
    { proj: 'Atlas API', tint: 'var(--blue)', name: 'Nightly test suite', out: 'done', shape: 'pipeline', cost: '0.12', dur: '3:11', time: '18:00' },
    { proj: 'Q3 Content', tint: 'var(--purple)', name: 'Translate docs (ES)', out: 'done', shape: 'fanout', cost: '0.46', dur: '7:20', time: '10:15' },
  ]},
];
const OUT = { done: { icon: 'checkCircle', tint: 'var(--green)' }, failed: { icon: 'xCircle', tint: 'var(--red)' }, cancelled: { icon: 'pause', tint: 'var(--ink-tertiary)' } };

function RunsTab({ onOpen }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, height: 44, padding: '0 14px', borderRadius: 12, background: 'var(--bg-grouped)', border: '0.5px solid var(--separator)', marginBottom: 18, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', maxWidth: 420 }}>
        <Icon name="search" size={17} style={{ color: 'var(--ink-tertiary)' }} />
        <span style={{ font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Search runs by project, job, or outcome</span>
      </div>
      {RUNS.map(g => (
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
                <span><ShapeChip shape={r.shape} /></span>
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

function ReplayOverlay({ run, onClose }) {
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
            <a href="../session-transcript/Session Transcript.html" className="link-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 14, font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)', textDecoration: 'none' }}><Icon name="terminal" size={14} /> Open full transcript</a>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Audit
const AUDIT = [
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
const ACTOR = { job: { label: 'Job', tint: 'var(--purple)' }, operator: { label: 'Operator', tint: 'var(--blue)' }, system: { label: 'System', tint: 'var(--ink-secondary)' } };

function AuditTab({ broken }) {
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

Object.assign(window, { RUNS, RunsTab, ReplayOverlay, AuditTab });
