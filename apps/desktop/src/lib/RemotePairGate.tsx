import React from 'react';
import { IS_LOCAL, isUnpaired, onUnpaired, repair, unpairReason } from './api';

/* Browser-remote re-pair gate. Shows a code-entry screen when the relay has no
   valid token for this device — first visit, after the Mac disconnects this
   device, or after the code is regenerated. The desktop app (IS_LOCAL) owns the
   token directly and never sees this gate. */
export function RemotePairGate({ children }: { children: React.ReactNode }) {
  const [blocked, setBlocked] = React.useState(() => !IS_LOCAL && isUnpaired());
  const [reason, setReason] = React.useState(() => unpairReason());
  React.useEffect(() => {
    if (IS_LOCAL) return;
    return onUnpaired((r) => { setBlocked(isUnpaired()); setReason(r); });
  }, []);
  if (IS_LOCAL || !blocked) return <>{children}</>;
  return <PairForm reason={reason} onPaired={() => setBlocked(false)} />;
}

function PairForm({ reason, onPaired }: { reason: string; onPaired: () => void }) {
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!c || busy) return;
    setBusy(true); setErr('');
    try { await repair(c); onPaired(); }
    catch { setErr('That code didn’t match. Open Settings ▸ Devices on your Mac to check it.'); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg, #0b0d18)' }}>
      <form onSubmit={submit} style={{ width: 'min(420px, 100%)', background: 'var(--bg-elevated, #14161f)', border: '0.5px solid var(--glass-border, rgba(255,255,255,0.08))', borderRadius: 20, padding: 28, textAlign: 'center', boxShadow: '0 30px 80px rgba(0,0,0,0.45)' }}>
        <div style={{ width: 52, height: 52, margin: '0 auto 14px', borderRadius: 14, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue, #2f6bff) 16%, transparent)', color: 'var(--blue, #2f6bff)', font: '700 22px/1 var(--font-display, system-ui)' }}>⌘</div>
        <h1 style={{ margin: '0 0 6px', font: '700 var(--fs-title2, 22px)/1.2 var(--font-display, system-ui)', letterSpacing: '-0.01em', color: 'var(--ink, #fff)' }}>Connect to your Mac</h1>
        <p style={{ margin: '0 0 18px', font: '400 var(--fs-subhead, 15px)/1.45 var(--font-text, system-ui)', color: 'var(--ink-secondary, #9aa0ad)', textWrap: 'pretty' }}>
          {reason ? reason : 'Enter the pairing code from the Maestro desktop app (Settings ▸ Devices).'}
        </p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          autoFocus
          spellCheck={false}
          autoCapitalize="characters"
          placeholder="XXXX-XXXX-XXXX"
          style={{ width: '100%', height: 50, textAlign: 'center', border: '1.5px solid var(--separator-strong, #2a2d39)', borderRadius: 12, outline: 'none', background: 'var(--fill-tertiary, #1b1e29)', font: '600 var(--fs-headline, 18px)/1 var(--font-mono, ui-monospace)', letterSpacing: '0.12em', color: 'var(--ink, #fff)', marginBottom: 12 }}
        />
        {err && <p style={{ margin: '0 0 12px', font: '500 var(--fs-footnote, 13px)/1.4 var(--font-text, system-ui)', color: 'var(--red, #ff5a52)' }}>{err}</p>}
        <button type="submit" disabled={busy || !code.trim()} style={{ width: '100%', height: 48, borderRadius: 'var(--r-pill, 999px)', border: 'none', cursor: busy || !code.trim() ? 'default' : 'pointer', background: busy || !code.trim() ? 'var(--fill-secondary, #232633)' : 'var(--blue, #2f6bff)', color: busy || !code.trim() ? 'var(--ink-tertiary, #6b7180)' : '#fff', font: '600 var(--fs-callout, 16px)/1 var(--font-text, system-ui)' }}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  );
}
