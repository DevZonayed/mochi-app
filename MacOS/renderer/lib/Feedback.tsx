/* Feedback collection — a global "!" icon button in the app chrome that opens a
   lightweight modal. Submissions are stored on the Mac (api.submitFeedback) and
   reviewed in the Feedback inbox (/feedback). Self-contained: owns its modal
   state, injects its own keyframes, and overlays with position:fixed so it works
   from wherever the chrome mounts it (general Toolbar + coding/design top nav). */

import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Icon } from './icons';
import { api, IS_LOCAL, type FeedbackCategory } from './api';

/* Map a route path → a human screen label, captured as feedback context so the
   dev knows where the sender was without them having to say. */
const SCREEN_LABEL: Record<string, string> = {
  '/command-center': 'Home', '/workspace': 'CodeSpace', '/design-workspace': 'Design',
  '/projects': 'Projects', '/project-detail': 'Project', '/job-monitor': 'Jobs',
  '/session-transcript': 'Transcript', '/approvals': 'Approvals', '/scheduler': 'Scheduler',
  '/skills-registry': 'Skills', '/templates': 'Templates', '/trends': 'Trends',
  '/media-studio': 'Studio', '/publishing': 'Publishing', '/comms': 'Comms',
  '/budget': 'Costs', '/settings': 'Settings', '/feedback': 'Feedback',
};
function screenLabel(pathname: string): string {
  const key = Object.keys(SCREEN_LABEL).find(k => pathname === k || pathname.startsWith(k + '/'));
  return key ? SCREEN_LABEL[key] : (pathname.replace(/^\//, '') || 'app');
}

const CATEGORIES: { id: FeedbackCategory; label: string; icon: 'alert' | 'spark' | 'chat'; tint: string }[] = [
  { id: 'bug', label: 'Bug', icon: 'alert', tint: 'var(--red)' },
  { id: 'idea', label: 'Idea', icon: 'spark', tint: 'var(--blue)' },
  { id: 'other', label: 'Other', icon: 'chat', tint: 'var(--ink-secondary)' },
];

const STYLES = `
  @keyframes mfFade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes mfPop { from { transform: translateY(-10px) scale(0.98); opacity: 0.6; } to { transform: none; opacity: 1; } }
  .mf-chip { transition: background 140ms ease, border-color 140ms ease, color 140ms ease; }
  .mf-send:not(:disabled):hover { filter: brightness(1.05); }
  .mf-ghost:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
`;

function FeedbackModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [category, setCategory] = React.useState<FeedbackCategory>('idea');
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [done, setDone] = React.useState(false);
  const [version, setVersion] = React.useState('');
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  // Hold the latest submit so the mount-once keydown handler never fires a stale
  // closure (which would always see the initial empty message and no-op).
  const submitRef = React.useRef<() => void>(() => {});

  const screen = screenLabel(location.pathname);
  const platform = (typeof window !== 'undefined' && (window as { maestro?: { platform?: string } }).maestro?.platform) || 'web';

  React.useEffect(() => {
    setTimeout(() => taRef.current?.focus(), 70);
    api.health().then(h => setVersion(h.version)).catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSend = message.trim().length > 0 && !busy;
  const submit = async () => {
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true); setError('');
    try {
      await api.submitFeedback({ category, message: text, source: IS_LOCAL ? 'desktop' : 'web', context: { screen, platform } });
      setDone(true);
      setTimeout(onClose, 1300);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send feedback.');
      setBusy(false);
    }
  };
  submitRef.current = submit; // keep the keydown handler pointed at the live closure

  return (
    <div onMouseDown={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200, display: 'grid', placeItems: 'center', padding: 32,
      background: 'rgba(10,12,24,0.4)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
      animation: 'mfFade 160ms ease',
    }}>
      <style>{STYLES}</style>
      <div onMouseDown={e => e.stopPropagation()} style={{
        width: 460, maxWidth: '100%', background: 'var(--bg-elevated)', borderRadius: 18,
        border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)',
        padding: 22, animation: 'mfPop 220ms var(--spring)',
      }}>
        {done ? (
          <div style={{ padding: '26px 8px', textAlign: 'center' }}>
            <span style={{ display: 'inline-grid', placeItems: 'center', width: 52, height: 52, borderRadius: '50%', background: 'rgba(52,199,89,0.16)', color: 'var(--green)', marginBottom: 14 }}><Icon name="check" size={26} stroke={2.6} /></span>
            <h2 style={{ margin: '0 0 6px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Thanks for the feedback</h2>
            <p style={{ margin: 0, font: '400 var(--fs-subhead)/1.45 var(--font-text)', color: 'var(--ink-secondary)' }}>It’s saved on your Mac — review it any time under Feedback.</p>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
              <span style={{ display: 'inline-grid', placeItems: 'center', width: 40, height: 40, borderRadius: 11, flexShrink: 0, background: 'color-mix(in srgb, var(--blue) 13%, transparent)', color: 'var(--blue)' }}><Icon name="feedback" size={21} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <h2 style={{ margin: 0, font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Send feedback</h2>
                <p style={{ margin: '3px 0 0', font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>Found a bug or have an idea? We read every note.</p>
              </span>
              <button onClick={onClose} aria-label="Close" className="tb-icon" style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', flexShrink: 0 }}><Icon name="x" size={17} /></button>
            </div>

            {/* category chips */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {CATEGORIES.map(c => {
                const on = category === c.id;
                return (
                  <button key={c.id} onClick={() => setCategory(c.id)} className="mf-chip" style={{
                    flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, height: 38, borderRadius: 11,
                    border: `1px solid ${on ? c.tint : 'var(--separator-strong, var(--separator))'}`,
                    background: on ? `color-mix(in srgb, ${c.tint} 13%, transparent)` : 'var(--fill-tertiary)',
                    color: on ? c.tint : 'var(--ink-secondary)', font: `${on ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`,
                  }}>
                    <Icon name={c.icon} size={16} /> {c.label}
                  </button>
                );
              })}
            </div>

            <textarea ref={taRef} value={message} onChange={e => setMessage(e.target.value)}
              placeholder={category === 'bug' ? 'What went wrong? What did you expect?' : category === 'idea' ? 'What would make Maestro better?' : 'Tell us what’s on your mind…'}
              style={{ width: '100%', boxSizing: 'border-box', minHeight: 118, resize: 'vertical', padding: '12px 13px',
                border: '1px solid var(--separator-strong, var(--separator))', borderRadius: 12, outline: 'none',
                background: 'var(--fill-tertiary)', font: '400 var(--fs-body)/1.45 var(--font-text)', color: 'var(--ink)' }} />

            {/* auto-captured context — shown so the sender knows what's attached */}
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 11, font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>
              <Icon name="paperclip" size={12} />
              <span>Attached:</span>
              {[screen, version ? `v${version}` : '', platform].filter(Boolean).map((t, i) => (
                <span key={i} style={{ padding: '2px 7px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)' }}>{t}</span>
              ))}
            </div>

            {error && <p style={{ margin: '12px 0 0', font: '500 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--red)' }}>{error}</p>}

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18 }}>
              <button onClick={() => { onClose(); navigate('/feedback'); }} className="mf-ghost" style={{ height: 40, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'transparent', color: 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>View all feedback</button>
              <div style={{ flex: 1 }} />
              <button onClick={onClose} style={{ height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
              <button onClick={submit} disabled={!canSend} className="mf-send" style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)', background: canSend ? 'var(--blue)' : 'var(--fill-secondary)', color: canSend ? '#fff' : 'var(--ink-tertiary)', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: canSend ? '0 6px 18px rgba(0,122,255,0.32)' : 'none', cursor: canSend ? 'pointer' : 'default' }}>{busy ? 'Sending…' : 'Send'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The chrome affordance: a small "!" speech-bubble icon button. Drops into the
    toolbar icon row (general + coding/design shells) and owns the modal. */
export function FeedbackButton({ size = 18 }: { size?: number }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="Send feedback" title="Send feedback" className="tb-icon win-no-drag" style={{
        width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)',
      }}>
        <Icon name="feedback" size={size} />
      </button>
      {open && <FeedbackModal onClose={() => setOpen(false)} />}
    </>
  );
}
