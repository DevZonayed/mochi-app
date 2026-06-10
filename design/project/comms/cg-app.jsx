/* Comms Gateway — assembly + Lane A risk sheet with hold-to-confirm. */

function QRCode({ size = 64 }) {
  const N = 21, cell = size / N;
  let s = 7; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const finder = (r, c) => { const box = (br, bc) => r >= br && r < br + 7 && c >= bc && c < bc + 7; return box(0, 0) || box(0, N - 7) || box(N - 7, 0); };
  const cells = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { if (finder(r, c)) continue; if (rnd() > 0.5) cells.push(<rect key={`${r}-${c}`} x={c * cell} y={r * cell} width={cell} height={cell} />); }
  const F = (x, y) => <g><rect x={x} y={y} width={cell * 7} height={cell * 7} rx={cell} fill="none" stroke="#000" strokeWidth={cell} /><rect x={x + cell * 2} y={y + cell * 2} width={cell * 3} height={cell * 3} fill="#000" /></g>;
  return <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="#000" shapeRendering="crispEdges">{cells}{F(0, 0)}{F(size - cell * 7, 0)}{F(0, size - cell * 7)}</svg>;
}

function HoldToConfirm({ onConfirm }) {
  const [pct, setPct] = React.useState(0);
  const [confirmed, setConfirmed] = React.useState(false);
  const timer = React.useRef(null);
  const start = () => {
    if (confirmed) return;
    const t0 = Date.now();
    timer.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / 1000);
      setPct(p);
      if (p >= 1) { clearInterval(timer.current); setConfirmed(true); setTimeout(onConfirm, 250); }
    }, 16);
  };
  const end = () => { if (!confirmed) { clearInterval(timer.current); setPct(0); } };
  return (
    <button onMouseDown={start} onMouseUp={end} onMouseLeave={end} onTouchStart={start} onTouchEnd={end}
      style={{ position: 'relative', width: '100%', height: 48, borderRadius: 'var(--r-pill)', overflow: 'hidden', background: 'var(--fill-secondary)', userSelect: 'none' }}>
      <span style={{ position: 'absolute', inset: 0, width: `${pct * 100}%`, background: confirmed ? 'var(--green)' : 'var(--orange)', transition: pct === 0 ? 'width 200ms ease' : 'none' }} />
      <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', height: '100%', font: '600 var(--fs-callout)/1 var(--font-text)', color: pct > 0.4 ? '#fff' : 'var(--ink)' }}>
        {confirmed ? <><Icon name="check" size={17} stroke={3} /> Confirmed</> : <><Icon name="lock" size={15} /> Hold to enable Lane A</>}
      </span>
    </button>
  );
}

function RiskSheet({ onClose, onConfirm }) {
  const [typed, setTyped] = React.useState(false);
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32, background: 'rgba(10,12,24,0.4)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 480, background: 'var(--bg-elevated)', borderRadius: 20, border: '1px solid rgba(255,149,0,0.4)', boxShadow: '0 0 0 5px rgba(255,149,0,0.10), 0 40px 100px rgba(10,15,40,0.5)', overflow: 'hidden' }}>
        <div style={{ padding: '24px 24px 18px', textAlign: 'center' }}>
          <span style={{ display: 'inline-grid', placeItems: 'center', width: 54, height: 54, borderRadius: '50%', background: 'rgba(255,149,0,0.14)', color: 'var(--orange)', marginBottom: 16 }}><Icon name="alert" size={27} /></span>
          <h2 style={{ margin: '0 0 10px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Enable Lane A — your own number</h2>
          <p style={{ margin: 0, font: '400 var(--fs-body)/1.5 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>
            Unofficial connection. Accounts get banned — sometimes within weeks. It runs <b style={{ color: 'var(--ink)' }}>isolated</b>; a ban can’t touch your jobs.
          </p>
        </div>
        <div style={{ padding: '0 24px 20px' }}>
          {/* typed confirm */}
          <button onClick={() => setTyped(t => !t)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '12px 14px', borderRadius: 12, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', textAlign: 'left', marginBottom: 14 }}>
            <span style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, display: 'grid', placeItems: 'center', background: typed ? 'var(--orange)' : 'transparent', border: typed ? 'none' : '1.5px solid var(--separator-strong)' }}>{typed && <Icon name="check" size={13} stroke={3} style={{ color: '#fff' }} />}</span>
            <span style={{ font: '500 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink)' }}>I understand this number may be banned, and accept the risk.</span>
          </button>
          {/* QR pairing preview */}
          <div style={{ display: 'flex', gap: 14, padding: 14, borderRadius: 12, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', marginBottom: 16, opacity: typed ? 1 : 0.5, transition: 'opacity 200ms ease' }}>
            <div style={{ width: 76, height: 76, borderRadius: 10, background: '#fff', flexShrink: 0, padding: 6, border: '0.5px solid var(--separator)' }}><QRCode size={64} /></div>
            <div style={{ flex: 1 }}>
              <div style={{ font: '600 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)' }}>Pair with WhatsApp</div>
              <div style={{ font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 4 }}>On your phone: Settings → Linked Devices → Link a Device, then scan.</div>
            </div>
          </div>
          {typed ? <HoldToConfirm onConfirm={onConfirm} /> : <button disabled style={{ width: '100%', height: 48, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink-tertiary)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Confirm the risk first</button>}
          <button onClick={onClose} style={{ width: '100%', height: 40, marginTop: 10, borderRadius: 'var(--r-pill)', background: 'transparent', color: 'var(--ink-secondary)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const CG_TABS = [{ key: 'channels', label: 'Channels' }, { key: 'bindings', label: 'Chat bindings' }, { key: 'activity', label: 'Activity' }];

function CommsGateway() {
  const [theme, setTheme] = useTheme('light');
  const [tab, setTab] = React.useState('channels');
  const [riskOpen, setRiskOpen] = React.useState(false);
  const [laneAOn, setLaneAOn] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const ti = CG_TABS.findIndex(t => t.key === tab);

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
            <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Comms</h1>
            <span style={{ flex: 1 }} />
            <div style={{ position: 'relative', display: 'inline-flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 11 }}>
              <div style={{ position: 'absolute', top: 3, bottom: 3, left: `calc(${ti} * 128px + 3px)`, width: 128, background: 'var(--bg-elevated)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 280ms var(--spring)' }} />
              {CG_TABS.map(t => <button key={t.key} onClick={() => setTab(t.key)} style={{ position: 'relative', zIndex: 1, width: 128, padding: '8px 0', font: `${tab === t.key ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`, color: tab === t.key ? 'var(--ink)' : 'var(--ink-secondary)' }}>{t.label}</button>)}
            </div>
          </div>

          <div key={tab} className="tab-fade">
            {tab === 'channels' && <ChannelsTab laneAOn={laneAOn} onEnableLaneA={() => setRiskOpen(true)} />}
            {tab === 'bindings' && <BindingsTab />}
            {tab === 'activity' && <ActivityTab />}
          </div>
        </main>
      </div>
      {riskOpen && <RiskSheet onClose={() => setRiskOpen(false)} onConfirm={() => { setLaneAOn(true); setRiskOpen(false); }} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<CommsGateway />);
