import React from 'react';
import { api } from './api';

/* ScreenShareBanner — Phase 3D1 host-visible "someone is viewing your screen"
 * banner (Section A.5). While a controller device is viewing this Mac's screen, a
 * persistent, unmissable banner names the exact device + source and offers an
 * immediate local Stop. This is in ADDITION to the macOS system Screen-Recording
 * indicator — never the sole signal. Presentational + driven by an injected status
 * so it renders deterministically for tests + pixels; the app wires `status` to the
 * brain's `screenShare` event and `onStop` to the host coordinator's stopByHost. */

export interface ScreenShareViewerStatus {
  readonly active: boolean;
  /** The viewing device's short, human label (never a raw id/key). */
  readonly deviceLabel: string;
  /** The source being shared, e.g. "Built-in Retina Display · 1512×982". */
  readonly sourceLabel: string;
  /** When the current stream started (ms epoch), for a live elapsed readout. */
  readonly startedAtMs: number;
}

function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function ScreenShareBanner({
  status,
  onStop,
  now = Date.now(),
}: {
  status: ScreenShareViewerStatus | null;
  onStop: () => void;
  now?: number;
}) {
  if (!status || !status.active) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${status.deviceLabel} is viewing your screen`}
      // win-drag: the banner sits over the window's title bar, so without this it would
      // swallow the drag region and the window could no longer be moved. Marking it a drag
      // handle lets the operator drag the window BY the banner; the <button> below auto
      // opts out (no-drag) so "Stop sharing" stays clickable. paddingLeft clears the native
      // traffic-light controls (top-left) so they remain visible + usable. The body gets a
      // `screen-sharing` class (see ScreenShareBannerHost) that shifts the app content down
      // by this bar's height so the top navigation is never hidden.
      className="win-drag"
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10000,
        height: 'var(--share-banner-h, 30px)', boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '0 12px 0 84px',
        background: 'var(--red, #FF3B30)', color: '#fff',
        font: '600 12px/1.2 var(--font-text, system-ui)',
        boxShadow: '0 1px 6px rgba(0,0,0,0.28)',
      }}
    >
      <span aria-hidden style={{ width: 9, height: 9, borderRadius: 999, background: '#fff', boxShadow: '0 0 0 3px rgba(255,255,255,0.35)' }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <strong>{status.deviceLabel}</strong> is viewing your screen — {status.sourceLabel} · {fmtElapsed(now - status.startedAtMs)} · view only
      </span>
      <button
        type="button"
        onClick={onStop}
        aria-label="Stop sharing your screen"
        style={{
          appearance: 'none', border: '1px solid rgba(255,255,255,0.6)', background: 'rgba(255,255,255,0.14)',
          color: '#fff', borderRadius: 8, padding: '5px 12px', font: '600 12px/1 var(--font-text, system-ui)', cursor: 'pointer',
        }}
      >
        Stop sharing
      </button>
    </div>
  );
}

/**
 * The mounted-at-app-root container: polls the brain's metadata-only screen-share
 * status and renders the banner while a viewer is active. Wired into the app shell
 * so the operator ALWAYS sees (and can stop) an active screen view. Renders nothing
 * in web/phone remotes (the status call resolves inactive there).
 */
export function ScreenShareBannerHost() {
  const [status, setStatus] = React.useState<ScreenShareViewerStatus | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    let alive = true;
    const poll = () => { api.shadowHostScreenStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {}); };
    poll();
    const p = setInterval(poll, 2000);
    const t = setInterval(() => { if (alive) setNow(Date.now()); }, 1000);
    return () => { alive = false; clearInterval(p); clearInterval(t); };
  }, []);
  const onStop = React.useCallback(() => {
    api.shadowHostScreenStop().then(() => setStatus((s) => (s ? { ...s, active: false } : s))).catch(() => {});
  }, []);
  // While a viewer is active, tag <body> so the app content is shifted down by the banner
  // height (CSS in index.css) — the top navigation stays fully visible instead of being
  // covered by the fixed banner.
  const active = !!status && status.active;
  React.useEffect(() => {
    const b = typeof document !== 'undefined' ? document.body : null;
    if (!b) return;
    if (active) b.classList.add('screen-sharing'); else b.classList.remove('screen-sharing');
    return () => { b.classList.remove('screen-sharing'); };
  }, [active]);
  return <ScreenShareBanner status={status} onStop={onStop} now={now} />;
}
