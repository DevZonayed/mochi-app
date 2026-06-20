/* Maestro — account sign-in / register.

   The desktop app now gates on an account session (email + password) against the
   account server. This is a full-window experience (no AppShell sidebar): same
   frosted-glass-over-animated-blobs chrome as Onboarding. On success the session
   token is stored + pushed to the main process, which dials the host WebSocket;
   the app then unlocks (see App.tsx gating). */

import React from 'react';
import { Icon, MaestroMark } from '../lib/icons';
import { useTheme, type Theme } from '../lib/appShell';
import { signIn, signUp } from '../lib/auth';

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
  .primary-cta:hover:not(:disabled) { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active:not(:disabled) { transform: translateY(1px); }
  .auth-field:focus-within { border-color: var(--blue); box-shadow: 0 0 0 3px color-mix(in srgb, var(--blue) 18%, transparent); }
  .auth-input { flex: 1; height: 100%; border: none; outline: none; background: transparent; color: var(--ink); font: 400 var(--fs-callout)/1 var(--font-text); }
  .auth-input::placeholder { color: var(--ink-tertiary); }
  .link-btn { background: none; border: none; cursor: pointer; color: var(--blue); font: 600 var(--fs-footnote)/1.4 var(--font-text); }
  ::selection { background: rgba(0,122,255,0.22); }
`;

function Field({ icon, children }: { icon: 'key' | 'lock' | 'user'; children: React.ReactNode }) {
  return (
    <div className="auth-field" style={{ display: 'flex', alignItems: 'center', gap: 10, height: 50, padding: '0 14px', borderRadius: 12, background: 'var(--fill-tertiary)', border: '1px solid var(--separator-strong, var(--separator))', transition: 'border-color 140ms ease, box-shadow 140ms ease' }}>
      <Icon name={icon === 'user' ? 'key' : icon} size={17} style={{ color: 'var(--ink-tertiary)', flexShrink: 0 }} />
      {children}
    </div>
  );
}

function AuthCard() {
  const [mode, setMode] = React.useState<'signin' | 'register'>('signin');
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const isRegister = mode === 'register';
  const canSubmit = email.trim() && password.length >= 1 && (!isRegister || name.trim()) && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setError('');
    try {
      if (isRegister) await signUp({ name, email, password });
      else await signIn({ email, password });
      // On success the auth lib stores the token + notifies the gate, which
      // swaps this screen out for the app. Nothing more to do here.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="pair-card" style={{ width: 420, padding: 36, borderRadius: 'var(--r-card)', background: 'var(--glass-tint)',
      backdropFilter: 'blur(34px) saturate(180%)', WebkitBackdropFilter: 'blur(34px) saturate(180%)', border: '0.5px solid var(--glass-border)',
      boxShadow: 'var(--card-shadow), var(--glass-inner)', textAlign: 'center' }}>
      <div style={{ marginBottom: 18 }}><MaestroMark size={56} /></div>
      <h1 style={{ margin: '0 0 8px', font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>
        {isRegister ? 'Create your account' : 'Welcome back'}
      </h1>
      <p style={{ margin: '0 0 26px', font: '400 var(--fs-body)/1.45 var(--font-text)', color: 'var(--ink-secondary)' }}>
        {isRegister ? 'Sign up to connect this Mac to your account.' : 'Sign in to connect this Mac to your account.'}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'left' }}>
        {isRegister && (
          <Field icon="user">
            <input className="auth-input" type="text" autoComplete="name" placeholder="Your name" value={name}
              onChange={(e) => setName(e.target.value)} autoFocus={isRegister} />
          </Field>
        )}
        <Field icon="key">
          <input className="auth-input" type="email" autoComplete="email" spellCheck={false} placeholder="Email" value={email}
            onChange={(e) => setEmail(e.target.value)} autoFocus={!isRegister} />
        </Field>
        <Field icon="lock">
          <input className="auth-input" type="password" autoComplete={isRegister ? 'new-password' : 'current-password'} placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 14, padding: '10px 12px', borderRadius: 10, background: 'color-mix(in srgb, var(--red) 12%, transparent)', textAlign: 'left' }}>
          <Icon name="alert" size={15} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 1 }} />
          <span style={{ font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--red)' }}>{error}</span>
        </div>
      )}

      <button type="submit" className="primary-cta" disabled={!canSubmit} style={{ width: '100%', height: 48, marginTop: 18, borderRadius: 'var(--r-pill)', border: 'none',
        cursor: canSubmit ? 'pointer' : 'default', background: canSubmit ? 'var(--blue)' : 'var(--fill-secondary)',
        color: canSubmit ? '#fff' : 'var(--ink-tertiary)', font: '600 var(--fs-callout)/1 var(--font-text)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        {busy
          ? <span style={{ width: 18, height: 18, borderRadius: '50%', border: '2.5px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />
          : <>{isRegister ? 'Create account' : 'Sign in'} <Icon name="arrowRight" size={16} /></>}
      </button>

      <div style={{ marginTop: 18, font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>
        {isRegister ? 'Already have an account? ' : 'New to Maestro? '}
        <button type="button" className="link-btn" onClick={() => { setMode(isRegister ? 'signin' : 'register'); setError(''); }}>
          {isRegister ? 'Sign in' : 'Create one'}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 22, padding: '11px 14px', borderRadius: 12, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', textAlign: 'left' }}>
        <Icon name="shield" size={15} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 1 }} />
        <span style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>Your account links this Mac to your phone — all your data and agent runs stay on this Mac.</span>
      </div>
    </form>
  );
}

export default function Login() {
  const [theme, setTheme] = useTheme('light');
  const themeTabs: [Theme, 'sun' | 'moon'][] = [['light', 'sun'], ['dark', 'moon']];
  return (
    <div style={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      <style>{styles}</style>
      <div className="win-drag" style={{ width: '100%', height: '100%', overflow: 'hidden', position: 'relative', background: 'var(--backdrop-base)' }}>
        <div className="backdrop" aria-hidden="true"><span className="blob b1" /><span className="blob b2" /><span className="blob b3" /></div>

        <div style={{ position: 'absolute', top: 16, right: 18, zIndex: 30, display: 'flex', gap: 2, padding: 3, borderRadius: 'var(--r-pill)', background: 'var(--glass-tint)', border: '0.5px solid var(--glass-border)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
          {themeTabs.map(([t, ic]) => <button key={t} onClick={() => setTheme(t)} style={{ width: 30, height: 26, borderRadius: 'var(--r-pill)', display: 'grid', placeItems: 'center', background: theme === t ? 'var(--bg-elevated)' : 'transparent', color: theme === t ? 'var(--ink)' : 'var(--on-glass)' }}><Icon name={ic} size={15} /></button>)}
        </div>

        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 40, zIndex: 20 }}>
          <AuthCard />
        </div>
      </div>
    </div>
  );
}
