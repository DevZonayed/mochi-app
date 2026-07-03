/* Feedback inbox — review everything collected from the "!" button across the
   desktop, web, and phone. Filter by status, triage (new → triaged → done),
   delete, and escalate the good ones to a GitHub issue (reusing the local
   GitHub token + a configurable target repo). Data lives on the Mac. */

import React from 'react';
import { AppShell } from '../lib/appShell';
import { Icon, type IconName } from '../lib/icons';
import { api, type Feedback, type FeedbackStatus, type FeedbackCategory } from '../lib/api';

const styles = `
  .app-wallpaper { position: absolute; inset: 0; z-index: 0; pointer-events: none;
    background: radial-gradient(60% 50% at 16% 0%, color-mix(in srgb, var(--blob-a) 26%, transparent), transparent 70%), radial-gradient(55% 50% at 100% 100%, color-mix(in srgb, var(--blob-b) 22%, transparent), transparent 70%), var(--bg); }
  .nav-item:hover { background: var(--fill-tertiary); color: var(--ink); }
  .ws-header:hover { background: var(--fill-tertiary); }
  .search-field:hover { background: var(--fill-secondary); }
  .tb-icon:hover { background: var(--fill-secondary); color: var(--ink); }
  .fb-card { transition: border-color 160ms ease, transform 120ms var(--spring); }
  .fb-act:hover { background: var(--fill-secondary); color: var(--ink); }
  .fb-danger:hover { background: rgba(255,59,48,0.12); color: var(--red); }
`;

const CAT_META: Record<FeedbackCategory, { label: string; icon: IconName; tint: string }> = {
  bug: { label: 'Bug', icon: 'alert', tint: 'var(--red)' },
  idea: { label: 'Idea', icon: 'spark', tint: 'var(--blue)' },
  other: { label: 'Other', icon: 'chat', tint: 'var(--ink-secondary)' },
};
const STATUS_META: Record<FeedbackStatus, { label: string; tint: string }> = {
  new: { label: 'New', tint: 'var(--blue)' },
  triaged: { label: 'Triaged', tint: 'var(--orange)' },
  done: { label: 'Done', tint: 'var(--green)' },
};
const NEXT_STATUS: Record<FeedbackStatus, FeedbackStatus> = { new: 'triaged', triaged: 'done', done: 'new' };

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); return `${d}d ago`;
}

function FeedbackCard({ f, repo, onChanged }: { f: Feedback; repo: string; onChanged: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const cat = CAT_META[f.category];
  const st = STATUS_META[f.status];

  const cycleStatus = async () => {
    setBusy(true); setError('');
    try { await api.updateFeedback(f.id, NEXT_STATUS[f.status]); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update.'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try { await api.deleteFeedback(f.id); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not delete.'); setBusy(false); }
  };
  const createIssue = async () => {
    setBusy(true); setError('');
    try { await api.feedbackCreateIssue(f.id, repo || undefined); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not create issue.'); }
    finally { setBusy(false); }
  };

  const iconBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', flexShrink: 0 };

  return (
    <div className="fb-card" style={{ background: 'var(--bg-grouped)', border: '0.5px solid var(--separator)', borderRadius: 14, padding: '14px 16px', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 9px', borderRadius: 'var(--r-pill)', background: `color-mix(in srgb, ${cat.tint} 13%, transparent)`, color: cat.tint, font: '600 var(--fs-caption)/1 var(--font-text)' }}>
          <Icon name={cat.icon} size={13} /> {cat.label}
        </span>
        <button onClick={cycleStatus} disabled={busy} title="Click to change status" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 9px', borderRadius: 'var(--r-pill)', background: `color-mix(in srgb, ${st.tint} 13%, transparent)`, color: st.tint, font: '600 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer' }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: st.tint }} /> {st.label}
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{timeAgo(f.createdAt)}</span>
      </div>

      <p style={{ margin: 0, font: '400 var(--fs-body)/1.5 var(--font-text)', color: 'var(--ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{f.message}</p>

      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 11 }}>
        {[f.source, f.context?.screen, f.context?.appVersion ? `v${f.context.appVersion}` : '', f.context?.platform]
          .filter(Boolean).map((t, i) => (
            <span key={i} style={{ padding: '2px 8px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink-tertiary)', font: '500 var(--fs-caption)/1.3 var(--font-text)' }}>{t}</span>
          ))}
        <div style={{ flex: 1 }} />
        {f.issueUrl ? (
          <a href={f.issueUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 11px', borderRadius: 'var(--r-pill)', background: 'rgba(52,199,89,0.14)', color: 'var(--green)', font: '600 var(--fs-footnote)/1 var(--font-text)', textDecoration: 'none' }}>
            <Icon name="checkCircle" size={14} /> Issue #{f.issueNumber}
          </a>
        ) : (
          <button onClick={createIssue} disabled={busy} className="fb-act" title="Create a GitHub issue from this feedback" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 11px', borderRadius: 'var(--r-pill)', background: 'var(--fill-tertiary)', color: 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
            <Icon name="gitMerge" size={14} /> {busy ? '…' : 'Create issue'}
          </button>
        )}
        <button onClick={remove} disabled={busy} className="fb-danger" aria-label="Delete feedback" title="Delete" style={iconBtn}><Icon name="x" size={16} /></button>
      </div>

      {error && <p style={{ margin: '9px 0 0', font: '500 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--red)' }}>{error}</p>}
    </div>
  );
}

type StatusFilter = 'all' | FeedbackStatus;

export default function Feedback() {
  const [items, setItems] = React.useState<Feedback[] | null>(null);
  const [filter, setFilter] = React.useState<StatusFilter>('all');
  const [repo, setRepo] = React.useState('');

  const refetch = React.useCallback(() => { api.listFeedback().then(setItems).catch(() => setItems([])); }, []);
  React.useEffect(() => {
    refetch();
    api.getSettings().then(s => setRepo(s.feedbackRepo ?? '')).catch(() => {});
    const unsub = api.subscribe({ onFeedback: () => refetch() });
    return () => unsub();
  }, [refetch]);

  const saveRepo = (v: string) => { const next = v.trim(); setRepo(next); void api.setSettings({ feedbackRepo: next }).catch(() => {}); };

  const list = items ?? [];
  const counts = { all: list.length, new: list.filter(f => f.status === 'new').length, triaged: list.filter(f => f.status === 'triaged').length, done: list.filter(f => f.status === 'done').length };
  const shown = filter === 'all' ? list : list.filter(f => f.status === filter);
  const FILTERS: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: `All ${counts.all || ''}`.trim() },
    { key: 'new', label: `New ${counts.new || ''}`.trim() },
    { key: 'triaged', label: `Triaged ${counts.triaged || ''}`.trim() },
    { key: 'done', label: `Done ${counts.done || ''}`.trim() },
  ];

  return (
    <AppShell active="feedback">
      <style>{styles}</style>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '28px 28px 48px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 18 }}>
          <div style={{ flex: 1 }}>
            <h1 style={{ margin: 0, font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Feedback</h1>
            <p style={{ margin: '6px 0 0', font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>Everything collected from the feedback button, across every device. Stored on this Mac.</p>
          </div>
        </div>

        {/* GitHub target repo (for escalating feedback → issues) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px', marginBottom: 18, background: 'var(--bg-grouped)', border: '0.5px solid var(--separator)', borderRadius: 12 }}>
          <span style={{ display: 'inline-grid', placeItems: 'center', width: 32, height: 32, borderRadius: 8, flexShrink: 0, background: 'var(--fill-secondary)', color: 'var(--ink-secondary)' }}><Icon name="gitMerge" size={17} /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', font: '600 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)' }}>Issue target</span>
            <span style={{ display: 'block', font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 1 }}>“Create issue” files here. Connect GitHub in Settings → Accounts &amp; keys.</span>
          </span>
          <input defaultValue={repo} key={repo} onBlur={e => saveRepo(e.target.value)} placeholder="owner/repo"
            style={{ width: 200, height: 32, padding: '0 10px', borderRadius: 8, border: '0.5px solid var(--separator-strong, var(--separator))', outline: 'none', background: 'var(--fill-tertiary)', font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }} />
        </div>

        {/* status filter */}
        <div style={{ display: 'inline-flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 10, marginBottom: 18 }}>
          {FILTERS.map(f => {
            const on = filter === f.key;
            return (
              <button key={f.key} onClick={() => setFilter(f.key)} style={{ padding: '6px 14px', borderRadius: 8, font: '600 var(--fs-footnote)/1 var(--font-text)', color: on ? 'var(--ink)' : 'var(--ink-secondary)', background: on ? 'var(--bg-elevated)' : 'transparent', boxShadow: on ? '0 1px 3px rgba(0,0,0,0.14)' : 'none', transition: 'background 160ms ease' }}>{f.label}</button>
            );
          })}
        </div>

        {/* list / empty / loading */}
        {items === null ? (
          <div style={{ padding: '60px 0', textAlign: 'center', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Loading…</div>
        ) : shown.length === 0 ? (
          <div style={{ padding: '64px 24px', textAlign: 'center' }}>
            <span style={{ display: 'inline-grid', placeItems: 'center', width: 56, height: 56, borderRadius: 16, background: 'var(--fill-secondary)', color: 'var(--ink-tertiary)', marginBottom: 14 }}><Icon name="feedback" size={28} /></span>
            <h3 style={{ margin: '0 0 6px', font: '600 var(--fs-headline)/1.2 var(--font-display)', color: 'var(--ink)' }}>{filter === 'all' ? 'No feedback yet' : `Nothing ${STATUS_META[filter as FeedbackStatus].label.toLowerCase()}`}</h3>
            <p style={{ margin: 0, font: '400 var(--fs-subhead)/1.45 var(--font-text)', color: 'var(--ink-secondary)' }}>Use the feedback button in the top bar to capture a bug or an idea.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {shown.map(f => <FeedbackCard key={f.id} f={f} repo={repo} onChanged={refetch} />)}
          </div>
        )}
      </div>
    </AppShell>
  );
}
