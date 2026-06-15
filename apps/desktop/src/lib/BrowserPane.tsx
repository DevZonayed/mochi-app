/* The in-app Browser tab — a live mirror of this project's real Chrome window.
   The window itself is a real, headed Chrome (so logins/cookies persist and the
   operator can step in for a CAPTCHA via "Show window"); this pane shows a live
   screenshot frame + a URL bar to drive it. Preview bytes come over the desktop-
   only maestro:browserView IPC and never touch the relay. */

import React from 'react';
import { api } from './api';
import { Icon, type IconName } from './icons';

function ToolBtn({ icon, label, onClick, disabled, tone }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; tone?: 'danger' }) {
  return (
    <button onClick={onClick} disabled={disabled} title={label} aria-label={label}
      style={{ display: 'inline-grid', placeItems: 'center', width: 30, height: 30, borderRadius: 8, border: '1px solid var(--hairline)',
        background: 'var(--surface)', color: tone === 'danger' ? 'var(--red, #e5484d)' : 'var(--ink-secondary)',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1 }}>
      <Icon name={icon} size={15} />
    </button>
  );
}

export function BrowserPane({ projectId }: { projectId: string }) {
  const [frame, setFrame] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [input, setInput] = React.useState('');
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const alive = React.useRef(true);

  const refresh = React.useCallback(async () => {
    try {
      const v = await api.browserView(projectId);
      if (!alive.current || !v) return;
      setOpen(v.open);
      if (v.open) { setFrame(v.dataUrl ?? null); setUrl(v.url); setTitle(v.title); }
      else setFrame(null);
    } catch { /* transient — keep last frame */ }
  }, [projectId]);

  React.useEffect(() => {
    // Self-rescheduling poll: at most ONE view() is ever in flight, so live
    // previews never stack up behind a slow page or behind the agent's own
    // actions (they share the controller's per-session lock).
    alive.current = true;
    let timer: number | undefined;
    const tick = async () => {
      await refresh();
      if (alive.current) timer = window.setTimeout(tick, 2000);
    };
    void tick();
    return () => { alive.current = false; if (timer) window.clearTimeout(timer); };
  }, [refresh]);

  const go = async (target?: string) => {
    const u = (target ?? input).trim();
    if (!u) return;
    setBusy(true); setErr(null);
    try { const r = await api.browserNavigate(projectId, u); setUrl(r.url); setTitle(r.title); setInput(''); setEditing(false); await refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'navigation failed'); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true); setErr(null);
    try { await api.browserClose(projectId); }
    catch (e) { setErr(e instanceof Error ? e.message : 'could not close browser'); }
    finally { setOpen(false); setFrame(null); setUrl(''); setTitle(''); setBusy(false); }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)' }}>
      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--hairline)', background: 'var(--surface)' }}>
        <ToolBtn icon="refresh" label="Reload page" onClick={() => url && go(url)} disabled={busy || !url} />
        <form onSubmit={e => { e.preventDefault(); void go(); }} style={{ flex: 1, display: 'flex' }}>
          <input
            value={editing ? input : (url || input)}
            onChange={e => { setEditing(true); setInput(e.target.value); }}
            onFocus={() => { setEditing(true); setInput(url); }}
            onBlur={() => setEditing(false)}
            onKeyDown={e => { if (e.key === 'Escape') { setEditing(false); (e.target as HTMLInputElement).blur(); } }}
            placeholder="Enter a URL…"
            spellCheck={false}
            style={{ flex: 1, height: 30, padding: '0 12px', borderRadius: 8, border: '1px solid var(--hairline)',
              background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-text)', outline: 'none' }} />
        </form>
        <ToolBtn icon="arrowRight" label="Go" onClick={() => void go()} disabled={busy} />
        <div style={{ width: 1, height: 18, background: 'var(--hairline)', margin: '0 2px' }} />
        <ToolBtn icon="sidebar" label="Show the real Chrome window (to solve a CAPTCHA or sign in)" onClick={() => void api.browserFocus(projectId)} disabled={!open} />
        <ToolBtn icon="xCircle" label="Close this project's browser" onClick={() => void stop()} disabled={!open || busy} tone="danger" />
      </div>

      {/* status line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', borderBottom: '1px solid var(--hairline)',
        font: '400 var(--fs-caption1)/1.2 var(--font-text)', color: 'var(--ink-tertiary)', minHeight: 24 }}>
        <Icon name="globe" size={12} />
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {err ? <span style={{ color: 'var(--red, #e5484d)' }}>{err}</span> : title ? `${title} — ${url}` : open ? url : 'No browser running'}
        </span>
      </div>

      {/* live frame */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', placeItems: open && frame ? 'start center' : 'center', padding: open && frame ? 0 : 24 }}>
        {open && frame ? (
          <img src={frame} alt={title || url} style={{ display: 'block', width: '100%', height: 'auto' }} />
        ) : (
          <div style={{ textAlign: 'center', maxWidth: 380 }}>
            <span style={{ width: 56, height: 56, borderRadius: 16, display: 'inline-grid', placeItems: 'center', marginBottom: 14,
              background: 'color-mix(in srgb, var(--blue) 12%, transparent)', color: 'var(--blue)' }}>
              <Icon name="globe" size={26} />
            </span>
            <div style={{ font: '700 var(--fs-callout)/1.3 var(--font-display)', color: 'var(--ink)', marginBottom: 6 }}>
              {busy ? 'Opening…' : 'No browser open yet'}
            </div>
            <div style={{ font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-secondary)' }}>
              Type a URL above to start a session, or just ask the agent to browse — it shares this project's logins and cookies across every chat.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
