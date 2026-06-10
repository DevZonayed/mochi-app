/* Mobile M04 — Job Live Timeline (streaming transcript). */

function MeterStrip() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '10px 20px', borderBottom: '0.5px solid var(--separator)', background: 'var(--bg-grouped)' }}>
      {[['$0.84', 'cost'], ['12:40', 'elapsed'], ['BALANCED', 'effort']].map((m, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ width: 1, height: 26, background: 'var(--separator)', margin: '0 16px' }} />}
          <div style={{ flex: 1 }}>
            <div style={{ font: '600 16px/1 var(--font-mono)', color: i === 2 ? 'var(--blue)' : 'var(--ink)' }}>{m[0]}</div>
            <div style={{ font: '400 11px/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 4 }}>{m[1]}</div>
          </div>
        </React.Fragment>
      ))}
      <Icon name="chevronDown" size={16} style={{ color: 'var(--ink-tertiary)' }} />
    </div>
  );
}

function Tool({ cmd, time }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '11px 13px', borderRadius: open ? '11px 11px 0 0' : 11, background: 'var(--fill-secondary)', textAlign: 'left' }}>
        <Icon name="chevronRight" size={13} style={{ color: 'var(--ink-tertiary)', transform: open ? 'rotate(90deg)' : 'none' }} />
        <span style={{ flex: 1, font: '500 14px/1 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cmd}</span>
        <Icon name="check" size={13} stroke={2.6} style={{ color: 'var(--green)' }} />
        <span style={{ font: '400 12px/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{time}</span>
      </button>
      {open && <pre style={{ margin: 0, padding: '11px 13px', background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', borderTop: 'none', borderRadius: '0 0 11px 11px', font: '400 12px/1.6 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'pre-wrap' }}>{'PASS  test/auth/session.test.ts\nTests: 24 passed\nTime:  3.18s'}</pre>}
    </div>
  );
}

function PhaseMark({ label }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}><span style={{ flex: 1, height: 1, background: 'var(--separator)' }} /><span style={{ font: '600 12px/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{label}</span><span style={{ flex: 1, height: 1, background: 'var(--separator)' }} /></div>;
}

function Timeline() {
  const [theme] = useTheme('light');
  return (
    <PhoneFrame noScroll>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 16px 10px', borderBottom: '0.5px solid var(--separator)' }}>
        <a href="../jobs/Jobs.html" style={{ color: 'var(--blue)' }}><Icon name="arrowLeft" size={22} /></a>
        <div style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
          <div style={{ font: '600 16px/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Refactor auth service</div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 3 }}><span className="breathe" style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--purple)' }} /><span style={{ font: '500 12px/1 var(--font-text)', color: 'var(--purple)' }}>Building · Atlas API</span></div>
        </div>
        <Icon name="more" size={22} style={{ color: 'var(--ink-secondary)' }} />
      </div>
      <MeterStrip />

      {/* timeline body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 18px 90px', display: 'flex', flexDirection: 'column', gap: 16 }} className="m-scroll">
        <PhaseMark label="Plan ✓" />
        <div style={{ font: '400 17px/1.6 var(--font-text)', color: 'var(--ink)' }}>I'll move the auth service to short-lived JWTs while keeping the legacy cookie path intact, then prove it with tests.</div>
        <Tool cmd="bash · npm test — auth" time="3.2s" />
        <PhaseMark label="Build ●" />
        <div style={{ font: '400 17px/1.6 var(--font-text)', color: 'var(--ink)' }}>The session table needs a migration. Adding a nullable jwt_id column so we can backfill without downtime.</div>
        <a href="../diff-review/Diff Review.html" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: 14, borderRadius: 14, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', textDecoration: 'none' }}>
          <Icon name="terminal" size={18} style={{ color: 'var(--ink-secondary)' }} />
          <span style={{ flex: 1, font: '600 15px/1.2 var(--font-text)', color: 'var(--ink)' }}>12 files changed</span>
          <span style={{ font: '600 14px/1 var(--font-mono)', color: 'var(--green)' }}>+204</span><span style={{ font: '600 14px/1 var(--font-mono)', color: 'var(--red)' }}>−67</span>
          <Icon name="chevronRight" size={16} style={{ color: 'var(--ink-tertiary)' }} />
        </a>
        <Tool cmd="bash · npm run typecheck" time="5.1s" />
        <div style={{ font: '400 17px/1.6 var(--font-text)', color: 'var(--ink)' }}>Patching the three call sites in routes/ that read req.session directly<span className="cursor-blink" style={{ color: 'var(--purple)' }}>▍</span></div>
      </div>

      {/* jump to live pill */}
      <button style={{ position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)', display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 18px', borderRadius: 20, background: 'var(--blue)', color: '#fff', font: '600 14px/1 var(--font-text)', boxShadow: '0 8px 24px rgba(0,122,255,0.42)', zIndex: 10 }} className="m-pill">Jump to live <Icon name="chevronDown" size={15} /></button>
    </PhoneFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Timeline />);
