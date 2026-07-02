/* Publishing Center — a real LOCAL pipeline. Approved Studio media (and imported
   files) become drafts here; you write a caption, pick platforms, then Export
   (copies media + caption to ~/Maestro/Exports/<platform>/ and your clipboard,
   reveals in Finder) or Schedule (the cron runner exports it when due). Maestro
   never posts on your behalf — every send is an auditable local export with a
   provenance hash in the ledger. Nothing publishes without you. */

import React from 'react';
import { Icon } from '../lib/icons';
import { AppShell } from '../lib/appShell';
import { api, type PublishDraft, type PublishLedgerRow, type Asset, IS_LOCAL } from '../lib/api';

const PUBLISHING_CSS = `
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .ghost-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  .draft-card { transition: transform 160ms var(--spring), box-shadow 160ms ease; }
  .led-row:hover { background: var(--fill-tertiary); }
  @keyframes tfade { from { transform: translateY(6px); } to { transform: none; } }
  .tab-fade { animation: tfade 240ms var(--spring); }
`;

type PlatformKey = 'youtube' | 'tiktok' | 'instagram' | 'x' | 'linkedin' | 'pinterest' | 'bluesky';
function PGlyph({ p, size = 18 }: { p: PlatformKey; size?: number }) {
  const c = 'currentColor';
  const paths: Record<PlatformKey, React.ReactNode> = {
    youtube: <path d="M21.6 7.2a2.7 2.7 0 0 0-1.9-1.9C18 4.8 12 4.8 12 4.8s-6 0-7.7.5A2.7 2.7 0 0 0 2.4 7.2C2 8.9 2 12 2 12s0 3.1.4 4.8a2.7 2.7 0 0 0 1.9 1.9c1.7.5 7.7.5 7.7.5s6 0 7.7-.5a2.7 2.7 0 0 0 1.9-1.9c.4-1.7.4-4.8.4-4.8s0-3.1-.4-4.8ZM10 15V9l5.2 3L10 15Z" fill={c}/>,
    tiktok: <path d="M16.5 3c.3 2.2 1.6 3.7 3.8 3.9v2.6c-1.3.1-2.5-.3-3.8-1v5.9c0 4.6-5 6-7.3 2.7-1.5-2.1-.7-5.8 3.4-6v2.7c-.3.05-.7.15-1 .27-.9.4-1.4 1-1.3 2 .2 1.9 3.7 2.5 3.4-1.2V3h2.8Z" fill={c}/>,
    instagram: <><rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke={c} strokeWidth="1.8"/><circle cx="12" cy="12" r="4" fill="none" stroke={c} strokeWidth="1.8"/><circle cx="17" cy="7" r="1.3" fill={c}/></>,
    x: <path d="M17.5 3h3l-6.5 7.4L21.5 21h-5.9l-4.3-5.6L6.3 21H3.3l7-8L2.8 3h6l3.9 5.2L17.5 3Zm-1 16h1.6L7.6 4.7H5.9L16.5 19Z" fill={c}/>,
    linkedin: <><rect x="3.5" y="3.5" width="17" height="17" rx="3" fill="none" stroke={c} strokeWidth="1.8"/><path d="M7 10v6M7 7.5v.01M11 16v-3.5a1.5 1.5 0 0 1 3 0V16M11 16v-6" stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round"/></>,
    pinterest: <path d="M12 2a10 10 0 0 0-3.6 19.3c-.1-.8-.2-2 0-2.9l1.2-5s-.3-.6-.3-1.5c0-1.4.8-2.4 1.8-2.4.9 0 1.3.6 1.3 1.4 0 .9-.5 2.2-.8 3.4-.2 1 .5 1.8 1.5 1.8 1.8 0 3-2.3 3-5 0-2-1.4-3.6-3.9-3.6-2.9 0-4.6 2.1-4.6 4.4 0 .8.2 1.4.6 1.9.2.2.2.3.1.5l-.2.9c-.1.3-.3.4-.5.2-1-.5-1.6-2-1.6-3.2 0-2.6 2.1-5.7 6.3-5.7 3.3 0 5.6 2.4 5.6 5 0 3.4-1.9 6-4.7 6-1 0-1.8-.5-2.1-1.1l-.6 2.3c-.2.8-.7 1.7-1 2.3A10 10 0 1 0 12 2Z" fill={c}/>,
    bluesky: <path d="M12 10.8C10.8 8.5 7.6 4.3 5 4c-1.4-.2-2 .6-2 2.2 0 1.6 1 5.2 1.6 5.9.5.7 1.6 1 3 .8-2.6.4-3.3 1.7-1.8 3.4 1.5 1.7 3.3.4 4.2-1.3.4-.8.6-1.4 1-2.3.4.9.6 1.5 1 2.3.9 1.7 2.7 3 4.2 1.3 1.5-1.7.8-3-1.8-3.4 1.4.2 2.5-.1 3-.8.6-.7 1.6-4.3 1.6-5.9 0-1.6-.6-2.4-2-2.2-2.6.3-5.8 4.5-7 6.8Z" fill={c}/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">{paths[p]}</svg>;
}
const PLATFORMS: Record<PlatformKey, { name: string; tint: string }> = {
  youtube: { name: 'YouTube', tint: 'var(--red)' }, tiktok: { name: 'TikTok', tint: 'var(--ink)' },
  instagram: { name: 'Instagram', tint: 'var(--purple)' }, x: { name: 'X', tint: 'var(--ink)' },
  linkedin: { name: 'LinkedIn', tint: 'var(--blue)' }, pinterest: { name: 'Pinterest', tint: 'var(--red)' }, bluesky: { name: 'Bluesky', tint: 'var(--teal)' },
};
const PLATFORM_KEYS = Object.keys(PLATFORMS) as PlatformKey[];

function AssetThumb({ a }: { a?: Asset }) {
  if (a?.kind === 'image' && a.url) return <img src={a.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />;
  if (a?.kind === 'video' && a.url) return <video src={a.url} style={{ width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} muted />;
  return <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: `linear-gradient(135deg, color-mix(in srgb, ${a?.tint ?? 'var(--blue)'} 30%, transparent), transparent)` }}><Icon name={a?.kind === 'video' ? 'clapper' : a?.kind === 'audio' || a?.kind === 'voiceover' ? 'play' : 'image'} size={26} style={{ color: 'rgba(255,255,255,0.7)' }} /></div>;
}

function toLocalInput(ts: number): string {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function DraftCard({ d, asset, onChanged }: { d: PublishDraft; asset?: Asset; onChanged: () => void }) {
  const [caption, setCaption] = React.useState(d.caption);
  const [platforms, setPlatforms] = React.useState<string[]>(d.platforms);
  const [when, setWhen] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { setCaption(d.caption); setPlatforms(d.platforms); }, [d.id]);

  const saveCaption = () => { if (caption !== d.caption) void api.updateDraft(d.id, { caption }).then(onChanged).catch(() => {}); };
  const togglePlatform = (k: string) => {
    const next = platforms.includes(k) ? platforms.filter(x => x !== k) : [...platforms, k];
    setPlatforms(next);
    void api.updateDraft(d.id, { platforms: next }).then(onChanged).catch(() => {});
  };
  const act = (fn: () => Promise<unknown>) => { setBusy(true); void fn().then(onChanged).catch(() => {}).finally(() => setBusy(false)); };

  const done = d.status === 'exported' || d.status === 'published-manual';
  return (
    <div data-draft={d.id} className="draft-card" style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ aspectRatio: asset?.kind === 'image' ? '1/1' : '16/9', background: 'var(--fill-secondary)', position: 'relative' }}>
        <AssetThumb a={asset} />
        <span style={{ position: 'absolute', top: 8, left: 8, display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)', background: 'rgba(10,12,24,0.6)', color: '#fff', font: '600 var(--fs-caption)/1 var(--font-text)', backdropFilter: 'blur(8px)' }}>
          {d.status === 'scheduled' ? `Scheduled` : d.status === 'exported' ? 'Exported' : d.status === 'published-manual' ? 'Published' : 'Draft'}
        </span>
      </div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
        <textarea value={caption} onChange={e => setCaption(e.target.value)} onBlur={saveCaption} rows={2} placeholder="Write a caption…"
          style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--separator)', borderRadius: 10, outline: 'none', background: 'var(--bg)', resize: 'vertical', font: '400 var(--fs-footnote)/1.45 var(--font-text)', color: 'var(--ink)', padding: 10, minHeight: 52 }} />

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {PLATFORM_KEYS.map(k => {
            const on = platforms.includes(k);
            return <button key={k} title={PLATFORMS[k].name} onClick={() => togglePlatform(k)} style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center',
              background: on ? 'color-mix(in srgb, var(--blue) 14%, transparent)' : 'var(--fill-secondary)', border: `1px solid ${on ? 'var(--blue)' : 'transparent'}`, color: on ? PLATFORMS[k].tint : 'var(--ink-tertiary)' }}><PGlyph p={k} size={15} /></button>;
          })}
        </div>

        <div style={{ font: '400 var(--fs-caption)/1.3 var(--font-mono)', color: 'var(--ink-tertiary)' }}>provenance · {d.provenance || 'n/a'}</div>

        {!done && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button disabled={busy} onClick={() => act(() => api.exportDraft(d.id))} className="primary-cta" style={{ flex: 1, height: 34, minWidth: 110, borderRadius: 9, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Export now</button>
            <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} style={{ height: 34, borderRadius: 9, border: '1px solid var(--separator)', background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-caption)/1 var(--font-mono)', padding: '0 6px' }} />
            <button disabled={busy || !when} onClick={() => act(() => api.scheduleDraft(d.id, new Date(when).getTime()))} className="ghost-btn" style={{ height: 34, padding: '0 12px', borderRadius: 9, background: 'var(--fill-secondary)', color: when ? 'var(--ink)' : 'var(--ink-tertiary)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Schedule</button>
            <button disabled={busy} onClick={() => act(() => api.deleteDraft(d.id))} title="Delete" style={{ width: 34, height: 34, borderRadius: 9, background: 'transparent', color: 'var(--ink-tertiary)', display: 'grid', placeItems: 'center' }}><Icon name="x" size={15} /></button>
          </div>
        )}
        {d.status === 'scheduled' && d.scheduledAt && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--orange)' }}><Icon name="clock" size={13} /> Fires {new Date(d.scheduledAt).toLocaleString()}</span>
            <button onClick={() => act(() => api.updateDraft(d.id, { status: 'draft', scheduledAt: null }))} className="ghost-btn" style={{ height: 30, padding: '0 11px', borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>Unschedule</button>
          </div>
        )}
        {d.status === 'exported' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => act(() => api.markPublished(d.id))} className="primary-cta" style={{ flex: 1, height: 34, borderRadius: 9, background: 'var(--green)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>I posted it — mark published</button>
            {IS_LOCAL && d.exportedPaths[0] && <button onClick={() => api.revealPath(d.exportedPaths[0])} title="Reveal export" style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', display: 'grid', placeItems: 'center' }}><Icon name="folder" size={15} /></button>}
          </div>
        )}
        {d.status === 'published-manual' && <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--green)' }}><Icon name="check" size={14} stroke={2.6} /> Marked published</div>}
      </div>
    </div>
  );
}

function clockOf(ts: number): string { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

export default function PublishingCenter() {
  const [tab, setTab] = React.useState<'drafts' | 'scheduled' | 'ledger'>('drafts');
  const [drafts, setDrafts] = React.useState<PublishDraft[]>([]);
  const [assets, setAssets] = React.useState<Record<string, Asset>>({});
  const [ledger, setLedger] = React.useState<PublishLedgerRow[]>([]);

  const refetch = React.useCallback(() => {
    api.listPublishDrafts().then(setDrafts).catch(() => {});
    api.listAssets().then(list => setAssets(Object.fromEntries(list.map(a => [a.id, a])))).catch(() => {});
    api.listPublishLedger().then(setLedger).catch(() => {});
  }, []);
  React.useEffect(() => {
    refetch();
    const unsub = api.subscribe({ onPublishDraft: refetch, onAsset: refetch });
    return unsub;
  }, [refetch]);

  // Approved Studio assets that don't have a draft yet → "ready to draft".
  const draftedAssetIds = new Set(drafts.map(d => d.assetId));
  const readyAssets = Object.values(assets).filter(a => a.status === 'approved' && !draftedAssetIds.has(a.id));

  const importFile = () => { void api.importAsset(null).then(a => { if (a) void api.createDraft({ assetId: a.id }).then(refetch); }).catch(() => {}); };

  const scheduled = drafts.filter(d => d.status === 'scheduled').sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
  const activeDrafts = drafts.filter(d => d.status !== 'published-manual');

  const TABS = [['drafts', 'Drafts'], ['scheduled', 'Scheduled'], ['ledger', 'Ledger']] as const;

  return (
    <AppShell active="publishing" onSearch={() => {}}>
      <style>{PUBLISHING_CSS}</style>
      <div style={{ padding: '24px 28px 36px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 8, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Publishing</h1>
            <p style={{ margin: '6px 0 0', font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>Export approved media + captions to ~/Maestro/Exports. Nothing posts without you.</p>
          </div>
          {IS_LOCAL && <button onClick={importFile} className="ghost-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 15px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}><Icon name="plus" size={16} /> Import media</button>}
        </div>

        <div style={{ display: 'inline-flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 11, margin: '18px 0 20px' }}>
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} style={{ width: 116, padding: '8px 0', textAlign: 'center', borderRadius: 8, font: `${tab === k ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`, color: tab === k ? 'var(--ink)' : 'var(--ink-secondary)', background: tab === k ? 'var(--bg-elevated)' : 'transparent', boxShadow: tab === k ? '0 1px 3px rgba(0,0,0,0.14)' : 'none' }}>{label}{k === 'scheduled' && scheduled.length > 0 ? ` · ${scheduled.length}` : ''}</button>
          ))}
        </div>

        <div key={tab} className="tab-fade">
          {tab === 'drafts' && (
            <>
              {readyAssets.length > 0 && (
                <div style={{ marginBottom: 22 }}>
                  <div style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)', marginBottom: 11 }}>Approved · ready to draft</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
                    {readyAssets.map(a => (
                      <button key={a.id} onClick={() => void api.createDraft({ assetId: a.id }).then(refetch)} className="draft-card" style={{ textAlign: 'left', background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden', padding: 0, cursor: 'pointer' }}>
                        <div style={{ aspectRatio: '16/9', background: 'var(--fill-secondary)' }}><AssetThumb a={a} /></div>
                        <div style={{ padding: '9px 11px', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ flex: 1, font: '500 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.prompt || a.name || a.kind}</span>
                          <Icon name="plus" size={14} style={{ color: 'var(--blue)' }} />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {activeDrafts.length === 0 && readyAssets.length === 0 ? (
                <div style={{ padding: '52px 0', textAlign: 'center', background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', font: '400 var(--fs-callout)/1.5 var(--font-text)', color: 'var(--ink-tertiary)' }}>
                  No drafts yet. Approve media in the Studio (Send to Publishing){IS_LOCAL ? ', or import a local file' : ''} to start.
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
                  {activeDrafts.map(d => <DraftCard key={d.id} d={d} asset={assets[d.assetId]} onChanged={refetch} />)}
                </div>
              )}
            </>
          )}

          {tab === 'scheduled' && (
            scheduled.length === 0 ? <div style={{ padding: '52px 0', textAlign: 'center', background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Nothing scheduled. Set a time on a draft to queue its export.</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {scheduled.map(d => (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 14, borderRadius: 14, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)' }}>
                    <div style={{ width: 64, height: 40, borderRadius: 9, overflow: 'hidden', flexShrink: 0, background: 'var(--fill-secondary)' }}><AssetThumb a={assets[d.assetId]} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.caption || 'Untitled'}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>{d.platforms.map(p => PLATFORMS[p as PlatformKey] && <span key={p} style={{ color: PLATFORMS[p as PlatformKey].tint }}><PGlyph p={p as PlatformKey} size={13} /></span>)}<span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--orange)', marginLeft: 4 }}>{d.scheduledAt ? new Date(d.scheduledAt).toLocaleString() : ''}</span></div>
                    </div>
                    <button onClick={() => void api.exportDraft(d.id).then(refetch)} className="ghost-btn" style={{ height: 32, padding: '0 12px', borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Export now</button>
                  </div>
                ))}
              </div>
          )}

          {tab === 'ledger' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 11 }}>
                <span style={{ flex: 1, font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>Provenance ledger</span>
                {ledger.length > 0 && <button onClick={() => { try { navigator.clipboard.writeText(JSON.stringify(ledger, null, 2)); } catch { /* */ } }} className="ghost-btn" style={{ height: 30, padding: '0 11px', borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>Copy JSON</button>}
              </div>
              {ledger.length === 0 ? <div style={{ padding: '48px 0', textAlign: 'center', background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>No exports yet. Every export and manual-publish is logged here with a hash.</div>
              : <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1.2fr 90px', gap: 14, padding: '11px 18px', borderBottom: '0.5px solid var(--separator)', background: 'var(--fill-tertiary)' }}>
                    {['Time', 'Action', 'Platforms', 'Hash'].map(h => <span key={h} style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{h}</span>)}
                  </div>
                  {ledger.map((r, i) => (
                    <div key={r.id} className="led-row" style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1.2fr 90px', gap: 14, alignItems: 'center', padding: '12px 18px', borderBottom: i < ledger.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
                      <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>{clockOf(r.at)}</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '500 var(--fs-footnote)/1 var(--font-text)', color: r.ok ? 'var(--ink)' : 'var(--red)' }}><Icon name={r.action === 'published-manual' ? 'check' : 'enter'} size={13} style={{ color: r.ok ? 'var(--green)' : 'var(--red)' }} />{r.action === 'published-manual' ? 'Published' : 'Exported'}</span>
                      <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{r.platforms.join(', ') || '—'}</span>
                      <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{r.hash.slice(0, 8)}</span>
                    </div>
                  ))}
                </div>}
              <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 12, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>
                Maestro exports to Finder rather than posting for you — so there are no platform tokens to leak and you stay in control of every post.
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
