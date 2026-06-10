/* Mobile M03 — Jobs & Projects. */

const PROJ_ORDER = ['atlas', 'content', 'scan', 'brand', 'infra'];
const M_JOBS = {
  gated: [{ proj: 'atlas', name: 'Merge PR #482', sub: 'auth refactor', cost: '0.31' }],
  running: [
    { proj: 'atlas', name: 'Refactor auth service', tint: 'var(--purple)', cost: '0.42', el: '4:21' },
    { proj: 'brand', name: 'Export icon set @3x', tint: 'var(--teal)', cost: '0.12', el: '1:08' },
    { proj: 'infra', name: 'CI hardening', tint: 'var(--purple)', cost: '0.18', el: '2:55' },
  ],
  scheduled: [
    { proj: 'atlas', name: 'Nightly test suite', countdown: 'in 3h 23m' },
    { proj: 'scan', name: 'Competitor digest', countdown: 'in 7m' },
  ],
  done: [
    { proj: 'brand', name: 'Generate OG images', ok: true, cost: '0.34' },
    { proj: 'content', name: 'Translate docs (ES)', ok: true, cost: '0.46' },
    { proj: 'infra', name: 'Deploy preview', ok: false, cost: '0.02' },
  ],
};

function ProjAvatar({ id, sel, onClick }) {
  const all = id === 'all';
  const p = all ? { name: 'All', color: 'var(--ink)' } : M_PROJ[id];
  return (
    <button onClick={onClick} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: 64, flexShrink: 0 }}>
      <span style={{ width: 54, height: 54, borderRadius: 16, display: 'grid', placeItems: 'center', position: 'relative',
        background: all ? 'var(--fill-secondary)' : `color-mix(in srgb, ${p.color} 16%, transparent)`, color: all ? 'var(--ink)' : p.color,
        boxShadow: sel ? `0 0 0 2px var(--bg), 0 0 0 4px var(--blue)` : 'none' }}>
        {all ? <Icon name="layers" size={24} /> : <span style={{ font: '800 20px/1 var(--font-display)' }}>{p.name[0]}</span>}
        {id === 'scan' && <span style={{ position: 'absolute', top: -3, right: -3, width: 16, height: 16, borderRadius: 8, background: 'var(--red)', border: '2px solid var(--bg)', display: 'grid', placeItems: 'center', color: '#fff' }}><Icon name="lock" size={8} /></span>}
      </span>
      <span style={{ font: '500 11px/1 var(--font-text)', color: sel ? 'var(--blue)' : 'var(--ink-secondary)', whiteSpace: 'nowrap', maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis' }}>{all ? 'All' : p.name.split(' ')[0]}</span>
    </button>
  );
}

function Section({ label, count, tint, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 20px 8px' }}>
        <span style={{ font: '700 13px/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: tint || 'var(--ink-secondary)' }}>{label}</span>
        <span style={{ font: '600 12px/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{count}</span>
      </div>
      <div style={{ margin: '0 16px', background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden' }}>{children}</div>
    </div>
  );
}

function JobsScreen() {
  const [theme] = useTheme('light');
  const [filter, setFilter] = React.useState('all');
  const match = j => filter === 'all' || j.proj === filter;
  const g = M_JOBS.gated.filter(match), r = M_JOBS.running.filter(match), s = M_JOBS.scheduled.filter(match), d = M_JOBS.done.filter(match);

  return (
    <PhoneFrame tabBar={<TabBar active="jobs" />}>
      <LargeTitle title="Jobs" />
      {/* filter row */}
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '4px 16px 16px' }} className="m-scroll">
        <ProjAvatar id="all" sel={filter === 'all'} onClick={() => setFilter('all')} />
        {PROJ_ORDER.map(p => <ProjAvatar key={p} id={p} sel={filter === p} onClick={() => setFilter(p)} />)}
      </div>

      {g.length > 0 && <Section label="Gated" count={g.length} tint="var(--orange)">
        {g.map((j, i) => (
          <a key={i} href="../approvals/Approvals.html" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 15px', textDecoration: 'none', borderBottom: i < g.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
            <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'rgba(255,149,0,0.15)', color: 'var(--orange)' }}><Icon name="enter" size={16} /></span>
            <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', font: '600 16px/1.2 var(--font-text)', color: 'var(--ink)' }}>{j.name}</span><span style={{ display: 'block', font: '400 13px/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 3 }}>{M_PROJ[j.proj].name} · {j.sub}</span></span>
            <span style={{ font: '600 14px/1 var(--font-mono)', color: 'var(--orange)' }}>Gated</span>
            <Icon name="chevronRight" size={17} style={{ color: 'var(--ink-tertiary)' }} />
          </a>
        ))}
      </Section>}

      {r.length > 0 && <Section label="Running" count={r.length}>
        {r.map((j, i) => (
          <a key={i} href="../job-timeline/Job Timeline.html" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 15px', textDecoration: 'none', borderBottom: i < r.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
            <span className="breathe" style={{ width: 9, height: 9, borderRadius: 5, background: j.tint, flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', font: '600 16px/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.name}</span><span style={{ display: 'block', font: '400 13px/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 3 }}>{M_PROJ[j.proj].name} · {j.el}</span></span>
            <span style={{ font: '600 14px/1 var(--font-mono)', color: 'var(--ink)' }}>${j.cost}</span>
            <Icon name="chevronRight" size={17} style={{ color: 'var(--ink-tertiary)' }} />
          </a>
        ))}
      </Section>}

      {s.length > 0 && <Section label="Scheduled" count={s.length}>
        {s.map((j, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 15px', borderBottom: i < s.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
            <Icon name="clock" size={18} style={{ color: 'var(--teal)', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', font: '600 16px/1.2 var(--font-text)', color: 'var(--ink)' }}>{j.name}</span><span style={{ display: 'block', font: '400 13px/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 3 }}>{M_PROJ[j.proj].name}</span></span>
            <span style={{ font: '600 13px/1 var(--font-mono)', color: 'var(--teal)' }}>{j.countdown}</span>
          </div>
        ))}
      </Section>}

      {d.length > 0 && <Section label="Done today" count={d.length}>
        {d.map((j, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 15px', borderBottom: i < d.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
            <Icon name={j.ok ? 'checkCircle' : 'xCircle'} size={17} style={{ color: j.ok ? 'var(--green)' : 'var(--red)', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, font: '500 15px/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.name}</span>
            <span style={{ font: '500 13px/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>${j.cost}</span>
          </div>
        ))}
      </Section>}

      <div style={{ height: 80 }} />

      {/* FAB */}
      <a href="../new-job/New Job.html" style={{ position: 'absolute', bottom: 16, right: 18, width: 58, height: 58, borderRadius: 29, background: 'var(--blue)', display: 'grid', placeItems: 'center', color: '#fff', boxShadow: '0 8px 24px rgba(0,122,255,0.42)', zIndex: 10 }} className="m-pill"><Icon name="plus" size={28} stroke={2.4} /></a>
    </PhoneFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<JobsScreen />);
