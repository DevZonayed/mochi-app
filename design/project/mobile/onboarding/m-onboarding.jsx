/* Mobile M01 — Onboarding & QR Pairing (welcome → scanner → confirm → paired). */

function Welcome({ onNext }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, #0E2A5E, #06070d)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 32px', color: '#fff' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
        <div style={{ filter: 'drop-shadow(0 16px 40px rgba(94,139,255,0.5))', marginBottom: 28 }}><MaestroMark size={96} /></div>
        <h1 style={{ margin: '0 0 14px', font: '700 32px/1.1 var(--font-display)', letterSpacing: '-0.02em' }}>Your fleet,<br/>in your pocket.</h1>
        <p style={{ margin: 0, font: '400 17px/1.5 var(--font-text)', color: 'rgba(255,255,255,0.7)', maxWidth: 300 }}>Approve, watch, and steer the agents running on your Mac.</p>
      </div>
      <button onClick={onNext} className="m-pill" style={{ width: '100%', height: 54, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 17px/1 var(--font-text)', boxShadow: '0 8px 24px rgba(0,122,255,0.4)', marginBottom: 14 }}>Pair with your Mac</button>
      <button style={{ font: '500 15px/1 var(--font-text)', color: 'rgba(255,255,255,0.6)', marginBottom: 34 }}>What gets synced?</button>
    </div>
  );
}

function Scanner({ onScan }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#0a0b10', display: 'flex', flexDirection: 'column', alignItems: 'center', color: '#fff' }}>
      <div style={{ padding: '20px 32px 0', textAlign: 'center' }}>
        <div style={{ font: '600 17px/1.4 var(--font-text)', color: '#fff' }}>Scan the code on your Mac</div>
        <div style={{ font: '400 14px/1.3 var(--font-text)', color: 'rgba(255,255,255,0.55)', marginTop: 4 }}>Settings ▸ Devices</div>
      </div>
      <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
        <div style={{ position: 'relative', width: 230, height: 230 }}>
          {[[0, 0, '6px 0 0 0'], [0, 'r', '0 6px 0 0'], ['b', 0, '0 0 0 6px'], ['b', 'r', '0 0 6px 0']].map((c, i) => (
            <span key={i} className="scan-bracket" style={{ position: 'absolute', width: 38, height: 38, [c[0] === 'b' ? 'bottom' : 'top']: 0, [c[1] === 'r' ? 'right' : 'left']: 0,
              borderTop: c[0] !== 'b' ? '4px solid var(--blue)' : 'none', borderBottom: c[0] === 'b' ? '4px solid var(--blue)' : 'none', borderLeft: c[1] !== 'r' ? '4px solid var(--blue)' : 'none', borderRight: c[1] === 'r' ? '4px solid var(--blue)' : 'none', borderRadius: c[2] }} />
          ))}
          <div onClick={onScan} style={{ position: 'absolute', inset: 28, borderRadius: 18, background: '#fff', padding: 14, cursor: 'pointer' }}><MQR size={146} /></div>
          <span className="scan-shimmer" style={{ position: 'absolute', left: 28, right: 28, height: 3, top: 28, background: 'linear-gradient(90deg, transparent, var(--blue), transparent)', borderRadius: 2 }} />
        </div>
      </div>
      <button style={{ font: '600 16px/1 var(--font-text)', color: 'var(--blue)', marginBottom: 40 }}>Enter code instead</button>
    </div>
  );
}

function MQR({ size = 146 }) {
  const N = 21, cell = size / N; let s = 99; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const fn = (r, c) => { const b = (br, bc) => r >= br && r < br + 7 && c >= bc && c < bc + 7; return b(0, 0) || b(0, N - 7) || b(N - 7, 0); };
  const cells = []; for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { if (fn(r, c)) continue; if (rnd() > 0.5) cells.push(<rect key={`${r}-${c}`} x={c * cell} y={r * cell} width={cell} height={cell} />); }
  const F = (x, y) => <g><rect x={x} y={y} width={cell * 7} height={cell * 7} rx={cell} fill="none" stroke="#000" strokeWidth={cell} /><rect x={x + cell * 2} y={y + cell * 2} width={cell * 3} height={cell * 3} fill="#000" /></g>;
  return <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="#000" shapeRendering="crispEdges">{cells}{F(0, 0)}{F(size - cell * 7, 0)}{F(0, size - cell * 7)}</svg>;
}

function Confirm({ onConfirm, paired }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#0a0b10', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div className="m-sheet" style={{ background: 'var(--bg)', borderRadius: '16px 16px 0 0', padding: '10px 24px 36px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}><span style={{ width: 36, height: 5, borderRadius: 3, background: 'var(--separator-strong)' }} /></div>
        {paired ? (
          <div style={{ textAlign: 'center', padding: '10px 0 6px' }}>
            <span className="check-pop" style={{ display: 'inline-grid', placeItems: 'center', width: 72, height: 72, borderRadius: 36, background: 'var(--green)', color: '#fff', marginBottom: 18, boxShadow: '0 12px 36px rgba(52,199,89,0.4)' }}><Icon name="check" size={38} stroke={3} /></span>
            <h2 style={{ margin: '0 0 10px', font: '700 24px/1.1 var(--font-display)', color: 'var(--ink)' }}>Paired</h2>
            <p style={{ margin: '0 0 22px', font: '400 16px/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>Gates and finished jobs will arrive as notifications — enable to approve from anywhere.</p>
            <a href="../home/Home.html" className="m-pill" style={{ display: 'block', height: 52, lineHeight: '52px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 17px/52px var(--font-text)', textDecoration: 'none', boxShadow: '0 6px 18px rgba(0,122,255,0.32)' }}>Enable notifications</a>
          </div>
        ) : (
          <React.Fragment>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 16, borderRadius: 14, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', marginBottom: 12 }}>
              <span style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--fill-secondary)', display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="cpu" size={22} /></span>
              <div style={{ flex: 1 }}><div style={{ font: '600 17px/1.1 var(--font-text)', color: 'var(--ink)' }}>Jillur's MacBook Pro</div><div style={{ font: '400 14px/1 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 3 }}>Atlas Studio workspace</div></div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '12px 14px', borderRadius: 12, background: 'rgba(52,199,89,0.08)', border: '0.5px solid rgba(52,199,89,0.25)', marginBottom: 18 }}>
              <Icon name="lock" size={15} style={{ color: 'var(--green)', flexShrink: 0 }} /><span style={{ font: '400 13px/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>End-to-end encrypted · the relay sees only ciphertext.</span>
            </div>
            <button onClick={onConfirm} className="m-pill" style={{ width: '100%', height: 54, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 17px/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.32)' }}>Confirm pairing</button>
          </React.Fragment>
        )}
      </div>
    </div>
  );
}

function Onboarding() {
  const [theme] = useTheme('dark');
  const [step, setStep] = React.useState(0); // 0 welcome 1 scanner 2 confirm 3 paired
  return (
    <PhoneFrame noScroll statusTint="#fff" bg="#0a0b10">
      {step === 0 && <Welcome onNext={() => setStep(1)} />}
      {step === 1 && <Scanner onScan={() => setStep(2)} />}
      {step === 2 && <Confirm onConfirm={() => setStep(3)} paired={false} />}
      {step === 3 && <Confirm paired={true} />}
      {/* tiny step nav for review */}
      <div style={{ position: 'absolute', top: 60, right: 16, zIndex: 40, display: 'flex', gap: 4, padding: 3, borderRadius: 20, background: 'rgba(255,255,255,0.12)', backdropFilter: 'blur(10px)' }}>
        {['1', '2', '3', '✓'].map((l, i) => <button key={i} onClick={() => setStep(i)} style={{ width: 22, height: 22, borderRadius: 11, font: '600 11px/1 var(--font-mono)', background: step === i ? '#fff' : 'transparent', color: step === i ? '#000' : 'rgba(255,255,255,0.7)' }}>{l}</button>)}
      </div>
    </PhoneFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Onboarding />);
