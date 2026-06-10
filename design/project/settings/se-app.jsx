/* Settings — assembly: in-page settings nav + reset confirm sheet. */

function ResetSheet({ onClose }) {
  const [typed, setTyped] = React.useState('');
  const ok = typed.trim().toUpperCase() === 'RESET';
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32, background: 'rgba(10,12,24,0.4)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 420, background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', padding: 24, textAlign: 'center' }}>
        <span style={{ display: 'inline-grid', placeItems: 'center', width: 52, height: 52, borderRadius: '50%', background: 'rgba(255,59,48,0.14)', color: 'var(--red)', marginBottom: 15 }}><Icon name="alert" size={26} /></span>
        <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Reset this workspace?</h2>
        <p style={{ margin: '0 0 18px', font: '400 var(--fs-subhead)/1.45 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>This removes projects, transcripts, synced copies, and media. Type <b style={{ color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}>RESET</b> to confirm.</p>
        <input value={typed} onChange={e => setTyped(e.target.value)} autoFocus placeholder="RESET" style={{ width: '100%', height: 44, textAlign: 'center', border: '1.5px solid var(--separator-strong)', borderRadius: 12, outline: 'none', background: 'var(--fill-tertiary)', font: '600 var(--fs-headline)/1 var(--font-mono)', color: 'var(--ink)', marginBottom: 14 }} />
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={onClose} disabled={!ok} style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: ok ? 'var(--red)' : 'var(--fill-secondary)', color: ok ? '#fff' : 'var(--ink-tertiary)', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: ok ? '0 6px 18px rgba(255,59,48,0.32)' : 'none' }}>Reset workspace</button>
        </div>
      </div>
    </div>
  );
}

function SettingsPage() {
  const [theme, setTheme] = useTheme('light');
  const [sec, setSec] = React.useState('general');
  const [reset, setReset] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  React.useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const panes = {
    general: <GeneralPane theme={theme} setTheme={setTheme} />, accounts: <AccountsPane />, security: <SecurityPane />,
    devices: <DevicesPane />, power: <PowerPane />, updates: <UpdatesPane />, danger: <DangerPane onReset={() => setReset(true)} />,
  };

  return (
    <WindowFrame>
      <Sidebar active="" onNav={navTo} onWorkspace={() => {}} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* settings nav */}
          <aside style={{ width: 232, flexShrink: 0, borderRight: '0.5px solid var(--separator)', padding: '20px 12px', overflowY: 'auto', background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
            <div style={{ font: '700 var(--fs-title2)/1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)', padding: '0 10px 14px' }}>Settings</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {SET_NAV.map(n => {
                const on = sec === n.key;
                return (
                  <button key={n.key} onClick={() => setSec(n.key)} className={on ? '' : 'set-nav'} style={{ display: 'flex', alignItems: 'center', gap: 11, height: 38, padding: '0 10px', borderRadius: 8, textAlign: 'left',
                    background: on ? 'var(--blue)' : 'transparent', color: on ? '#fff' : 'var(--ink)', font: `${on ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`, transition: 'background 140ms ease' }}>
                    <span style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center', background: on ? 'rgba(255,255,255,0.2)' : `color-mix(in srgb, ${n.tint} 14%, transparent)`, color: on ? '#fff' : n.tint }}><Icon name={n.icon} size={15} /></span>
                    {n.label}
                  </button>
                );
              })}
            </div>
          </aside>
          {/* pane */}
          <main style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 40px' }}>
            <div key={sec} className="pane-fade" style={{ maxWidth: 640 }}>{panes[sec]}</div>
          </main>
        </div>
      </div>
      {reset && <ResetSheet onClose={() => setReset(false)} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<SettingsPage />);
