/* MCP Gateway — assembly: segmented tabs + scoped-grant confirm sheet. */

const MCP_TABS = [{ key: 'servers', label: 'Servers', icon: 'cpu' }, { key: 'activity', label: 'Live activity', icon: 'bolt' }, { key: 'denials', label: 'Denials', icon: 'lock' }];

function GrantSheet({ denial, onClose }) {
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32, background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 420, background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', padding: 24 }}>
        <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Grant a scoped tool?</h2>
        <p style={{ margin: '0 0 16px', font: '400 var(--fs-subhead)/1.45 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>
          Allow <span style={{ font: '600 var(--fs-subhead) var(--font-mono)', color: 'var(--ink)' }}>{denial.server}.{denial.tool}</span> for <b style={{ color: 'var(--ink)' }}>{MCP_PROJ[denial.job].name}</b> only. Other projects stay denied.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
          {[['Scope', 'This project only'], ['Mode', 'Read-only'], ['Expires', 'Until you revoke']].map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', borderRadius: 10, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)' }}>
              <span style={{ flex: 1, font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{r[0]}</span>
              <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>{r[1]}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={onClose} className="primary-cta" style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Grant access</button>
        </div>
      </div>
    </div>
  );
}

function McpGateway() {
  const [theme, setTheme] = useTheme('light');
  const [tab, setTab] = React.useState('servers');
  const [grant, setGrant] = React.useState(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const ti = MCP_TABS.findIndex(t => t.key === tab);

  React.useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  return (
    <WindowFrame>
      <Sidebar active="" onNav={navTo} onWorkspace={() => {}} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />
        <main style={{ flex: 1, overflowY: 'auto', padding: '24px 28px 36px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10 }}>
            <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Tools &amp; Gateway</h1>
            <span style={{ flex: 1 }} />
            <div style={{ position: 'relative', display: 'inline-flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 11 }}>
              <div style={{ position: 'absolute', top: 3, bottom: 3, left: `calc(${ti} * 120px + 3px)`, width: 120, background: 'var(--bg-elevated)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 280ms var(--spring)' }} />
              {MCP_TABS.map(t => <button key={t.key} onClick={() => setTab(t.key)} style={{ position: 'relative', zIndex: 1, width: 120, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 0', font: `${tab === t.key ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`, color: tab === t.key ? 'var(--ink)' : 'var(--ink-secondary)' }}><Icon name={t.icon} size={15} /> {t.label}</button>)}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>
            <Icon name="shield" size={14} style={{ color: 'var(--green)' }} /> One chokepoint — every tool call passes through the gateway and lands in the audit log.
          </div>

          <div key={tab} className="tab-fade">
            {tab === 'servers' && <ServersTab />}
            {tab === 'activity' && <LiveActivity />}
            {tab === 'denials' && <DenialsTab onAllow={setGrant} />}
          </div>
        </main>
      </div>
      {grant && <GrantSheet denial={grant} onClose={() => setGrant(null)} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<McpGateway />);
