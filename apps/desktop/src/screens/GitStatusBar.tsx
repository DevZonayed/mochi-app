import React from 'react';
import { api } from '../lib/api';
import type { SessionGitState, SessionGitStatus } from '../lib/git-types';
import { codenameFromBranch, displayCodename, SESSION_STATE_LABELS } from '../lib/git-types';
import { SessionStateDot } from './SessionStateDot';
import { useSessionGitState } from '../lib/useSessionGitState';

/* Per-session PR/git status chip + the single contextual action (Conductor-style).
   Subscribes to live git-status events via the shared cache; outward actions
   confirm first. Renders nothing for non-repo sessions or one-off jobs
   (no sessionId).

   Two variants:
   • `inline` (default) — the small chip used in the transcript header
   • `header`  — chat-header bar used at the top of ChatThread, shows the
     codename and is more prominent. The action button is larger and tinted. */

const btnInline: React.CSSProperties = {
  height: 24, padding: '0 10px', borderRadius: 6, border: '0.5px solid var(--separator-strong)',
  background: 'var(--fill-secondary)', color: 'var(--ink)', font: '500 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer',
};
const btnHeader: React.CSSProperties = {
  height: 28, padding: '0 13px', borderRadius: 8, border: '0.5px solid color-mix(in srgb, var(--blue) 40%, transparent)',
  background: 'color-mix(in srgb, var(--blue) 12%, transparent)', color: 'var(--blue)',
  font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer',
};

interface Action { label: string; go: () => void; tone?: 'primary' | 'danger' }

function actionFor(st: SessionGitStatus, run: (fn: () => Promise<{ ok: boolean; reason?: string }>, confirmMsg?: string) => void): Action | null {
  switch (st.state) {
    case 'ready-to-push': return { label: 'Push', go: () => run(() => api.pushSession(st.sessionId)) };
    case 'ready-for-pr':  return { label: 'Create PR', tone: 'primary', go: () => run(() => api.createSessionPR(st.sessionId), 'Push the branch and open a pull request on GitHub?') };
    case 'pr-mergeable':  return { label: 'Merge', tone: 'primary', go: () => run(() => api.mergeSessionPR(st.sessionId), 'Merge this pull request on GitHub?') };
    case 'pr-conflicts':  return { label: 'Resolve', tone: 'danger', go: () => run(() => api.resolveSession(st.sessionId).then(r => ({ ok: r.ok, reason: r.conflicts?.length ? `Conflicts: ${r.conflicts.join(', ')}` : r.reason }))) };
    case 'pr-merged':     return { label: 'Archive', go: () => run(() => api.archiveSessionWorktree(st.sessionId), 'Remove this session’s worktree?') };
    default: return null;
  }
}

export interface GitStatusBarProps {
  sessionId: string | null;
  /** Display variant. `header` = chat-thread top bar with codename, `inline` =
      transcript chip. Default `inline`. */
  variant?: 'inline' | 'header';
  /** Session codename if known. The chip can also derive it from `branch`. */
  codename?: string | null;
}

export function GitStatusBar({ sessionId, variant = 'inline', codename }: GitStatusBarProps) {
  const st = useSessionGitState(sessionId);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');

  // The cache only auto-fetches without PR (cheap). The header variant wants
  // a one-time WITH-PR refresh on first mount per session so the action label
  // is "Merge"/"Resolve" instead of "Create PR" on day-zero load.
  const refreshedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!sessionId || refreshedRef.current === sessionId) return;
    refreshedRef.current = sessionId;
    api.refreshSessionGitStatus(sessionId).catch(() => {});
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
    try { await api.refreshSessionGitStatus(sessionId); } catch { /* keep last */ }
  };

  const action = actionFor(st, run);
  const checks = st.pr?.checks ?? [];
  const checkSummary = checks.length ? `${checks.filter(c => c.status === 'success').length}/${checks.length} checks` : '';
  const code = codename || codenameFromBranch(st.branch);
  const label = SESSION_STATE_LABELS[st.state as SessionGitState];

  if (variant === 'header') {
    const actionBtn = action
      ? <button disabled={busy} onClick={action.go} style={{
          ...btnHeader,
          ...(action.tone === 'danger' ? { color: 'var(--red)', borderColor: 'color-mix(in srgb, var(--red) 45%, transparent)', background: 'color-mix(in srgb, var(--red) 13%, transparent)' } : {}),
        }}>{busy ? '…' : action.label}</button>
      : null;
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9, padding: '5px 9px', borderRadius: 10,
        background: 'color-mix(in srgb, var(--ink) 3.5%, transparent)', border: '0.5px solid var(--separator)',
        font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
        <SessionStateDot state={st.state} size={9} />
        {code && <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{displayCodename(code)}</span>}
        {code && <span style={{ color: 'var(--ink-tertiary)' }}>·</span>}
        <span style={{ color: 'var(--ink)' }}>{label}</span>
        {st.local.ahead > 0 && <span title="commits ahead of base" style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>↑{st.local.ahead}</span>}
        {st.local.behind > 0 && <span title="commits behind base" style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>↓{st.local.behind}</span>}
        {checkSummary && <span style={{ color: 'var(--ink-tertiary)' }}>· {checkSummary}</span>}
        {st.pr && (
          <button onClick={() => window.open(st.pr!.url, '_blank')}
            title={st.pr.title}
            style={{ height: 24, padding: '0 9px', borderRadius: 7,
              background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer' }}>
            PR #{st.pr.number}
          </button>
        )}
        {actionBtn}
        {err && <span title={err} style={{ color: 'var(--red)' }}>⚠</span>}
      </div>
    );
  }

  // inline variant
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 8,
      background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)',
      font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
      <SessionStateDot state={st.state} size={8} />
      {code && <span style={{ color: 'var(--ink)' }}>{displayCodename(code)} ·</span>}
      <span style={{ color: 'var(--ink)' }}>{label}</span>
      {st.local.ahead > 0 && <span title="commits ahead of base">↑{st.local.ahead}</span>}
      {st.local.behind > 0 && <span title="commits behind base">↓{st.local.behind}</span>}
      {checkSummary && <span>· {checkSummary}</span>}
      {st.pr && <button onClick={() => window.open(st.pr!.url, '_blank')} style={btnInline}>PR #{st.pr.number}</button>}
      {action && <button disabled={busy} onClick={action.go} style={{ ...btnInline, color: action.tone === 'danger' ? 'var(--red)' : 'var(--blue)' }}>{busy ? '…' : action.label}</button>}
      {err && <span style={{ color: 'var(--red)' }} title={err}>⚠</span>}
    </div>
  );
}
