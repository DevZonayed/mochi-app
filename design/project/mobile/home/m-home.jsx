/* Mobile M02 — Home. */

const GATES = [
  { id: 'g1', proj: 'atlas', icon: 'gitMerge', tint: 'var(--blue)', type: 'Merge', summary: 'Merge PR #482 — auth refactor', age: '4m' },
  { id: 'g2', proj: 'content', icon: 'send', tint: 'var(--purple)', type: 'Publish', summary: 'Publish “Launch week” thread to X', age: '9m' },
  { id: 'g3', proj: 'scan', icon: 'gauge', tint: 'var(--orange)', type: 'Over budget', summary: 'Deep run needs $4.10 over cap', age: '1m' },
];
const LIVE = [
  { proj: 'atlas', name: 'Refactor auth service', verb: 'Building', tint: 'var(--purple)', pct: 64, cost: '0.42' },
  { proj: 'brand', name: 'Export icon set @3x', verb: 'Rendering', tint: 'var(--teal)', pct: 88, cost: '0.12' },
  { proj: 'infra', name: 'CI hardening', verb: 'Building', tint: 'var(--purple)', pct: 32, cost: '0.18' },
];
const DONE = [
  { ok: true, name: 'Generate OG images', cost: '0.34', when: '20m ago' },
  { ok: true, name: 'Summarize tickets', cost: '0.11', when: '1h ago' },
  { ok: false, name: 'Deploy preview', cost: '0.02', when: '2h ago' },
];

function NeedsYou({ gates, onApprove }) {
  if (!gates.length) return (
    <div style={{ margin: '0 20px 22px', display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px', borderRadius: 16, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)' }}>
      <span style={{ width: 30, height: 30, borderRadius: 15, background: 'rgba(52,199,89,0.16)', color: 'var(--green)', display: 'grid', placeItems: 'center' }}><Icon name="check" size={17} stroke={2.6} /></span>
      <span style={{ font: '500 16px/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Nothing needs you</span>
    </div>
  );
  const top = gates[0]; const p = M_PROJ[top.proj];
  return (
    <div style={{ margin: '4px 20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Icon name="shield" size={15} style={{ color: 'var(--red)' }} /><span style={{ font: '700 13px/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>Needs you</span>
        <span style={{ minWidth: 18, height: 18, padding: '0 6px', borderRadius: 9, background: 'var(--red)', color: '#fff', font: '700 11px/18px var(--font-mono)', textAlign: 'center' }}>{gates.length}</span>
      </div>
      <div style={{ position: 'relative' }}>
        {/* depth stack */}
        {gates.length > 2 && <div style={{ position: 'absolute', top: 14, left: 14, right: 14, height: 60, borderRadius: 18, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', opacity: 0.5 }} />}
        {gates.length > 1 && <div style={{ position: 'absolute', top: 8, left: 8, right: 8, height: 80, borderRadius: 18, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', opacity: 0.75 }} />}
        <div data-gate={top.id} className="gate-card" style={{ position: 'relative', background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 12 }}>
            <span style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${top.tint} 14%, transparent)`, color: top.tint, flexShrink: 0 }}><Icon name={top.icon} size={20} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><span style={{ width: 7, height: 7, borderRadius: 4, background: p.color }} /><span style={{ font: '600 13px/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{p.name}</span><span style={{ font: '500 12px/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>· {top.age}</span></div>
              <div style={{ font: '700 13px/1 var(--font-text)', letterSpacing: '0.02em', textTransform: 'uppercase', color: top.tint, marginTop: 5 }}>{top.type}</div>
            </div>
          </div>
          <div style={{ font: '500 17px/1.35 var(--font-text)', color: 'var(--ink)', marginBottom: 16, textWrap: 'pretty' }}>{top.summary}</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => onApprove(top.id)} className="m-pill" style={{ flex: 1, height: 46, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 16px/1 var(--font-text)', boxShadow: '0 4px 14px rgba(0,122,255,0.3)' }}>Approve</button>
            <a href="../approvals/Approvals.html" className="m-pill" style={{ flex: 1, height: 46, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 16px/1 var(--font-text)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>Review</a>
          </div>
          {gates.length > 1 && <div style={{ textAlign: 'center', marginTop: 12, font: '500 13px/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{gates.length - 1} more · swipe to triage</div>}
        </div>
      </div>
    </div>
  );
}

function Home() {
  const [theme] = useTheme('light');
  const [gates, setGates] = React.useState(GATES);
  const approve = (id) => { const c = document.querySelector(`[data-gate="${id}"]`); if (c) { c.classList.add('gate-approve'); setTimeout(() => setGates(g => g.filter(x => x.id !== id)), 360); } };
  return (
    <PhoneFrame tabBar={<TabBar active="home" />}>
      <LargeTitle title="Maestro" trailing={<a href="../notifications/Notifications.html" style={{ position: 'relative', color: 'var(--ink)' }}><Icon name="bell" size={24} /><span style={{ position: 'absolute', top: -2, right: -2, width: 9, height: 9, borderRadius: 5, background: 'var(--red)', border: '2px solid var(--bg)' }} /></a>} />
      <NeedsYou gates={gates} onApprove={approve} />

      {/* live now */}
      <div style={{ padding: '0 20px', marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}><Icon name="bolt" size={15} style={{ color: 'var(--purple)' }} /><span style={{ font: '700 13px/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>Live now</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {LIVE.map((j, i) => { const p = M_PROJ[j.proj]; return (
            <a key={i} href="../job-timeline/Job Timeline.html" className="m-card" style={{ display: 'block', background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 14, textDecoration: 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: p.color, flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, font: '600 16px/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.name}</span>
                <span style={{ font: '600 14px/1 var(--font-mono)', color: 'var(--ink)' }}>${j.cost}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
                <span className="breathe" style={{ width: 7, height: 7, borderRadius: 4, background: j.tint }} />
                <span style={{ font: '500 13px/1 var(--font-text)', color: j.tint }}>{j.verb}</span>
                <span style={{ flex: 1, height: 3, borderRadius: 2, background: 'var(--fill-secondary)', overflow: 'hidden', marginLeft: 4 }}><span style={{ display: 'block', width: `${j.pct}%`, height: '100%', background: 'var(--blue)' }} /></span>
              </div>
            </a>
          ); })}
        </div>
      </div>

      {/* today strip */}
      <a href="../budget/Budget.html" style={{ display: 'flex', margin: '0 20px 22px', padding: '14px 18px', borderRadius: 14, background: 'var(--bg-grouped)', border: '0.5px solid var(--separator)', textDecoration: 'none', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
        {[['$6.40', 'spend'], ['3', 'scheduled'], ['2 ✓', 'done']].map((s, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span style={{ width: 1, background: 'var(--separator)', margin: '0 14px' }} />}
            <div style={{ flex: 1 }}><div style={{ font: '700 18px/1 var(--font-mono)', color: 'var(--ink)' }}>{s[0]}</div><div style={{ font: '400 12px/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 4 }}>{s[1]}</div></div>
          </React.Fragment>
        ))}
      </a>

      {/* recently finished */}
      <div style={{ padding: '0 20px 20px' }}>
        <div style={{ font: '700 13px/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)', marginBottom: 11 }}>Recently finished</div>
        <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden' }}>
          {DONE.map((d, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 15px', borderBottom: i < DONE.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
              <Icon name={d.ok ? 'checkCircle' : 'xCircle'} size={18} style={{ color: d.ok ? 'var(--green)' : 'var(--red)' }} />
              <span style={{ flex: 1, font: '500 15px/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
              <span style={{ font: '500 13px/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>${d.cost}</span>
              <span style={{ font: '400 12px/1 var(--font-text)', color: 'var(--ink-tertiary)', width: 56, textAlign: 'right' }}>{d.when}</span>
            </div>
          ))}
        </div>
      </div>
    </PhoneFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Home />);
