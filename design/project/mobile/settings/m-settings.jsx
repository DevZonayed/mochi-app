/* Mobile M11 — Settings (tab 5). iOS grouped-inset on grey. */

function MSwitch({ on: init }) { const [on, setOn] = React.useState(init); return <button onClick={() => setOn(o => !o)} style={{ width: 51, height: 31, borderRadius: 16, position: 'relative', background: on ? 'var(--green)' : 'var(--fill-secondary)', transition: 'background 220ms var(--spring)', flexShrink: 0 }}><span style={{ position: 'absolute', top: 2, left: on ? 22 : 2, width: 27, height: 27, borderRadius: 14, background: '#fff', boxShadow: '0 2px 5px rgba(0,0,0,0.25)', transition: 'left 240ms var(--spring)' }} /></button>; }

function Settings() {
  const [theme, setTheme] = useTheme('light');
  const [eff, setEff] = React.useState('BALANCED');
  const [model, setModel] = React.useState('auto');
  const seg = theme === 'dark' ? 'Dark' : 'Light';
  return (
    <PhoneFrame tabBar={<TabBar active="settings" />} bg="var(--bg)">
      <LargeTitle title="Settings" />
      {/* connection hero */}
      <div style={{ margin: '4px 16px 22px', padding: 18, borderRadius: 16, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
          <span style={{ width: 46, height: 46, borderRadius: 13, background: 'var(--fill-secondary)', display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)', flexShrink: 0 }}><Icon name="cpu" size={24} /></span>
          <div style={{ flex: 1 }}>
            <div style={{ font: '600 17px/1.1 var(--font-text)', color: 'var(--ink)' }}>Jillur's MacBook Pro</div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 5 }}><span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--green)' }} /><span style={{ font: '500 13px/1 var(--font-text)', color: 'var(--green)' }}>Connected via relay · E2EE</span><span style={{ font: '400 12px/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>· 84 ms</span></div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button style={{ flex: 1, height: 38, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 14px/1 var(--font-text)' }}>Test connection</button>
          <button style={{ width: 38, height: 38, borderRadius: 19, background: 'rgba(52,199,89,0.14)', color: 'var(--green)', display: 'grid', placeItems: 'center' }}><Icon name="shield" size={18} /></button>
        </div>
      </div>

      <MGroup header="Defaults" style={{ marginBottom: 22 }} footer="Applies to new jobs; projects can override.">
        <MRow><span style={{ flex: 1, font: '400 16px/1 var(--font-text)', color: 'var(--ink)' }}>Effort</span><EffortDial value={eff} onChange={setEff} compact /></MRow>
        <MRow last><span style={{ flex: 1, font: '400 16px/1 var(--font-text)', color: 'var(--ink)' }}>Model</span><ModelSwitcher value={model} onChange={setModel} compact align="right" /></MRow>
      </MGroup>

      <MGroup header="Notifications" style={{ marginBottom: 22 }} footer="Destructive approvals always confirm in app.">
        {[['Gates', true], ['Completions', true], ['Failures', true], ['Budget', true], ['Publishing', false]].map((r, i, a) => <MRow key={i} last={i === a.length - 1}><span style={{ flex: 1, font: '400 16px/1 var(--font-text)', color: 'var(--ink)' }}>{r[0]}</span><MSwitch on={r[1]} /></MRow>)}
      </MGroup>

      <MGroup header="Approvals security" style={{ marginBottom: 22 }}>
        <MRow><span style={{ flex: 1, font: '400 16px/1.2 var(--font-text)', color: 'var(--ink)' }}>Face ID for approvals</span><MSwitch on={true} /></MRow>
        <MRow last><span style={{ flex: 1, font: '400 16px/1.2 var(--font-text)', color: 'var(--ink)' }}>Lock-screen approve for safe gates</span><MSwitch on={true} /></MRow>
      </MGroup>

      <MGroup header="Appearance" style={{ marginBottom: 22 }}>
        <MRow last>
          <span style={{ flex: 1, font: '400 16px/1 var(--font-text)', color: 'var(--ink)' }}>Theme</span>
          <div style={{ display: 'flex', gap: 3, padding: 2, background: 'var(--fill-secondary)', borderRadius: 8 }}>
            {['Light', 'Dark', 'Auto'].map(o => <button key={o} onClick={() => setTheme(o === 'Dark' ? 'dark' : 'light')} style={{ padding: '5px 11px', borderRadius: 6, font: '600 13px/1 var(--font-text)', background: seg === o ? 'var(--bg-elevated)' : 'transparent', color: seg === o ? 'var(--ink)' : 'var(--ink-secondary)', boxShadow: seg === o ? '0 1px 2px rgba(0,0,0,0.14)' : 'none' }}>{o}</button>)}
          </div>
        </MRow>
      </MGroup>

      <MGroup header="Offline & sync" style={{ marginBottom: 22 }}>
        <MRow onClick={() => location.href = '../outbox/Outbox.html'}><span style={{ width: 30, height: 30, borderRadius: 8, background: 'rgba(255,149,0,0.14)', color: 'var(--orange)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="clock" size={16} /></span><span style={{ flex: 1, font: '400 16px/1 var(--font-text)', color: 'var(--ink)' }}>Outbox</span><span style={{ font: '500 14px/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>2 waiting</span><Icon name="chevronRight" size={16} style={{ color: 'var(--ink-tertiary)' }} /></MRow>
        <MRow last><span style={{ flex: 1, font: '400 16px/1 var(--font-text)', color: 'var(--ink)' }}>Cached media</span><span style={{ font: '500 14px/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>248 MB</span><button style={{ font: '600 14px/1 var(--font-text)', color: 'var(--blue)', marginLeft: 8 }}>Clear</button></MRow>
      </MGroup>

      <MGroup header="This device" style={{ marginBottom: 22 }}>
        <MRow><span style={{ width: 110, font: '400 16px/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Name</span><span style={{ flex: 1, font: '400 16px/1 var(--font-text)', color: 'var(--ink)' }}>iPhone 15 Pro</span></MRow>
        <MRow last><span style={{ flex: 1, font: '400 16px/1 var(--font-text)', color: 'var(--red)' }}>Unpair from Mac</span><Icon name="chevronRight" size={16} style={{ color: 'var(--ink-tertiary)' }} /></MRow>
      </MGroup>

      <MGroup header="About" style={{ marginBottom: 28 }}>
        <MRow><span style={{ flex: 1, font: '400 16px/1 var(--font-text)', color: 'var(--ink)' }}>Version</span><span style={{ font: '500 14px/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>1.4.0 (212)</span></MRow>
        <MRow last><span style={{ flex: 1, font: '400 16px/1 var(--font-text)', color: 'var(--ink)' }}>Relay</span><span style={{ font: '500 13px/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>relay.maestro.app</span></MRow>
      </MGroup>
    </PhoneFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Settings />);
