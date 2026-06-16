import React from 'react';
import { api } from '../lib/api';
import type { SessionGitStatus, SessionGitState } from '../lib/git-types';

/* Per-session PR/git status chip + the single contextual action (Conductor-style).
   Subscribes to live git-status events; outward actions confirm first. Renders
   nothing for non-repo sessions or one-off jobs (no sessionId). */

const LABELS: Record<SessionGitState, string> = {
  'no-repo': 'Not a repo',
  clean: 'No changes',
  uncommitted: 'Uncommitted',
  'ready-to-push': 'Ready to push',
  'ready-for-pr': 'Ready for PR',
  'pr-mergeable': 'PR · mergeable',
  'pr-conflicts': 'PR · conflicts',
  'pr-blocked': 'PR · checks',
  'pr-merged': 'Merged',
  'pr-closed': 'PR closed',
};

const btn: React.CSSProperties = {
  height: 24, padding: '0 10px', borderRadius: 6, border: '0.5px solid var(--separator-strong)',
  background: 'var(--fill-secondary)', color: 'var(--ink)', font: '500 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer',
};

export function GitStatusBar({ sessionId }: { sessionId: string | null }) {
  const [st, setSt] = React.useState<SessionGitStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    if (!sessionId) { setSt(null); return; }
    let alive = true;
    api.getSessionGitStatus(sessionId).then(s => { if (alive) setSt(s); }).catch(() => {});
    const unsub = api.subscribe({ onGitStatus: (s) => { if (s.sessionId === sessionId) setSt(s); } });
    return () => { alive = false; unsub(); };
  }, [sessionId]);

  if (!sessionId || !st || st.state === 'no-repo') return null;

  const run = async (fn: () => Promise<{ ok: boolean; reason?: string }>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true); setErr('');
    try {
      const r = await fn();
      if (!r.ok && r.reason) setErr(r.reason);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
    try { setSt(await api.refreshSessionGitStatus(sessionId)); } catch { /* keep last */ }
  };

  const action: { label: string; go: () => void } | null = (() => {
    switch (st.state) {
      case 'ready-to-push': return { label: 'Push', go: () => run(() => api.pushSession(sessionId)) };
      case 'ready-for-pr': return { label: 'Create PR', go: () => run(() => api.createSessionPR(sessionId), 'Push the branch and open a pull request on GitHub?') };
      case 'pr-mergeable': return { label: 'Merge', go: () => run(() => api.mergeSessionPR(sessionId), 'Merge this pull request on GitHub?') };
      case 'pr-conflicts': return { label: 'Resolve', go: () => run(() => api.resolveSession(sessionId).then(r => ({ ok: r.ok, reason: r.conflicts?.length ? `Conflicts: ${r.conflicts.join(', ')}` : r.reason }))) };
      case 'pr-merged': return { label: 'Archive', go: () => run(() => api.archiveSession(sessionId), 'Remove this session’s worktree?') };
      default: return null;
    }
  })();

  const checks = st.pr?.checks ?? [];
  const checkSummary = checks.length ? `${checks.filter(c => c.status === 'success').length}/${checks.length} checks` : '';

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 8, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
      <span style={{ color: 'var(--ink)' }}>{LABELS[st.state]}</span>
      {st.local.ahead > 0 && <span title="commits ahead of base">↑{st.local.ahead}</span>}
      {st.local.behind > 0 && <span title="commits behind base">↓{st.local.behind}</span>}
      {checkSummary && <span>· {checkSummary}</span>}
      {st.pr && <button onClick={() => window.open(st.pr!.url, '_blank')} style={btn}>PR #{st.pr.number}</button>}
      {action && <button disabled={busy} onClick={action.go} style={{ ...btn, color: 'var(--blue)' }}>{busy ? '…' : action.label}</button>}
      {err && <span style={{ color: 'var(--red)' }} title={err}>⚠</span>}
    </div>
  );
}
