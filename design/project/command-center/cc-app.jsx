/* Command Center — page assembly. Greeting, needs-you strip, jobs + rail,
   ⌘K palette, live streaming tick, approve micro-interaction. */

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
const TODAY = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

function CommandCenter() {
  const [theme, setTheme] = useTheme('light');
  const [tick, setTick] = React.useState(0);
  const [gates, setGates] = React.useState(GATES);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [spent, setSpent] = React.useState(38.2);

  // streaming ticker
  React.useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 2200); return () => clearInterval(t); }, []);

  // ⌘K
  React.useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const approve = (id) => {
    const card = document.querySelector(`[data-gate="${id}"]`);
    if (card) {
      card.classList.add('gate-approving');
      setTimeout(() => { setGates(g => g.filter(x => x.id !== id)); setSpent(s => +(s + 0.6).toFixed(2)); }, 360);
    } else {
      setGates(g => g.filter(x => x.id !== id));
    }
  };

  return (
    <WindowFrame>
      <Sidebar active="home" onNav={navTo} onWorkspace={() => {}} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)}
          budget={{ spent, cap: 200, animateKey: spent }} />

        <main style={{ flex: 1, overflowY: 'auto', padding: '24px 28px 32px' }}>
          {/* greeting */}
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 22 }}>
            <div>
              <div style={{ font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 5 }}>{TODAY}</div>
              <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>{greeting()}</h1>
            </div>
            <button onClick={() => setPaletteOpen(true)} className="primary-cta" style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)',
              background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)',
              boxShadow: '0 6px 18px rgba(0,122,255,0.30)',
            }}>
              <Icon name="play" size={16} /> Run a job
            </button>
          </div>

          {/* needs-you */}
          <div style={{ marginBottom: 24 }}>
            <NeedsYouStripWrap gates={gates} onApprove={approve} />
          </div>

          {/* jobs + rail */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 340px', gap: 20, alignItems: 'start' }}>
            <ActiveJobs tick={tick} />
            <RightRail />
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

// wrap to attach data-gate for the approve animation
function NeedsYouStripWrap({ gates, onApprove }) {
  if (gates.length === 0) return <NeedsYouStrip gates={gates} onApprove={onApprove} />;
  return (
    <div>
      <ZoneLabel icon="shield" tint="var(--red)">Needs you · {gates.length}</ZoneLabel>
      <div className="needs-scroll" style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 6, scrollbarWidth: 'none' }}>
        {gates.map(g => (
          <div key={g.id} data-gate={g.id} className="gate-card" style={{
            width: 290, flexShrink: 0, background: 'var(--bg-elevated)', borderRadius: 14,
            border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 14,
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center',
                background: `color-mix(in srgb, ${g.tint} 15%, transparent)`, color: g.tint }}>
                <Icon name={g.icon} size={17} />
              </span>
              <ProjectChip id={g.project} />
              <span style={{ flex: 1 }} />
              <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{g.age}</span>
            </div>
            <div>
              <div style={{ font: '600 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty' }}>{g.summary}</div>
              <div style={{ font: '400 var(--fs-caption)/1.3 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 3 }}>{g.meta}</div>
            </div>
            <div className="gate-actions" style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
              <button onClick={() => onApprove(g.id)} style={{
                flex: 1, height: 32, borderRadius: 8, background: 'var(--blue)', color: '#fff',
                font: '600 var(--fs-footnote)/1 var(--font-text)',
              }} className="gate-approve">{g.type === 'budget' ? 'Raise cap' : 'Approve'}</button>
              <button style={{
                flex: 1, height: 32, borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink)',
                font: '600 var(--fs-footnote)/1 var(--font-text)',
              }} className="gate-review">Review</button>
            </div>
            <div className="gate-check" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
              background: 'rgba(52,199,89,0.12)', borderRadius: 14, opacity: 0, pointerEvents: 'none' }}>
              <span style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--green)', color: '#fff', display: 'grid', placeItems: 'center' }}>
                <Icon name="check" size={22} stroke={3} />
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<CommandCenter />);
