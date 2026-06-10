/* Mobile M12 — Offline & Intent Outbox. */

const INTENTS = [
  { id: 'i1', icon: 'sliders', tint: 'var(--blue)', desc: 'Approve plan — PsychGate', t: '2 min ago', state: 'queued' },
  { id: 'i2', icon: 'play', tint: 'var(--purple)', desc: 'Start job — Kvanti research', t: '5 min ago', state: 'queued' },
  { id: 'i3', icon: 'gitMerge', tint: 'var(--green)', desc: 'Approve merge — PR #482', t: '8 min ago', state: 'applied' },
  { id: 'i4', icon: 'gauge', tint: 'var(--orange)', desc: 'Raise cap — Market Scan', t: '11 min ago', state: 'rejected', why: "Couldn't apply: this gate timed out at 09:14" },
  { id: 'i5', icon: 'send', tint: 'var(--teal)', desc: 'Publish — Launch thread', t: '14 min ago', state: 'conflict', why: 'Already approved on your Mac — nothing to do.' },
];

function Outbox() {
  const [theme] = useTheme('light');
  return (
    <PhoneFrame bg="var(--bg)">
      {/* offline banner */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', background: 'rgba(255,149,0,0.14)', borderBottom: '0.5px solid rgba(255,149,0,0.3)' }}>
        <Icon name="wifi" size={14} style={{ color: 'var(--orange)' }} />
        <span style={{ flex: 1, font: '500 13px/1.2 var(--font-text)', color: 'var(--orange)' }}>Offline — showing state from 4 min ago</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 16px 2px' }}>
        <a href="../settings/Settings.html" style={{ color: 'var(--blue)' }}><Icon name="arrowLeft" size={22} /></a>
      </div>
      <LargeTitle title="Outbox" />
      <div style={{ padding: '6px 16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {INTENTS.map(it => {
          const done = it.state === 'applied';
          const bad = it.state === 'rejected';
          const conflict = it.state === 'conflict';
          return (
            <div key={it.id} style={{ position: 'relative', padding: 15, borderRadius: 16, overflow: 'hidden',
              background: done ? 'rgba(52,199,89,0.07)' : bad ? 'rgba(255,59,48,0.06)' : 'var(--bg-elevated)',
              border: `1px solid ${done ? 'rgba(52,199,89,0.3)' : bad ? 'rgba(255,59,48,0.3)' : it.state === 'queued' ? 'rgba(255,149,0,0.4)' : 'var(--separator)'}`, boxShadow: 'var(--card-shadow)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${it.tint} 14%, transparent)`, color: it.tint }}><Icon name={it.icon} size={19} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ font: '600 16px/1.2 var(--font-text)', color: 'var(--ink)' }}>{it.desc}</div>
                  <div style={{ font: '400 13px/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 3 }}>{it.t}</div>
                </div>
                {it.state === 'queued' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px', borderRadius: 12, background: 'rgba(255,149,0,0.15)', color: 'var(--orange)', font: '600 12px/1 var(--font-text)' }}><Icon name="clock" size={11} /> Queued</span>}
                {done && <Icon name="checkCircle" size={22} style={{ color: 'var(--green)' }} />}
                {it.state === 'queued' && <button style={{ width: 26, height: 26, borderRadius: 13, background: 'var(--fill-secondary)', color: 'var(--ink-tertiary)', display: 'grid', placeItems: 'center', marginLeft: 4 }}><Icon name="x" size={13} /></button>}
              </div>
              {(bad || conflict) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11, paddingTop: 11, borderTop: '0.5px solid var(--separator)' }}>
                  <Icon name={bad ? 'xCircle' : 'check'} size={14} style={{ color: bad ? 'var(--red)' : 'var(--ink-tertiary)', flexShrink: 0 }} />
                  <span style={{ flex: 1, font: '400 13px/1.35 var(--font-text)', color: bad ? 'var(--red)' : 'var(--ink-secondary)' }}>{it.why}</span>
                  {bad && <a href="../job-timeline/Job Timeline.html" style={{ font: '600 13px/1 var(--font-text)', color: 'var(--blue)', textDecoration: 'none' }}>View job</a>}
                </div>
              )}
            </div>
          );
        })}
        <div style={{ font: '400 13px/1.45 var(--font-text)', color: 'var(--ink-tertiary)', textAlign: 'center', padding: '8px 20px 0' }}>Applies in order when your Mac is reachable. Each action carries a one-time token — nothing runs twice.</div>
      </div>
    </PhoneFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Outbox />);
