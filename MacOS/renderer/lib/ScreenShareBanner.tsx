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
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10000,
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '8px 14px',
        background: 'var(--red, #FF3B30)', color: '#fff',
        font: '600 var(--fs-body, 13px)/1.2 var(--font-text, system-ui)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
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
  return <ScreenShareBanner status={status} onStop={onStop} now={now} />;
}
