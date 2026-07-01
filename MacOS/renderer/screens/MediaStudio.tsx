/* Media Studio — real generation on the operator's fal.ai key. Pick a stage
   (Image / Video / Voice / Music / Avatar), a model, write a prompt, and
   generate; jobs run through fal's queue on this Mac, stream into the bin live,
   download to ~/Maestro/<project>/assets/, and can be approved → Publishing.
   Visual language preserved; the data + actions are now real. */

import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { AppShell } from '../lib/appShell';
import { Icon, type IconName } from '../lib/icons';
import { api, type Asset, type MediaRate, type Project, type ProviderConn, ApiError, IS_LOCAL } from '../lib/api';

const PAGE_CSS = `
  .pipe-stage:hover { filter: brightness(0.98); }
  .send-btn { transition: transform 180ms var(--spring), box-shadow 160ms ease, background 160ms ease; }
  .send-btn:active { transform: scale(0.96); }
  .asset-card { transition: transform 140ms var(--spring), box-shadow 160ms ease; }
  .asset-card:hover { transform: translateY(-2px); box-shadow: var(--card-shadow), 0 8px 22px rgba(15,20,60,0.12); }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
  .breathe { animation: breathe 1.6s ease-in-out infinite; }
`;

interface Stage { key: string; label: string; icon: IconName; kinds: string[]; needsConsent?: boolean; needsImage?: boolean }
const STAGES: Stage[] = [
  { key: 'image', label: 'Image', icon: 'brush', kinds: ['image'] },
  { key: 'video', label: 'Video', icon: 'clapper', kinds: ['video'] },
  { key: 'voice', label: 'Voice', icon: 'send', kinds: ['voiceover'] },
  { key: 'music', label: 'Music', icon: 'play', kinds: ['audio'] },
  { key: 'avatar', label: 'Avatar', icon: 'smartphone', kinds: ['video'], needsConsent: true, needsImage: true },
];
// Avatar uses the image→video model specifically.
const AVATAR_MODEL = 'kling-i2v';
const VOICES = ['af_heart', 'af_bella', 'am_adam', 'bf_emma', 'bm_george'];

function Spinner({ size = 16, color = 'var(--purple)' }: { size?: number; color?: string }) {
  return <span style={{ width: size, height: size, borderRadius: '50%', border: `2px solid color-mix(in srgb, ${color} 30%, transparent)`, borderTopColor: color, display: 'inline-block', animation: 'spin 0.8s linear infinite' }} />;
}

function NoKeyCard({ onConnected }: { onConnected: () => void }) {
  const [key, setKey] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const connect = async () => {
    if (!key.trim()) return;
    setBusy(true); setErr('');
    try { await api.connectProvider('fal', key.trim()); onConnected(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not connect'); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ maxWidth: 520, margin: '60px auto', textAlign: 'center', padding: '0 20px' }}>
      <span style={{ display: 'inline-grid', placeItems: 'center', width: 64, height: 64, borderRadius: 18, background: 'color-mix(in srgb, var(--purple) 14%, transparent)', color: 'var(--purple)', marginBottom: 20 }}><Icon name="clapper" size={32} /></span>
      <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Connect fal.ai to generate</h2>
      <p style={{ margin: '0 0 22px', font: '400 var(--fs-body)/1.45 var(--font-text)', color: 'var(--ink-secondary)' }}>
        The Studio generates images, video, voice, and music on your own fal.ai key. It’s stored encrypted on this Mac and never leaves it. Get a key at fal.ai/dashboard/keys.
      </p>
      {IS_LOCAL ? (
        <div style={{ display: 'flex', gap: 10, maxWidth: 420, margin: '0 auto' }}>
          <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="fal key (key_id:key_secret)" onKeyDown={e => { if (e.key === 'Enter') void connect(); }}
            style={{ flex: 1, height: 44, padding: '0 14px', borderRadius: 12, boxSizing: 'border-box', border: '1px solid var(--separator-strong)', background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-body)/1 var(--font-mono)' }} />
          <button onClick={connect} disabled={busy || !key.trim()} className="send-btn" style={{ height: 44, padding: '0 20px', borderRadius: 12, background: key.trim() ? 'var(--blue)' : 'var(--fill-secondary)', color: key.trim() ? '#fff' : 'var(--ink-tertiary)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>{busy ? 'Connecting…' : 'Connect'}</button>
        </div>
      ) : <div style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Connect your fal key in the desktop app (Settings → Accounts).</div>}
      {err && <div style={{ marginTop: 12, font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--red)' }}>{err}</div>}
    </div>
  );
}

function AssetPreview({ a }: { a: Asset }) {
  const src = a.url;
  if (a.kind === 'image' && src) return <img src={src} alt={a.prompt ?? 'image'} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />;
  if (a.kind === 'video' && src) return <video src={src} controls style={{ width: '100%', height: '100%', objectFit: 'cover', background: '#000', display: 'block' }} />;
  if ((a.kind === 'audio' || a.kind === 'voiceover') && src) return (
    <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: `linear-gradient(135deg, color-mix(in srgb, ${a.tint ?? 'var(--purple)'} 22%, var(--bg-elevated)), var(--bg-elevated))`, padding: 12 }}>
      <audio src={src} controls style={{ width: '100%' }} />
    </div>
  );
  return <div style={{ width: '100%', height: '100%', background: `linear-gradient(135deg, color-mix(in srgb, ${a.tint ?? 'var(--blue)'} 30%, transparent), transparent)` }} />;
}

function AssetCard({ a, onCancel, onApprove, onDelete, onReveal, onUseAsSource }: {
  a: Asset; onCancel: () => void; onApprove: () => void; onDelete: () => void; onReveal: () => void; onUseAsSource?: () => void;
}) {
  const busy = a.status === 'queued' || a.status === 'generating';
  // Regenerate / modify — only for finished images. No instruction → re-roll the
  // original prompt; with one → edit this image, keeping the rest. Produces a NEW
  // asset (a fresh card appears via the asset subscription); never destructive.
  const [editing, setEditing] = React.useState(false);
  const [instruction, setInstruction] = React.useState('');
  const [regenBusy, setRegenBusy] = React.useState(false);
  const [regenErr, setRegenErr] = React.useState('');
  // Regenerate runs Codex/fal on THIS Mac — only offer it on the desktop (the
  // result isn't viewable, and the relay has no regenerate route, on phone/web).
  const canRegen = IS_LOCAL && a.kind === 'image' && (a.status === 'done' || a.status === 'approved');
  const hasPrompt = !!(a.prompt && a.prompt.trim());
  const regen = async (withInstruction: boolean) => {
    if (regenBusy) return;
    const instr = instruction.trim();
    if (withInstruction && !instr) return;
    if (!withInstruction && !hasPrompt) { setRegenErr('No original prompt — describe a change to modify it.'); return; }
    setRegenBusy(true); setRegenErr('');
    try {
      await api.regenerateImage({ assetId: a.id, instruction: withInstruction ? instr : undefined });
      setInstruction(''); setEditing(false);
    } catch (e) {
      setRegenErr(e instanceof ApiError ? e.message : 'Could not regenerate');
    } finally { setRegenBusy(false); }
  };
  return (
    <div className="asset-card" style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ aspectRatio: a.kind === 'video' ? '16/9' : a.kind === 'image' ? '1/1' : '16/6', position: 'relative', background: 'var(--fill-secondary)' }}>
        {a.status === 'done' || a.status === 'approved' ? <AssetPreview a={a} />
          : a.status === 'failed' ? <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', padding: 14, textAlign: 'center', font: '500 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--red)' }}>{a.error ?? 'Failed'}</div>
          : a.status === 'cancelled' ? <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Cancelled</div>
          : <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', gap: 10 }}><Spinner size={22} /><span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{a.status === 'queued' ? 'Queued…' : 'Generating…'}</span></div>}
        {a.status === 'approved' && <span style={{ position: 'absolute', top: 8, left: 8, display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 8px', borderRadius: 'var(--r-pill)', background: 'rgba(52,199,89,0.92)', color: '#fff', font: '600 var(--fs-caption)/1 var(--font-text)' }}><Icon name="check" size={11} stroke={2.6} /> Approved</span>}
      </div>
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span title={a.prompt} style={{ font: '500 var(--fs-footnote)/1.35 var(--font-text)', color: 'var(--ink)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.prompt || a.name || a.kind}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{a.model}</span>
          <span style={{ flex: 1 }} />
          <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>${a.cost.toFixed(3)}</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {busy && <button onClick={onCancel} style={{ flex: 1, height: 30, borderRadius: 8, background: 'rgba(255,59,48,0.1)', color: 'var(--red)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>Cancel</button>}
          {canRegen && <button onClick={() => setEditing(e => !e)} disabled={regenBusy} title="Regenerate or modify this image"
            style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', border: 0, cursor: regenBusy ? 'default' : 'pointer',
              background: editing ? 'color-mix(in srgb, var(--purple) 16%, transparent)' : 'var(--fill-secondary)', color: editing ? 'var(--purple)' : 'var(--ink-secondary)' }}>
            {regenBusy ? <Spinner size={13} /> : <Icon name="refresh" size={14} />}</button>}
          {(a.status === 'done') && <>
            <button onClick={onApprove} className="send-btn" style={{ flex: 1, height: 30, borderRadius: 8, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-caption)/1 var(--font-text)' }}>Send to Publishing</button>
            {onUseAsSource && a.kind === 'image' && <button onClick={onUseAsSource} title="Use as avatar source" style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', display: 'grid', placeItems: 'center' }}><Icon name="smartphone" size={14} /></button>}
            {IS_LOCAL && a.localPath && <button onClick={onReveal} title="Reveal in Finder" style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', display: 'grid', placeItems: 'center' }}><Icon name="folder" size={14} /></button>}
          </>}
          {(a.status === 'failed' || a.status === 'cancelled' || a.status === 'approved') && <button onClick={onDelete} style={{ flex: 1, height: 30, borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>Remove</button>}
        </div>
        {canRegen && editing && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input value={instruction} autoFocus disabled={regenBusy} onChange={e => setInstruction(e.target.value)}
              placeholder={hasPrompt ? 'Change to apply — or leave empty to re-roll' : 'Describe a change to apply'}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void regen(instruction.trim().length > 0); } }}
              style={{ flex: 1, minWidth: 0, height: 30, padding: '0 10px', borderRadius: 8, font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink)', background: 'var(--bg-grouped)', border: '0.5px solid var(--separator)' }} />
            {hasPrompt && <button onClick={() => void regen(false)} disabled={regenBusy} title="Generate a fresh version of the same prompt"
              style={{ height: 30, padding: '0 10px', borderRadius: 8, border: 0, font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)', background: 'var(--fill-secondary)', cursor: regenBusy ? 'default' : 'pointer', opacity: regenBusy ? 0.5 : 1 }}>Re-roll</button>}
            <button onClick={() => void regen(true)} disabled={regenBusy || !instruction.trim()} className="send-btn"
              style={{ height: 30, padding: '0 11px', borderRadius: 8, border: 0, font: '600 var(--fs-caption)/1 var(--font-text)', color: '#fff', background: 'var(--purple)', opacity: (regenBusy || !instruction.trim()) ? 0.5 : 1, cursor: (regenBusy || !instruction.trim()) ? 'default' : 'pointer' }}>Modify</button>
          </div>
        )}
        {regenErr && <span style={{ font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--red)' }}>{regenErr}</span>}
      </div>
    </div>
  );
}

export default function MediaStudio() {
  const navigate = useNavigate();
  const location = useLocation();
  const [stageKey, setStageKey] = React.useState('image');
  const [rates, setRates] = React.useState<MediaRate[]>([]);
  const [assets, setAssets] = React.useState<Asset[]>([]);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [projectId, setProjectId] = React.useState<string | null>(null);
  const [hasFal, setHasFal] = React.useState<boolean | null>(null);

  // composer
  const [modelKey, setModelKey] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [durationS, setDurationS] = React.useState(5);
  const [aspect, setAspect] = React.useState('16:9');
  const [voice, setVoice] = React.useState(VOICES[0]);
  const [sourceImage, setSourceImage] = React.useState<string | null>(null);
  const [consent, setConsent] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [err, setErr] = React.useState('');

  const stage = STAGES.find(s => s.key === stageKey)!;

  const refetch = React.useCallback(() => {
    api.listAssets().then(setAssets).catch(() => {});
  }, []);
  React.useEffect(() => {
    api.mediaRates().then(setRates).catch(() => {});
    api.listProjects().then(setProjects).catch(() => {});
    api.listProviders().then(cs => setHasFal(cs.some((c: ProviderConn) => c.provider === 'fal'))).catch(() => setHasFal(false));
    refetch();
    const unsub = api.subscribe({ onAsset: refetch });
    return unsub;
  }, [refetch]);

  // Prefill the prompt when arriving from Trends ("Send to Studio").
  React.useEffect(() => {
    const brief = (location.state as { brief?: { headline?: string; hook?: string } } | null)?.brief;
    if (brief) {
      setPrompt([brief.headline, brief.hook].filter(Boolean).join(' — '));
      navigate(location.pathname, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Models available for the active stage. flux-kontext is an EDIT-only model
  // (needs a source image) reached via the Regenerate/Modify affordance, not the
  // blank-composer flow — so keep it out of the manual picker.
  const stageModels = React.useMemo(() => {
    if (stage.key === 'avatar') return rates.filter(r => r.key === AVATAR_MODEL);
    return rates.filter(r => stage.kinds.includes(r.kind) && r.key !== 'flux-kontext');
  }, [rates, stage]);
  React.useEffect(() => { if (stageModels[0] && !stageModels.some(m => m.key === modelKey)) setModelKey(stageModels[0].key); }, [stageModels, modelKey]);

  const model = stageModels.find(m => m.key === modelKey);
  const isVideo = stage.key === 'video' || stage.key === 'avatar';
  const isTimed = isVideo || stage.key === 'music';
  const est = model ? (model.perSecond ? model.rate * durationS : model.rate) : 0;

  const doneImages = assets.filter(a => a.kind === 'image' && (a.status === 'done' || a.status === 'approved') && a.url);

  const canGenerate = !!model && prompt.trim().length > 0 && !submitting
    && (!stage.needsConsent || consent)
    && (!stage.needsImage || !!sourceImage);

  const generate = async () => {
    if (!canGenerate || !model) return;
    setSubmitting(true); setErr('');
    try {
      await api.generateAsset({
        projectId, modelKey: model.key, prompt: prompt.trim(),
        durationS: isTimed ? durationS : undefined,
        voice: stage.key === 'voice' ? voice : undefined,
        imageUrl: stage.needsImage ? sourceImage ?? undefined : undefined,
        aspect: isVideo ? aspect : undefined,
      });
      setPrompt('');
      refetch();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not start generation');
    } finally {
      setSubmitting(false);
    }
  };

  const sessionCost = assets.filter(a => a.source === 'generated' && (a.status === 'done' || a.status === 'approved')).reduce((s, a) => s + a.cost, 0);
  const generating = assets.filter(a => a.status === 'queued' || a.status === 'generating');
  const bin = assets.filter(a => a.status !== 'queued' && a.status !== 'generating');

  return (
    <AppShell active="studio" onSearch={() => {}}>
      <style>{PAGE_CSS}</style>
      <div style={{ padding: '24px 28px 36px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Studio</h1>
            <p style={{ margin: '6px 0 0', font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>Generate images, video, voice, and music on your fal.ai key — saved to ~/Maestro.</p>
          </div>
          {hasFal && <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 34, padding: '0 13px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', border: '0.5px solid var(--separator)' }}>
            <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>This session</span>
            <span style={{ font: '600 var(--fs-subhead)/1 var(--font-mono)', color: 'var(--ink)' }}>${sessionCost.toFixed(2)}</span>
          </div>}
        </div>

        {hasFal === false ? <NoKeyCard onConnected={() => setHasFal(true)} /> : (
          <>
            {/* stage stepper */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
              {STAGES.map(s => {
                const on = s.key === stageKey;
                return (
                  <button key={s.key} onClick={() => { setStageKey(s.key); setErr(''); }} className="pipe-stage" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 36, padding: '0 15px', borderRadius: 'var(--r-pill)',
                    background: on ? 'var(--blue)' : 'var(--fill-secondary)', color: on ? '#fff' : 'var(--ink-secondary)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
                    <Icon name={s.icon} size={16} /> {s.label}
                  </button>
                );
              })}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 380px) minmax(0, 1fr)', gap: 22, alignItems: 'start' }}>
              {/* composer */}
              <div style={{ background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* project + model */}
                <div style={{ display: 'flex', gap: 10 }}>
                  <label style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 6 }}>Project</span>
                    <select value={projectId ?? ''} onChange={e => setProjectId(e.target.value || null)} style={{ width: '100%', height: 36, borderRadius: 9, border: '1px solid var(--separator-strong)', background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-text)', padding: '0 8px' }}>
                      <option value="">No project</option>
                      {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>
                  <label style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 6 }}>Model</span>
                    <select value={modelKey} onChange={e => setModelKey(e.target.value)} style={{ width: '100%', height: 36, borderRadius: 9, border: '1px solid var(--separator-strong)', background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-text)', padding: '0 8px' }}>
                      {stageModels.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </select>
                  </label>
                </div>
                {model && <div style={{ font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: -8 }}>{model.blurb} · ≈ ${model.rate.toFixed(3)}{model.perSecond ? '/s' : ''} est.</div>}

                {/* prompt */}
                <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} placeholder={stage.key === 'voice' ? 'The script to speak…' : 'Describe what to generate…'}
                  style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--separator-strong)', borderRadius: 12, outline: 'none', background: 'var(--bg)', resize: 'vertical', font: '400 var(--fs-body)/1.5 var(--font-text)', color: 'var(--ink)', padding: 12, minHeight: 96 }} />

                {/* avatar source picker */}
                {stage.needsImage && (
                  <div>
                    <span style={{ display: 'block', font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 7 }}>Source image (from your generated images)</span>
                    {doneImages.length === 0 ? <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>Generate an Image first, then pick it here.</div>
                      : <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                          {doneImages.map(img => (
                            <button key={img.id} onClick={() => setSourceImage(img.url ?? null)} style={{ flexShrink: 0, width: 64, height: 64, borderRadius: 10, overflow: 'hidden', border: `2px solid ${sourceImage === img.url ? 'var(--blue)' : 'transparent'}`, padding: 0, background: 'none' }}>
                              <img src={img.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            </button>
                          ))}
                        </div>}
                  </div>
                )}

                {/* consent */}
                {stage.needsConsent && (
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: 12, borderRadius: 12, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} style={{ marginTop: 2 }} />
                    <span style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>I have consent from anyone whose likeness or voice this generates. Lip-sync avatar generation ships next; today this animates the source image.</span>
                  </label>
                )}

                {/* controls */}
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  {isTimed && (
                    <label>
                      <span style={{ display: 'block', font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 6 }}>Duration</span>
                      <select value={durationS} onChange={e => setDurationS(Number(e.target.value))} style={{ height: 34, borderRadius: 9, border: '1px solid var(--separator-strong)', background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-text)', padding: '0 8px' }}>
                        {(isVideo ? [5, 10] : [10, 30, 60, 90]).map(d => <option key={d} value={d}>{d}s</option>)}
                      </select>
                    </label>
                  )}
                  {isVideo && (
                    <label>
                      <span style={{ display: 'block', font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 6 }}>Aspect</span>
                      <select value={aspect} onChange={e => setAspect(e.target.value)} style={{ height: 34, borderRadius: 9, border: '1px solid var(--separator-strong)', background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-text)', padding: '0 8px' }}>
                        {['16:9', '9:16', '1:1'].map(a => <option key={a} value={a}>{a}</option>)}
                      </select>
                    </label>
                  )}
                  {stage.key === 'voice' && (
                    <label>
                      <span style={{ display: 'block', font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 6 }}>Voice</span>
                      <select value={voice} onChange={e => setVoice(e.target.value)} style={{ height: 34, borderRadius: 9, border: '1px solid var(--separator-strong)', background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-mono)', padding: '0 8px' }}>
                        {VOICES.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </label>
                  )}
                </div>

                {err && <div style={{ padding: '9px 12px', borderRadius: 10, background: 'rgba(255,59,48,0.1)', color: 'var(--red)', font: '500 var(--fs-footnote)/1.4 var(--font-text)' }}>{err}</div>}

                <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 4 }}>
                  <span style={{ flex: 1, font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)' }}>≈ ${est.toFixed(3)}</span>
                  <button onClick={generate} disabled={!canGenerate} className="send-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 44, padding: '0 22px', borderRadius: 'var(--r-pill)',
                    background: canGenerate ? 'var(--blue)' : 'var(--fill-secondary)', color: canGenerate ? '#fff' : 'var(--ink-tertiary)', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: canGenerate ? '0 6px 18px rgba(0,122,255,0.3)' : 'none' }}>
                    {submitting ? <><Spinner size={14} color="#fff" /> Starting…</> : <><Icon name="spark" size={17} /> Generate</>}
                  </button>
                </div>
              </div>

              {/* bin */}
              <div>
                {generating.length > 0 && (
                  <div style={{ marginBottom: 18 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
                      <span className="breathe" style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--purple)' }} />
                      <span style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>Rendering · {generating.length}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
                      {generating.map(a => <AssetCard key={a.id} a={a} onCancel={() => void api.cancelAsset(a.id).catch(() => {})} onApprove={() => {}} onDelete={() => {}} onReveal={() => {}} />)}
                    </div>
                  </div>
                )}

                <div style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)', marginBottom: 11 }}>Asset bin</div>
                {bin.length === 0 ? (
                  <div style={{ padding: '48px 0', textAlign: 'center', background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>
                    Nothing yet. Write a prompt and hit Generate.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
                    {bin.map(a => (
                      <AssetCard key={a.id} a={a}
                        onCancel={() => {}}
                        onApprove={() => { void api.approveAsset(a.id).then(() => navigate('/publishing')).catch(() => {}); }}
                        onDelete={() => void api.deleteAsset(a.id).then(refetch).catch(() => {})}
                        onReveal={() => { if (a.localPath) void api.revealPath(a.localPath); }}
                        onUseAsSource={() => { setStageKey('avatar'); setSourceImage(a.url ?? null); }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
