/* Approvals Center — assembly: split view, action bar, auto-advance,
   over-budget confirm sheet, empty state. */

function ActionKey({ children }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, height: 18, padding: '0 4px', borderRadius: 5,
    background: 'rgba(255,255,255,0.22)', font: '600 var(--fs-caption)/1 var(--font-mono)' }}>{children}</span>;
}

function ApprovalsCenter() {
  const [theme, setTheme] = useTheme('light');
  const [gates, setGates] = React.useState(GATES);
  const [activeId, setActiveId] = React.useState(GATES[0].id);
  const [confirm, setConfirm] = React.useState(false);
  const [resolvedToast, setResolvedToast] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  const active = gates.find(g => g.id === activeId);

  const advance = (id) => {
    const idx = gates.findIndex(g => g.id === id);
    const next = gates[idx + 1] || gates[idx - 1];
    setGates(gs => gs.filter(g => g.id !== id));
    setActiveId(next ? next.id : null);
  };

  const decide = (id) => {
    const row = document.querySelector(`[data-qrow="${id}"]`);
    advance(id);
  };

  const approve = () => {
    if (!active) return;
    if (active.type === 'budget') { setConfirm(true); return; }
    decide(active.id);
  };
  const confirmRaise = () => { setConfirm(false); if (active) decide(active.id); };

  React.useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); approve(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); if (active) decide(active.id); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [active, gates]);

  return (
    <WindowFrame>
      <Sidebar active="approvals" onNav={navTo} onWorkspace={() => {}} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <QueueListWrap gates={gates} activeId={activeId} onPick={g => setActiveId(g.id)} />

          {/* detail + action bar */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {active ? (
              <React.Fragment>
                <div style={{ flex: 1, overflowY: 'auto', padding: '28px 28px 28px' }} key={active.id} className="detail-fade">
                  <GateDetail g={active} onRaise={() => setConfirm(true)} />
                </div>
                <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '13px 24px',
                  background: 'var(--glass-tint)', backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)', borderTop: '0.5px solid var(--separator)' }}>
                  <button onClick={approve} className="primary-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 9, height: 42, padding: '0 20px', borderRadius: 'var(--r-pill)',
                    background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.32)' }}>
                    <Icon name="check" size={17} /> {active.type === 'budget' ? 'Raise & approve' : 'Approve'} <ActionKey>⌘↩</ActionKey>
                  </button>
                  <button className="ghost-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 42, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>
                    <Icon name="sliders" size={16} /> Edit
                  </button>
                  <button className="ghost-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 42, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>
                    <Icon name="command" size={16} /> Respond
                  </button>
                  <span style={{ flex: 1 }} />
                  <button onClick={() => active && decide(active.id)} className="reject-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 42, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'transparent', color: 'var(--red)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>
                    Reject <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, height: 18, padding: '0 4px', borderRadius: 5, background: 'rgba(255,59,48,0.14)', font: '600 var(--fs-caption)/1 var(--font-mono)' }}>⌘⌫</span>
                  </button>
                </div>
              </React.Fragment>
            ) : <EmptyApprovals />}
          </div>
        </div>
      </div>

      {confirm && <RaiseSheet onClose={() => setConfirm(false)} onConfirm={confirmRaise} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

// wrap to stamp data-qrow for potential row animation
function QueueListWrap(props) { return <QueueList {...props} />; }

function RaiseSheet({ onClose, onConfirm }) {
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 40,
      background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 400, textAlign: 'center', background: 'var(--bg-elevated)', borderRadius: 18,
        border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', padding: '26px 24px 20px' }}>
        <span style={{ display: 'inline-grid', placeItems: 'center', width: 50, height: 50, borderRadius: '50%', background: 'rgba(255,149,0,0.14)', color: 'var(--orange)', marginBottom: 15 }}><Icon name="gauge" size={25} /></span>
        <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Raise this project’s cap to $60?</h2>
        <p style={{ margin: '0 0 20px', font: '400 var(--fs-subhead)/1.45 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>Market Scan’s monthly ceiling goes from $50 to $60. The run continues immediately.</p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={onConfirm} className="primary-cta" style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Raise &amp; approve</button>
        </div>
      </div>
    </div>
  );
}

function EmptyApprovals() {
  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 40 }}>
      <div style={{ textAlign: 'center', maxWidth: 400 }}>
        <span style={{ display: 'inline-grid', placeItems: 'center', width: 76, height: 76, borderRadius: '50%', background: 'rgba(52,199,89,0.14)', color: 'var(--green)', marginBottom: 22 }}>
          <Icon name="check" size={40} stroke={2.4} />
        </span>
        <h2 style={{ margin: '0 0 10px', font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>All clear</h2>
        <p style={{ margin: 0, font: '400 var(--fs-body)/1.5 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>Decisions will queue here — and on your phone. You’ll get a nudge the moment an agent needs you.</p>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<ApprovalsCenter />);
