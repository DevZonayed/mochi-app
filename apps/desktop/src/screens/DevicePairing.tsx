/* Maestro — Pair a Phone.
   Ported from the Babel-standalone prototype (design/project/device-pairing/*.jsx)
   to an ES-module TypeScript React screen. Visual output is unchanged: a
   floating macOS window with an animated blue/purple backdrop and a centered
   frosted glass card that morphs through the pairing states
   (waiting → detected → paired, plus expired & error).

   This is a full-window experience (no AppShell sidebar): it renders its own
   chrome exactly as the prototype did. */

import React from 'react';
import { Icon } from '../lib/icons';
import { useTheme, type Theme } from '../lib/appShell';

const PAIR_W = 1100;
const PAIR_H = 720;

// Page-specific CSS from "Pair a Phone.html" <style>. Rendered as a <style>
// child so the hover/animation class hooks still work.
const styles = `
  @keyframes spin { to { transform: rotate(360deg); } }
  body { background: #b9bccb; } [data-theme="dark"] body { background: #0a0b10; }
  .backdrop { position: absolute; inset: 0; overflow: hidden; z-index: 0; }
  .blob { position: absolute; border-radius: 50%; filter: blur(48px); opacity: 0.7; }
  [data-theme="dark"] .blob { mix-blend-mode: screen; opacity: 0.85; }
  .b1 { width: 620px; height: 620px; top: -160px; left: -120px; background: radial-gradient(circle, var(--blob-a), transparent 62%); animation: drift1 24s ease-in-out infinite; }
  .b2 { width: 580px; height: 580px; bottom: -200px; right: -140px; background: radial-gradient(circle, var(--blob-b), transparent 62%); animation: drift2 29s ease-in-out infinite; }
  .b3 { width: 480px; height: 480px; top: 24%; left: 40%; opacity: 0.5; background: radial-gradient(circle, var(--blob-c), transparent 60%); animation: drift3 34s ease-in-out infinite; }
  @keyframes drift1 { 0%,100% { transform: none; } 50% { transform: translate(70px,50px) scale(1.08); } }
  @keyframes drift2 { 0%,100% { transform: none; } 50% { transform: translate(-60px,-40px) scale(1.1); } }
  @keyframes drift3 { 0%,100% { transform: none; } 50% { transform: translate(-50px,60px) scale(0.92); } }

  .card-swap { animation: cardSwap 360ms var(--spring); }
  @keyframes cardSwap { from { transform: translateY(8px) scale(0.985); } to { transform: none; } }
  .check-pop { animation: checkPop 460ms var(--spring); }
  @keyframes checkPop { 0% { transform: scale(0.4); } 60% { transform: scale(1.12); } 100% { transform: scale(1); } }
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .ghost-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }

  /* detection rings */
  .ring-pulse { position: absolute; border-radius: 50%; border: 2px solid var(--blue); opacity: 0; }
  .r1 { inset: 0; animation: ringOut 2s ease-out infinite; }
  .r2 { inset: 0; animation: ringOut 2s ease-out infinite 0.66s; }
  .r3 { inset: 0; animation: ringOut 2s ease-out infinite 1.33s; }
  @keyframes ringOut { 0% { transform: scale(0.5); opacity: 0.6; } 100% { transform: scale(1.1); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .ring-pulse { display: none; } }
  ::selection { background: rgba(0,122,255,0.22); }
`;

type PairState = 'waiting' | 'detected' | 'paired' | 'expired' | 'error';

function QRTile({ size = 200 }: { size?: number }) {
  const N = 25, cell = size / N;
  let s = 4242;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const finder = (r: number, c: number) => {
    const b = (br: number, bc: number) => r >= br && r < br + 7 && c >= bc && c < bc + 7;
    return b(0, 0) || b(0, N - 7) || b(N - 7, 0);
  };
  const cells: React.ReactNode[] = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (finder(r, c)) continue;
    if (rnd() > 0.5) cells.push(<rect key={`${r}-${c}`} x={c * cell} y={r * cell} width={cell} height={cell} rx={cell * 0.2} />);
  }
  const F = (x: number, y: number) => (
    <g>
      <rect x={x} y={y} width={cell * 7} height={cell * 7} rx={cell * 1.6} fill="none" stroke="#000" strokeWidth={cell} />
      <rect x={x + cell * 2} y={y + cell * 2} width={cell * 3} height={cell * 3} rx={cell * 0.8} fill="#000" />
    </g>
  );
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="#000" shapeRendering="crispEdges">
      {cells}{F(0, 0)}{F(size - cell * 7, 0)}{F(0, size - cell * 7)}
    </svg>
  );
}

interface PairCardProps {
  state: PairState;
  secs: number;
  onRegen: () => void;
  onState?: (s: PairState) => void;
}

function PairCard({ state, secs, onRegen }: PairCardProps) {
  const total = 120;
  const frac = secs / total;
  const R = 130, C = 2 * Math.PI * R;
  const amber = secs <= 20;
  const mm = Math.floor(secs / 60), ss = String(secs % 60).padStart(2, '0');

  return (
    <div className="pair-card" style={{ width: 480, padding: 36, borderRadius: 'var(--r-card)', background: 'var(--glass-tint)',
      backdropFilter: 'blur(34px) saturate(180%)', WebkitBackdropFilter: 'blur(34px) saturate(180%)', border: '0.5px solid var(--glass-border)',
      boxShadow: 'var(--card-shadow), var(--glass-inner)', textAlign: 'center' }}>

      {(state === 'waiting' || state === 'expired') && (
        <React.Fragment>
          <h1 style={{ margin: '0 0 8px', font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Pair your iPhone</h1>
          <p style={{ margin: '0 0 26px', font: '400 var(--fs-body)/1.45 var(--font-text)', color: 'var(--ink-secondary)' }}>Approve gates, watch runs, and get results anywhere.</p>
          <div style={{ position: 'relative', width: 280, height: 280, margin: '0 auto 22px' }}>
            <svg width="280" height="280" viewBox="0 0 280 280" style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}>
              <circle cx="140" cy="140" r={R} fill="none" stroke="var(--fill-secondary)" strokeWidth="4" />
              {state === 'waiting' && <circle cx="140" cy="140" r={R} fill="none" stroke={amber ? 'var(--orange)' : 'var(--blue)'} strokeWidth="4" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - frac)} style={{ transition: 'stroke-dashoffset 1s linear' }} />}
            </svg>
            <div style={{ position: 'absolute', inset: 34, borderRadius: 24, background: '#fff', display: 'grid', placeItems: 'center', boxShadow: '0 8px 28px rgba(0,0,0,0.12)' }}>
              <QRTile size={176} />
              {state === 'expired' && <div style={{ position: 'absolute', inset: 0, borderRadius: 24, background: 'rgba(255,255,255,0.86)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
                <span style={{ font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>Code expired</span>
              </div>}
            </div>
          </div>
          {state === 'waiting' ? (
            <React.Fragment>
              <div style={{ font: '600 var(--fs-callout)/1 var(--font-mono)', letterSpacing: '0.16em', color: 'var(--ink)' }}>H4KQ-92</div>
              <div style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 6 }}>Manual code · expires in {mm}:{ss}</div>
            </React.Fragment>
          ) : (
            <button onClick={onRegen} className="primary-cta" style={{ height: 44, padding: '0 22px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Generate new code</button>
          )}
        </React.Fragment>
      )}

      {state === 'detected' && (
        <div style={{ padding: '20px 0' }}>
          <div style={{ position: 'relative', width: 180, height: 180, margin: '0 auto 26px', display: 'grid', placeItems: 'center' }}>
            <span className="ring-pulse r1" /><span className="ring-pulse r2" /><span className="ring-pulse r3" />
            <span style={{ position: 'relative', width: 88, height: 88, borderRadius: 24, background: 'color-mix(in srgb, var(--blue) 14%, var(--bg-elevated))', display: 'grid', placeItems: 'center', color: 'var(--blue)', zIndex: 1 }}><Icon name="smartphone" size={42} /></span>
          </div>
          <h1 style={{ margin: '0 0 8px', font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Confirming on your iPhone…</h1>
          <p style={{ margin: 0, font: '400 var(--fs-body)/1.45 var(--font-text)', color: 'var(--ink-secondary)' }}>Approve the pairing request on your phone to finish.</p>
        </div>
      )}

      {state === 'paired' && (
        <div style={{ padding: '12px 0' }}>
          <span className="check-pop" style={{ display: 'inline-grid', placeItems: 'center', width: 76, height: 76, borderRadius: '50%', background: 'var(--green)', color: '#fff', marginBottom: 20, boxShadow: '0 12px 36px rgba(52,199,89,0.42)' }}><Icon name="check" size={40} stroke={3} /></span>
          <h1 style={{ margin: '0 0 18px', font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Paired</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', marginBottom: 14 }}>
            <span style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--teal) 14%, transparent)', color: 'var(--teal)', flexShrink: 0 }}><Icon name="smartphone" size={20} /></span>
            <span style={{ flex: 1, textAlign: 'left' }}>
              <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Jillur’s iPhone 15 Pro</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--green)', marginTop: 3 }}><Icon name="lock" size={11} /> End-to-end encrypted</span>
            </span>
          </div>
          <button className="ghost-btn" style={{ height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Send a test notification</button>
          <div style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 16 }}>Taking you to Settings ▸ Devices…</div>
        </div>
      )}

      {state === 'error' && (
        <div style={{ padding: '12px 0' }}>
          <span style={{ display: 'inline-grid', placeItems: 'center', width: 72, height: 72, borderRadius: '50%', background: 'rgba(255,59,48,0.14)', color: 'var(--red)', marginBottom: 20 }}><Icon name="xCircle" size={40} /></span>
          <h1 style={{ margin: '0 0 8px', font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Couldn’t verify the device</h1>
          <p style={{ margin: '0 0 22px', font: '400 var(--fs-body)/1.45 var(--font-text)', color: 'var(--ink-secondary)' }}>Generate a new code and try again.</p>
          <button onClick={onRegen} className="primary-cta" style={{ height: 44, padding: '0 22px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Generate new code</button>
        </div>
      )}

      {/* steps + footnote (only on waiting) */}
      {state === 'waiting' && (
        <React.Fragment>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, margin: '24px 0 18px' }}>
            {['Open Maestro', 'Tap Pair', 'Scan'].map((label, i) => (
              <React.Fragment key={i}>
                {i > 0 && <Icon name="chevronRight" size={13} style={{ color: 'var(--ink-tertiary)' }} />}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
                  <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--fill-secondary)', display: 'grid', placeItems: 'center', font: '700 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{i + 1}</span>{label}
                </span>
              </React.Fragment>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '11px 14px', borderRadius: 12, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', textAlign: 'left' }}>
            <Icon name="shield" size={15} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 1 }} />
            <span style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>End-to-end encrypted. The relay only ever sees ciphertext. No ports opened on this Mac.</span>
          </div>
        </React.Fragment>
      )}
    </div>
  );
}

function useScalePair(): number {
  const [s, setS] = React.useState(1);
  React.useLayoutEffect(() => {
    const fit = () => setS(Math.min((window.innerWidth - 48) / PAIR_W, (window.innerHeight - 48) / PAIR_H, 1));
    fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit);
  }, []);
  return s;
}

export default function DevicePairing() {
  const [theme, setTheme] = useTheme('light');
  const [state, setState] = React.useState<PairState>('waiting');
  const [secs, setSecs] = React.useState(120);
  const scale = useScalePair();

  // countdown
  React.useEffect(() => {
    if (state !== 'waiting') return;
    const t = setInterval(() => setSecs((s: number) => { if (s <= 1) { clearInterval(t); setState('expired'); return 0; } return s - 1; }), 1000);
    return () => clearInterval(t);
  }, [state]);

  // auto demo: waiting → detected → paired
  React.useEffect(() => {
    if (state !== 'waiting') return;
    const t = setTimeout(() => setState('detected'), 5000);
    return () => clearTimeout(t);
  }, [state]);
  React.useEffect(() => {
    if (state !== 'detected') return;
    const t = setTimeout(() => setState('paired'), 2600);
    return () => clearTimeout(t);
  }, [state]);

  const regen = () => { setSecs(120); setState('waiting'); };

  const stateTabs: [PairState, string][] = [['waiting', 'Waiting'], ['detected', 'Detected'], ['paired', 'Paired'], ['expired', 'Expired'], ['error', 'Error']];
  const themeTabs: [Theme, 'sun' | 'moon'][] = [['light', 'sun'], ['dark', 'moon']];

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      <style>{styles}</style>
      <div className="win-drag" style={{ width: '100%', height: '100%', overflow: 'hidden', position: 'relative', background: 'var(--backdrop-base)' }}>
        <div className="backdrop" aria-hidden="true"><span className="blob b1" /><span className="blob b2" /><span className="blob b3" /></div>

        {/* demo state switch */}
        <div style={{ position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 30, display: 'inline-flex', padding: 3, borderRadius: 'var(--r-pill)', background: 'var(--glass-tint)', border: '0.5px solid var(--glass-border)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
          {stateTabs.map(([k, l]) => (
            <button key={k} onClick={() => { setState(k); if (k === 'waiting') setSecs(120); }} style={{ height: 26, padding: '0 11px', borderRadius: 'var(--r-pill)', font: '600 var(--fs-caption)/1 var(--font-text)', background: state === k ? 'var(--bg-elevated)' : 'transparent', color: state === k ? 'var(--ink)' : 'var(--on-glass)', boxShadow: state === k ? '0 1px 3px rgba(0,0,0,0.18)' : 'none' }}>{l}</button>
          ))}
        </div>

        <div style={{ position: 'absolute', top: 16, right: 18, zIndex: 30, display: 'flex', gap: 2, padding: 3, borderRadius: 'var(--r-pill)', background: 'var(--glass-tint)', border: '0.5px solid var(--glass-border)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
          {themeTabs.map(([t, ic]) => <button key={t} onClick={() => setTheme(t)} style={{ width: 30, height: 26, borderRadius: 'var(--r-pill)', display: 'grid', placeItems: 'center', background: theme === t ? 'var(--bg-elevated)' : 'transparent', color: theme === t ? 'var(--ink)' : 'var(--on-glass)' }}><Icon name={ic} size={15} /></button>)}
        </div>

        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 40, zIndex: 20 }}>
          <div key={state} className="card-swap"><PairCard state={state} secs={secs} onRegen={regen} /></div>
        </div>
      </div>
    </div>
  );
}
