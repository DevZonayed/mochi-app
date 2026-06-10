/* Audit Log & Run History — assembly. Uses ShapeChip from pd-jobs. */

const AU_TABS = [{ key: 'runs', label: 'Runs', icon: 'play' }, { key: 'audit', label: 'Audit', icon: 'shield' }];

function AuditPage() {
  const [theme, setTheme] = useTheme('light');
  const [tab, setTab] = React.useState('runs');
  const [replay, setReplay] = React.useState(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const ti = AU_TABS.findIndex(t => t.key === tab);

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 22 }}>
            <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>History</h1>
            <span style={{ flex: 1 }} />
            <div style={{ position: 'relative', display: 'inline-flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 11 }}>
              <div style={{ position: 'absolute', top: 3, bottom: 3, left: `calc(${ti} * 104px + 3px)`, width: 104, background: 'var(--bg-elevated)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 280ms var(--spring)' }} />
              {AU_TABS.map(t => <button key={t.key} onClick={() => setTab(t.key)} style={{ position: 'relative', zIndex: 1, width: 104, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 0', font: `${tab === t.key ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`, color: tab === t.key ? 'var(--ink)' : 'var(--ink-secondary)' }}><Icon name={t.icon} size={15} /> {t.label}</button>)}
            </div>
          </div>
          <div key={tab} className="tab-fade">
            {tab === 'runs' ? <RunsTab onOpen={setReplay} /> : <AuditTab broken={false} />}
          </div>
        </main>
      </div>
      {replay && <ReplayOverlay run={replay} onClose={() => setReplay(null)} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<AuditPage />);
