/* Budget & Cost Governance — assembly: 429 banner, rules, cap-edit sheet. */

function CapEditSheet({ cap, onClose }) {
  const [val, setVal] = React.useState(cap.cap);
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32, background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 400, background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', padding: 24 }}>
        <h2 style={{ margin: '0 0 4px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>{cap.name} cap</h2>
        <p style={{ margin: '0 0 18px', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Hard monthly ceiling for this project.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 4, borderRadius: 12, border: '1.5px solid var(--blue)', marginBottom: 10 }}>
          <button onClick={() => setVal(v => Math.max(5, v - 5))} className="step-btn" style={{ width: 40, height: 40, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 20px/1 var(--font-text)' }}>−</button>
          <span style={{ flex: 1, textAlign: 'center', font: '700 var(--fs-title1)/1 var(--font-mono)', color: 'var(--ink)' }}>${val}</span>
          <button onClick={() => setVal(v => v + 5)} className="step-btn" style={{ width: 40, height: 40, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 20px/1 var(--font-text)' }}>+</button>
        </div>
        <div style={{ font: '500 var(--fs-footnote)/1.4 var(--font-mono)', color: 'var(--ink-secondary)', marginBottom: 18 }}>
          <b style={{ color: 'var(--green)', fontWeight: 600 }}>${(val - cap.spent).toFixed(2)}</b> remaining for jobs after ${cap.spent.toFixed(2)} spent.
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, height: 42, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={onClose} className="primary-cta" style={{ flex: 1, height: 42, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Save cap</button>
        </div>
      </div>
    </div>
  );
}

function RulesSection() {
  const [auto, setAuto] = React.useState(true);
  const [thresh, setThresh] = React.useState(85);
  return (
    <GroupedList header="Cost rules" footer="Auto-downgrade keeps jobs finishing instead of stalling at a cap.">
      <Row>
        <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 13%, transparent)', color: 'var(--blue)' }}><Icon name="cpu" size={18} /></span>
        <span style={{ flex: 1 }}>
          <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Auto-downgrade near a cap</span>
          <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Switch to cheaper models automatically when close to a ceiling.</span>
        </span>
        <Switch on={auto} onChange={setAuto} />
      </Row>
      <Row>
        <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--orange) 13%, transparent)', color: 'var(--orange)' }}><Icon name="gauge" size={18} /></span>
        <span style={{ flex: 1, font: '500 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>Downgrade threshold</span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, background: 'var(--fill-secondary)', borderRadius: 8 }}>
          <button onClick={() => setThresh(t => Math.max(50, t - 5))} className="step-btn" style={{ width: 30, height: 30, borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--ink)', font: '600 17px/1 var(--font-text)' }}>−</button>
          <span style={{ minWidth: 46, textAlign: 'center', font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)' }}>{thresh}%</span>
          <button onClick={() => setThresh(t => Math.min(99, t + 5))} className="step-btn" style={{ width: 30, height: 30, borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--ink)', font: '600 17px/1 var(--font-text)' }}>+</button>
        </div>
      </Row>
      <Row last>
        <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--purple) 13%, transparent)', color: 'var(--purple)' }}><Icon name="bell" size={18} /></span>
        <span style={{ flex: 1, font: '500 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>Notify at</span>
        <span style={{ display: 'flex', gap: 6 }}>{['75%', '90%', 'Cap hit'].map((t, i) => <span key={i} style={{ height: 26, padding: '0 10px', borderRadius: 'var(--r-pill)', display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 12%, transparent)', color: 'var(--blue)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>{t}</span>)}</span>
      </Row>
    </GroupedList>
  );
}

function BudgetDashboard() {
  const [theme, setTheme] = useTheme('light');
  const [editCap, setEditCap] = React.useState(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  React.useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  return (
    <WindowFrame>
      <Sidebar active="budget" onNav={navTo} onWorkspace={() => {}} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />
        <main style={{ flex: 1, overflowY: 'auto', padding: '24px 28px 36px' }}>
          <h1 style={{ margin: '0 0 22px', font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Budget</h1>

          {/* 429 pinned card */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderRadius: 14, background: 'rgba(255,59,48,0.07)', border: '1px solid rgba(255,59,48,0.3)', marginBottom: 24 }}>
            <span style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'rgba(255,59,48,0.14)', color: 'var(--red)' }}><Icon name="alert" size={19} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Market Scan hit its $30 cap and paused</span>
              <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>1 job is waiting · raise the cap or review what's running.</span>
            </span>
            <button onClick={() => setEditCap(CAPS[2])} className="primary-cta" style={{ height: 36, padding: '0 15px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', boxShadow: '0 4px 14px rgba(0,122,255,0.28)' }}>Raise cap</button>
            <button className="ghost-btn" style={{ height: 36, padding: '0 15px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Review jobs</button>
          </div>

          <HeroBand />

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 18, marginBottom: 24, alignItems: 'start' }}>
            <div>
              <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 12 }}>Per-project caps</div>
              <CapsList onEdit={setEditCap} />
            </div>
            <SavingsCard />
          </div>

          <div style={{ marginBottom: 24 }}><Breakdown /></div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', gap: 18, alignItems: 'start' }}>
            <div>
              <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 12 }}>Ledger</div>
              <BgLedger />
            </div>
            <RulesSection />
          </div>
        </main>
      </div>
      {editCap && <CapEditSheet cap={editCap} onClose={() => setEditCap(null)} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<BudgetDashboard />);
