import React from 'react';
import { api, type UpdateStatus } from './api';
import { WhatsNew } from './WhatsNew';

/* Global, non-intrusive update prompt. Mounted once at the app root; subscribes
   to the desktop-only `update` event and shows a bottom-right card when an
   update is downloading / ready / available. Also pops "What's New" once after
   the app has updated to a new version. Renders nothing in web/phone remotes
   (api.update is undefined there). */

const SEEN_KEY = 'maestro.update.seenVersion';

export function UpdateBanner() {
  const upd = api.update;
  const [st, setSt] = React.useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = React.useState(false);
  const [whatsNew, setWhatsNew] = React.useState<{ version: string; notes: string } | null>(null);

  React.useEffect(() => {
    if (!upd) return;
    let alive = true;
    const unsub = upd.onUpdate(s => { if (!alive) return; setDismissed(false); setSt(s); });
    upd.status().then(s => {
      if (!alive) return;
      setSt(s);
      // First launch after an update → show what changed, once.
      try {
        const seen = localStorage.getItem(SEEN_KEY);
        if (s.currentVersion) {
          if (seen && seen !== s.currentVersion) {
            upd.notes(s.currentVersion).then(n => { if (alive) setWhatsNew({ version: n.version, notes: n.notes }); }).catch(() => {});
          }
          localStorage.setItem(SEEN_KEY, s.currentVersion);
        }
      } catch { /* storage unavailable */ }
    }).catch(() => {});
    return () => { alive = false; unsub(); };
  }, [upd]);

  if (!upd) return null;

  const openNotes = (version?: string) => {
    upd.notes(version ?? st?.version).then(n => setWhatsNew({ version: n.version, notes: n.notes })).catch(() => {});
  };

  const phase = st?.phase;
  const show = !dismissed && (phase === 'ready' || phase === 'available' || (phase === 'downloading' && (st?.percent ?? 0) > 0));

  return (
    <>
      {show && st && (
        <div className="gate-banner" style={{
          position: 'fixed', right: 20, bottom: 20, zIndex: 210, width: 340,
          background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)',
          boxShadow: '0 20px 60px rgba(10,15,40,0.34)', padding: 16, overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <span style={{ display: 'grid', placeItems: 'center', width: 34, height: 34, flexShrink: 0, borderRadius: 10, background: 'var(--fill-secondary)', font: '600 16px/1 var(--font-text)' }}>⬆︎</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ font: '600 var(--fs-callout)/1.25 var(--font-text)', color: 'var(--ink)' }}>
                {phase === 'ready' ? 'Update ready' : phase === 'downloading' ? 'Downloading update…' : 'Update available'}
              </div>
              <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>
                {phase === 'downloading'
                  ? `${st.percent ?? 0}%`
                  : <>Version {st.version}{phase === 'ready' ? ' — restart to apply.' : st.manualDownload ? ' is ready to download.' : ' is ready.'}</>}
              </div>
            </div>
            <button onClick={() => setDismissed(true)} aria-label="Dismiss" style={{ flexShrink: 0, width: 24, height: 24, borderRadius: 7, color: 'var(--ink-tertiary)', font: '500 16px/1 var(--font-text)' }}>×</button>
          </div>

          {phase === 'downloading' && (
            <div style={{ height: 4, borderRadius: 2, background: 'var(--fill-secondary)', marginTop: 12, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${st.percent ?? 0}%`, background: 'var(--blue)', borderRadius: 2, transition: 'width 240ms var(--spring)' }} />
            </div>
          )}

          {phase !== 'downloading' && (
            <div style={{ display: 'flex', gap: 8, marginTop: 13, justifyContent: 'flex-end' }}>
              <button onClick={() => openNotes(st.version)} style={{ height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>What's New</button>
              <button onClick={() => void upd.install()} style={{ height: 32, padding: '0 15px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
                {phase === 'ready' ? 'Restart to update' : 'Download'}
              </button>
            </div>
          )}
        </div>
      )}

      {whatsNew && (
        <WhatsNew version={whatsNew.version} notes={whatsNew.notes} onClose={() => setWhatsNew(null)} onOpenReleases={() => void upd.openReleases()} />
      )}
    </>
  );
}
