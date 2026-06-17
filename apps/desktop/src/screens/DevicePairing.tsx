/* Maestro — Pair a Phone (real).
   The Mac generates a persistent pairing code (the relay refuses /api/* without
   it). This screen shows that real code + a scannable QR encoding
   maestro://pair?token=…&relay=…, so the phone can pair by scan or by typing the
   code. Full-window experience: renders its own chrome (blob backdrop + glass
   card), visual style preserved from the prototype. */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { Icon } from '../lib/icons';
import { useTheme, type Theme } from '../lib/appShell';
import { api, type PairingInfo } from '../lib/api';

const PAIR_W = 1100;
const PAIR_H = 720;

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
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .ghost-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  ::selection { background: rgba(0,122,255,0.22); }
`;

function PairCard() {
  const [info, setInfo] = React.useState<PairingInfo | null>(null);
  const [qr, setQr] = React.useState<string>('');
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState('');

  const load = React.useCallback(() => {
    api.getPairing()
      .then((p) => {
        setInfo(p);
        const payload = `maestro://pair?token=${encodeURIComponent(p.token)}&relay=${encodeURIComponent(p.relayUrl)}`;
        QRCode.toDataURL(payload, { margin: 1, width: 320, errorCorrectionLevel: 'M' })
          .then(setQr)
          .catch(() => setError('Could not render the QR code.'));
      })
      .catch(() => setError('Pairing is only available in the desktop app.'));
  }, []);
  React.useEffect(() => { load(); }, [load]);

  const copy = () => {
    if (!info) return;
    try { navigator.clipboard.writeText(info.token); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  };

  return (
    <div className="pair-card" style={{ width: 480, padding: 36, borderRadius: 'var(--r-card)', background: 'var(--glass-tint)',
      backdropFilter: 'blur(34px) saturate(180%)', WebkitBackdropFilter: 'blur(34px) saturate(180%)', border: '0.5px solid var(--glass-border)',
      boxShadow: 'var(--card-shadow), var(--glass-inner)', textAlign: 'center' }}>
      <h1 style={{ margin: '0 0 8px', font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Pair your phone</h1>
      <p style={{ margin: '0 0 26px', font: '400 var(--fs-body)/1.45 var(--font-text)', color: 'var(--ink-secondary)' }}>Approve gates, watch runs, and start jobs from anywhere — they all execute on this Mac.</p>

      <div style={{ width: 232, height: 232, margin: '0 auto 22px', borderRadius: 24, background: '#fff', display: 'grid', placeItems: 'center', boxShadow: '0 8px 28px rgba(0,0,0,0.12)', overflow: 'hidden' }}>
        {qr
          ? <img src={qr} width={200} height={200} alt="Pairing QR code" style={{ display: 'block' }} />
          : <span style={{ width: 26, height: 26, borderRadius: '50%', border: '3px solid var(--fill-secondary)', borderTopColor: 'var(--blue)', animation: 'spin 0.8s linear infinite' }} />}
      </div>

      {info ? (
        <button onClick={copy} title="Copy code" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', border: '0.5px solid var(--separator)', cursor: 'pointer' }}>
          <span style={{ font: '600 var(--fs-callout)/1 var(--font-mono)', letterSpacing: '0.16em', color: 'var(--ink)' }}>{info.token}</span>
          {copied
            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--green)' }}><Icon name="check" size={13} stroke={2.6} /> Copied</span>
            : <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--blue)' }}>Copy</span>}
        </button>
      ) : (
        <div style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: error ? 'var(--red)' : 'var(--ink-tertiary)' }}>{error || 'Loading your code…'}</div>
      )}
      <div style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 8 }}>Scan the QR, or type this code in the Maestro app on your phone.</div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, margin: '24px 0 18px' }}>
        {['Open Maestro on your phone', 'Tap Pair', 'Scan or type'].map((label, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Icon name="chevronRight" size={13} style={{ color: 'var(--ink-tertiary)' }} />}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
              <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--fill-secondary)', display: 'grid', placeItems: 'center', font: '700 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{i + 1}</span>{label}
            </span>
          </React.Fragment>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '11px 14px', borderRadius: 12, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', textAlign: 'left' }}>
        <Icon name="shield" size={15} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 1 }} />
        <span style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>The relay only connects your phone to this Mac — it never sees your code or your data. Keep the code private; anyone with it can control this Mac.</span>
      </div>
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
  const navigate = useNavigate();
  useScalePair();
  const themeTabs: [Theme, 'sun' | 'moon'][] = [['light', 'sun'], ['dark', 'moon']];
  const [paired, setPaired] = React.useState<string | null>(null);

  // Done = back to where pairing was opened from (Settings → Devices). Esc too.
  const close = React.useCallback(() => { navigate('/settings'); }, [navigate]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // When a device actually connects, celebrate briefly then return to Settings.
  React.useEffect(() => {
    let alive = true;
    api.getPairing().then((p) => { if (alive && p.devices?.connected) setPaired(p.devices.name ?? 'Your device'); }).catch(() => {});
    const off = api.subscribe({ onDevices: (d) => { if (d.connected) setPaired(d.name ?? 'Your device'); } });
    return () => { alive = false; off(); };
  }, []);
  React.useEffect(() => {
    if (!paired) return;
    const t = setTimeout(() => navigate('/settings'), 1800);
    return () => clearTimeout(t);
  }, [paired, navigate]);

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      <style>{styles}</style>
      <div className="win-drag" style={{ width: '100%', height: '100%', overflow: 'hidden', position: 'relative', background: 'var(--backdrop-base)' }}>
        <div className="backdrop" aria-hidden="true"><span className="blob b1" /><span className="blob b2" /><span className="blob b3" /></div>

        {/* Success overlay once a device connects. */}
        {paired ? (
          <div style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--backdrop-base) 78%, transparent)', backdropFilter: 'blur(6px)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
              <span style={{ width: 76, height: 76, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--green)', color: '#fff' }}><Icon name="check" size={40} stroke={3} /></span>
              <div style={{ font: '700 var(--fs-title1)/1.1 var(--font-display)', color: 'var(--ink)' }}>Paired</div>
              <div style={{ font: '400 var(--fs-body)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>{paired} is connected.</div>
            </div>
          </div>
        ) : null}

        {/* Done / back — leaving the full-window pairing view (Esc also works). */}
        <button
          className="ghost-btn"
          onClick={close}
          title="Done (Esc)"
          style={{ position: 'absolute', top: 16, left: 18, zIndex: 30, display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 14px 0 10px', borderRadius: 'var(--r-pill)', background: 'var(--glass-tint)', border: '0.5px solid var(--glass-border)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', color: 'var(--ink)', cursor: 'pointer', font: '600 var(--fs-callout)/1 var(--font-text)' }}
        >
          <Icon name="arrowLeft" size={16} /> Done
        </button>

        <div style={{ position: 'absolute', top: 16, right: 18, zIndex: 30, display: 'flex', gap: 2, padding: 3, borderRadius: 'var(--r-pill)', background: 'var(--glass-tint)', border: '0.5px solid var(--glass-border)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
          {themeTabs.map(([t, ic]) => <button key={t} onClick={() => setTheme(t)} style={{ width: 30, height: 26, borderRadius: 'var(--r-pill)', display: 'grid', placeItems: 'center', background: theme === t ? 'var(--bg-elevated)' : 'transparent', color: theme === t ? 'var(--ink)' : 'var(--on-glass)' }}><Icon name={ic} size={15} /></button>)}
        </div>

        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 40, zIndex: 20 }}>
          <PairCard />
        </div>
      </div>
    </div>
  );
}
