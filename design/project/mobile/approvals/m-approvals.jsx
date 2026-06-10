/* Mobile M05 — Approvals (tab 3). Full-width gate cards + Face ID confirm. */

const A_GATES = [
  { id: 'g1', type: 'plan', label: 'Plan approval', icon: 'sliders', tint: 'var(--blue)', proj: 'atlas', age: '1m',
    steps: ['Add a reversible migration', 'Issue short-lived JWTs on login', 'Read token-first with cookie fallback'], cost: '0.60' },
  { id: 'g2', type: 'publish', label: 'Publish draft', icon: 'send', tint: 'var(--purple)', proj: 'content', age: '9m', faceid: true,
    caption: 'Maestro is live. One operator, a fleet of agents.', platforms: ['x', 'linkedin'] },
  { id: 'g3', type: 'merge', label: 'Merge', icon: 'gitMerge', tint: 'var(--green)', proj: 'atlas', age: '14m', faceid: true,
    stat: '+204 −67 · 12 files · reviewer: 0 issues' },
  { id: 'g4', type: 'budget', label: 'Over budget', icon: 'gauge', tint: 'var(--orange)', proj: 'scan', age: '2m',
    over: '4.10', cap: 50 },
];
const PG = { x: 'var(--ink)', linkedin: 'var(--blue)' };
function PGlyph({ p, size = 14 }) {
  const paths = { x: <path d="M17.5 3h3l-6.5 7.4L21.5 21h-5.9l-4.3-5.6L6.3 21H3.3l7-8L2.8 3h6l3.9 5.2L17.5 3Z" fill="currentColor"/>, linkedin: <><rect x="3.5" y="3.5" width="17" height="17" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M7 10v6M7 7.5v.01M11 16v-3.5a1.5 1.5 0 0 1 3 0V16M11 16v-6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round"/></> };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none">{paths[p]}</svg>;
}

function GateBody({ g }) {
  if (g.type === 'plan') return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 12 }}>
        {g.steps.map((s, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ width: 22, height: 22, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '700 12px/1 var(--font-mono)' }}>{i + 1}</span>
            <span style={{ font: '500 15px/1.35 var(--font-text)', color: 'var(--ink)' }}>{s}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ font: '600 14px/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>≈ ${g.cost} · ~6 min</span>
        <span style={{ flex: 1 }} /><a href="#" style={{ font: '600 14px/1 var(--font-text)', color: 'var(--blue)', textDecoration: 'none' }}>View full plan →</a>
      </div>
    </div>
  );
  if (g.type === 'publish') return (
    <div>
      <div style={{ display: 'flex', gap: 14 }}>
        <div style={{ width: 74, height: 132, borderRadius: 12, background: 'linear-gradient(150deg,#1b2a4a,#5856D6)', flexShrink: 0, display: 'grid', placeItems: 'center', color: 'rgba(255,255,255,0.8)' }}><Icon name="play" size={22} /></div>
        <div style={{ flex: 1 }}>
          <div style={{ font: '400 15px/1.4 var(--font-text)', color: 'var(--ink)', marginBottom: 10 }}>{g.caption}</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>{g.platforms.map(p => <span key={p} style={{ width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: PG[p] }}><PGlyph p={p} size={14} /></span>)}</div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '600 12px/1 var(--font-text)', color: 'var(--green)' }}><Icon name="shield" size={12} /> AI label ✓ · C2PA ✓</span>
        </div>
      </div>
    </div>
  );
  if (g.type === 'merge') return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 12, background: 'rgba(52,199,89,0.08)', border: '0.5px solid rgba(52,199,89,0.25)' }}>
      <Icon name="check" size={16} stroke={2.6} style={{ color: 'var(--green)', flexShrink: 0 }} />
      <span style={{ flex: 1, font: '500 14px/1.3 var(--font-mono)', color: 'var(--ink)' }}>{g.stat}</span>
      <a href="../diff-review/Diff Review.html" style={{ font: '600 14px/1 var(--font-text)', color: 'var(--blue)', textDecoration: 'none', flexShrink: 0 }}>Review diff →</a>
    </div>
  );
  if (g.type === 'budget') return (
    <div>
      <div style={{ textAlign: 'center', padding: '4px 0 14px' }}>
        <span style={{ font: '700 38px/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--orange)' }}>+${g.over}</span>
        <span style={{ display: 'block', font: '500 13px/1 var(--font-mono)', color: 'var(--ink-tertiary)', marginTop: 6 }}>over the ${g.cap} cap</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[['Raise cap to $60', 'gauge', true], ['Downgrade model', 'cpu', false], ['Abort run', 'x', false]].map((o, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', borderRadius: 11, background: o[2] ? 'color-mix(in srgb, var(--blue) 10%, transparent)' : 'var(--fill-tertiary)', border: `0.5px solid ${o[2] ? 'color-mix(in srgb, var(--blue) 30%, transparent)' : 'var(--separator)'}` }}>
            <Icon name={o[1]} size={17} style={{ color: o[2] ? 'var(--blue)' : i === 2 ? 'var(--red)' : 'var(--ink-secondary)' }} /><span style={{ flex: 1, font: '600 15px/1 var(--font-text)', color: i === 2 ? 'var(--red)' : 'var(--ink)' }}>{o[0]}</span>
            {o[2] && <Icon name="chevronRight" size={16} style={{ color: 'var(--ink-tertiary)' }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function GateCard({ g, onApprove }) {
  const p = M_PROJ[g.proj];
  return (
    <div data-gate={g.id} className="gate-card" style={{ margin: '0 16px 16px', background: 'var(--bg-elevated)', borderRadius: 20, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 18, position: 'relative', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
        <span style={{ width: 40, height: 40, borderRadius: 12, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${g.tint} 14%, transparent)`, color: g.tint, flexShrink: 0 }}><Icon name={g.icon} size={21} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: '700 16px/1.1 var(--font-text)', color: 'var(--ink)' }}>{g.label}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}><span style={{ width: 7, height: 7, borderRadius: 4, background: p.color }} /><span style={{ font: '500 13px/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{p.name}</span><span style={{ font: '400 12px/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>· {g.age}</span></div>
        </div>
      </div>
      <div style={{ marginBottom: 16 }}><GateBody g={g} /></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={() => onApprove(g)} className="m-pill" style={{ flex: 1, height: 50, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 17px/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.32)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
          {g.faceid && <Icon name="lock" size={15} />} Approve
        </button>
        <button style={{ width: 46, height: 46, borderRadius: 23, background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', display: 'grid', placeItems: 'center' }}><Icon name="command" size={19} /></button>
        <button style={{ font: '600 16px/1 var(--font-text)', color: 'var(--red)', padding: '0 4px' }}>Reject</button>
      </div>
      {/* approve cover */}
      <div className="gate-cover" style={{ position: 'absolute', inset: 0, background: 'rgba(52,199,89,0.12)', display: 'grid', placeItems: 'center', opacity: 0, pointerEvents: 'none' }}>
        <span style={{ width: 56, height: 56, borderRadius: 28, background: 'var(--green)', color: '#fff', display: 'grid', placeItems: 'center' }}><Icon name="check" size={30} stroke={3} /></span>
      </div>
    </div>
  );
}

function FaceID({ g, onDone }) {
  React.useEffect(() => { const t = setTimeout(onDone, 1400); return () => clearTimeout(t); }, []);
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 70, background: 'rgba(10,12,24,0.55)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18 }}>
      <span className="faceid-pulse" style={{ width: 80, height: 80, borderRadius: 22, border: '3px solid #fff', display: 'grid', placeItems: 'center', color: '#fff' }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M9 10v1M15 10v1M12 9v3l-1 1M9.5 15a3.5 3.5 0 0 0 5 0"/></svg>
      </span>
      <span style={{ font: '600 17px/1.3 var(--font-text)', color: '#fff', textAlign: 'center', maxWidth: 240 }}>Confirm {g.label.toLowerCase()} with Face ID</span>
    </div>
  );
}

function Approvals() {
  const [theme] = useTheme('light');
  const [gates, setGates] = React.useState(A_GATES);
  const [faceid, setFaceid] = React.useState(null);

  const finish = (g) => { const c = document.querySelector(`[data-gate="${g.id}"]`); if (c) { const cv = c.querySelector('.gate-cover'); if (cv) { cv.style.transition = 'opacity 200ms'; cv.style.opacity = '1'; } c.classList.add('gate-approve'); } setTimeout(() => setGates(gs => gs.filter(x => x.id !== g.id)), 420); };
  const approve = (g) => { if (g.faceid) setFaceid(g); else finish(g); };

  return (
    <PhoneFrame tabBar={<TabBar active="approvals" />}>
      <LargeTitle title="Approvals" sub={gates.length ? `${gates.length} waiting · approve from anywhere` : null} />
      <div style={{ paddingTop: 6 }}>
        {gates.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '80px 30px', textAlign: 'center' }}>
            <span style={{ width: 72, height: 72, borderRadius: 36, background: 'rgba(52,199,89,0.14)', color: 'var(--green)', display: 'grid', placeItems: 'center', marginBottom: 20 }}><Icon name="check" size={38} stroke={2.4} /></span>
            <div style={{ font: '700 22px/1.2 var(--font-display)', color: 'var(--ink)', marginBottom: 8 }}>All clear</div>
            <div style={{ font: '400 16px/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>Gates will appear here and as notifications.</div>
          </div>
        ) : gates.map(g => <GateCard key={g.id} g={g} onApprove={approve} />)}
        <div style={{ height: 20 }} />
      </div>
      {faceid && <FaceID g={faceid} onDone={() => { finish(faceid); setFaceid(null); }} />}
    </PhoneFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Approvals />);
