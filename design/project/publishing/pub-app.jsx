/* Publishing Center — assembly: header, segmented tabs, fly-to toast. */

const PUB_TABS = [{ key: 'drafts', label: 'Drafts', icon: 'play' }, { key: 'calendar', label: 'Calendar', icon: 'calendar' }, { key: 'platforms', label: 'Platforms', icon: 'send' }, { key: 'ledger', label: 'Ledger', icon: 'jobs' }];

function PublishingCenter() {
  const [theme, setTheme] = useTheme('light');
  const [tab, setTab] = React.useState('drafts');
  const [toast, setToast] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const tabIdx = PUB_TABS.findIndex(t => t.key === tab);

  React.useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const approve = (id) => {
    const card = document.querySelector(`[data-draft="${id}"]`);
    if (card) { card.classList.add('fly-out'); setTimeout(() => { setToast(true); setTimeout(() => setToast(false), 2400); card.classList.remove('fly-out'); }, 360); }
  };

  return (
    <WindowFrame>
      <Sidebar active="publishing" onNav={navTo} onWorkspace={() => {}} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />
        <main style={{ flex: 1, overflowY: 'auto', padding: '24px 28px 36px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
            <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Publishing</h1>
            <span style={{ flex: 1 }} />
            {/* segmented */}
            <div style={{ position: 'relative', display: 'inline-flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 11 }}>
              <div style={{ position: 'absolute', top: 3, bottom: 3, left: `calc(${tabIdx} * 110px + 3px)`, width: 110, background: 'var(--bg-elevated)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 280ms var(--spring)' }} />
              {PUB_TABS.map(t => (
                <button key={t.key} onClick={() => setTab(t.key)} style={{ position: 'relative', zIndex: 1, width: 110, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 0',
                  font: `${tab === t.key ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`, color: tab === t.key ? 'var(--ink)' : 'var(--ink-secondary)' }}>
                  <Icon name={t.icon} size={15} /> {t.label}
                </button>
              ))}
            </div>
          </div>

          <div key={tab} className="tab-fade">
            {tab === 'drafts' && <React.Fragment>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>
                <Icon name="shield" size={14} style={{ color: 'var(--green)' }} /> The studio's output lands here first. Nothing publishes without you.
              </div>
              <DraftsGrid onApprove={approve} />
            </React.Fragment>}
            {tab === 'calendar' && <PubCalendar />}
            {tab === 'platforms' && <PlatformsTab />}
            {tab === 'ledger' && <React.Fragment>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <span style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>Append-only · read-only · exportable</span>
                <span style={{ flex: 1 }} />
                <button className="ghost-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}><Icon name="enter" size={14} style={{ transform: 'rotate(-90deg)' }} /> Export</button>
              </div>
              <LedgerTab />
            </React.Fragment>}
          </div>
        </main>
      </div>
      {toast && (
        <div className="toast" style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 90, display: 'inline-flex', alignItems: 'center', gap: 10, height: 46, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--on-glass)', color: 'var(--bg-elevated)', boxShadow: '0 12px 32px rgba(10,15,40,0.4)' }}>
          <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--green)', display: 'grid', placeItems: 'center' }}><Icon name="calendar" size={12} style={{ color: '#fff' }} /></span>
          <span style={{ font: '600 var(--fs-subhead)/1 var(--font-text)' }}>Scheduled · added to the calendar</span>
        </div>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<PublishingCenter />);
