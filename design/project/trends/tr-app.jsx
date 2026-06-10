/* Trend Intelligence — assembly. Indigo accent zone. Depends on PLATFORMS/PGlyph from publishing. */

function TrendIntel() {
  const [theme, setTheme] = useTheme('light');
  const [running, setRunning] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [flyToast, setFlyToast] = React.useState(false);

  React.useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const sendStudio = (id) => {
    const card = document.querySelector(`[data-brief="${id}"]`);
    if (card) { card.classList.add('fly-studio'); setTimeout(() => { card.classList.remove('fly-studio'); setFlyToast(true); setTimeout(() => setFlyToast(false), 2200); }, 420); }
  };

  return (
    <WindowFrame>
      <Sidebar active="trends" onNav={navTo} onWorkspace={() => {}} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <main style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '24px 28px 36px' }}>
            {/* header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22, flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Trends</h1>
              <button className="ctx-pick" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', background: 'color-mix(in srgb, var(--indigo) 12%, transparent)', color: 'var(--indigo)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
                Tech explainers · YouTube <Icon name="chevronDown" size={14} />
              </button>
              <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Refreshed 12 min ago</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => setRunning(r => !r)} className="primary-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--indigo)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(88,86,214,0.3)' }}>
                {running ? <Spinner size={15} color="#fff" /> : <Icon name="telescope" size={16} />} {running ? 'Researching…' : 'Run research now'}
              </button>
            </div>

            <SignalRow />

            <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 14 }}>Content briefs</div>
            {running && (
              <div className="brief-card" style={{ background: 'var(--bg-elevated)', borderRadius: 18, border: '1px solid color-mix(in srgb, var(--indigo) 30%, transparent)', boxShadow: '0 0 0 4px color-mix(in srgb, var(--indigo) 10%, transparent), var(--card-shadow)', padding: 22, marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
                  <Spinner size={16} color="var(--indigo)" /><span style={{ font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>Generating brief…</span>
                </div>
                {['Scanning 1,240 recent uploads in this genre', 'Clustering hooks by retention curve', 'Drafting title variants', 'Scoring thumbnail concepts'].map((l, i) => (
                  <div key={i} className="stream-bullet" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0', font: '400 var(--fs-subhead)/1.4 var(--font-mono)', color: 'var(--ink-secondary)', animationDelay: `${i * 0.3}s` }}>
                    <span style={{ color: 'var(--indigo)' }}>›</span> {l}
                  </div>
                ))}
              </div>
            )}
            {BRIEFS.map(b => <BriefCard key={b.id} b={b} live={false} onStudio={sendStudio} />)}
          </main>
          <ResearchRail />
        </div>
      </div>
      {flyToast && (
        <div className="toast" style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 90, display: 'inline-flex', alignItems: 'center', gap: 10, height: 46, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--on-glass)', color: 'var(--bg-elevated)', boxShadow: '0 12px 32px rgba(10,15,40,0.4)' }}>
          <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--teal)', display: 'grid', placeItems: 'center' }}><Icon name="clapper" size={12} style={{ color: '#fff' }} /></span>
          <span style={{ font: '600 var(--fs-subhead)/1 var(--font-text)' }}>Sent to Studio · pre-filled brief</span>
        </div>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<TrendIntel />);
