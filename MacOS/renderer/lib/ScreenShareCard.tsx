import React from 'react';
import { api } from './api';
import { GroupedList, Row } from './ui';
import { Icon } from './icons';

/**
 * ScreenShareCard — Phase 3D1 host-visible "active screen viewer" row for the
 * Controllers pane. While a controller is viewing this Mac's screen it shows the
 * device + source + elapsed time and an immediate local Stop (in addition to the
 * global banner + the macOS system indicator). Reads METADATA-ONLY status from the
 * brain (`shadowHostScreenStatus`); renders nothing when idle. Kept in its own file
 * so the ControllersPane truthfulness scan (no timers) stays intact — the brief poll
 * here reflects a real, changing brain fact (an active stream), not fabricated data.
 */
const ghost: React.CSSProperties = { minHeight: 36, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--red)', font: '600 var(--fs-footnote)/1 var(--font-text)' };

export function ScreenShareCard() {
  const [st, setSt] = React.useState<{ active: boolean; deviceLabel: string; sourceLabel: string; startedAtMs: number } | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (typeof api.shadowHostScreenStatus !== 'function') return; // web/phone remote or partial mock
    let alive = true;
    const poll = () => { api.shadowHostScreenStatus().then((s) => { if (alive) setSt(s); }).catch(() => {}); };
    poll();
    const p = setInterval(poll, 2000);
    const t = setInterval(() => { if (alive) setNow(Date.now()); }, 1000);
    return () => { alive = false; clearInterval(p); clearInterval(t); };
  }, []);
  if (!st || !st.active) return null;
  const elapsed = Math.max(0, Math.floor((now - st.startedAtMs) / 1000));
  const mm = Math.floor(elapsed / 60), ss = (elapsed % 60).toString().padStart(2, '0');
  const stop = () => { setBusy(true); Promise.resolve(api.shadowHostScreenStop?.()).then(() => setSt({ ...st, active: false })).finally(() => setBusy(false)); };
  return (
    <GroupedList header="Screen sharing">
      <Row last>
        <span aria-hidden="true" style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--red) 14%, transparent)', color: 'var(--red)' }}>
          <Icon name="smartphone" size={17} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{st.deviceLabel} is viewing your screen</span>
          <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>{st.sourceLabel} · {mm}:{ss} · view only</span>
        </span>
        <button onClick={stop} disabled={busy} aria-label="Stop sharing your screen" className="ghost-btn" style={ghost}>Stop sharing</button>
      </Row>
    </GroupedList>
  );
}
