/* GitOpsDock — the ONE source of truth for per-session git/PR actions in the
   chat header.

   Replaces the scattered GitStatusBar (transcript chip + ProjectDetail header
   bar + various toolbar buttons). The collapsed pill always shows the live
   state + its primary action. Click to expand the dock for branch metadata,
   diff entry, and every available action gated by a confirm dialog.

   This file owns three things:
     1. The collapsed pill (`<button aria-expanded>`).
     2. The expanded dock (`role="dialog"` + focus trap + Esc + outside-click).
     3. A tiny inline ConfirmDialog for destructive actions (a stand-in for
        #63's PrActionConfirmDialog until that PR lands, at which point the
        import here flips to the shared dialog).

   Wiring:
     • Reads state via useGitOpsState(sessionId).
     • Runs actions via runGitOpsAction (a pure dispatch over api.*).
     • Renders nothing for no-repo / null session.

   Accessibility:
     • Pill is a real <button> with aria-expanded + aria-controls.
     • Expanded popover is role="dialog" + aria-modal=false (page stays usable);
       Tab cycles within, Esc closes, outside-click closes, focus returns to
       the pill on close.
     • Every action button has a descriptive aria-label that names the branch
       or PR ("Merge PR #42", "Push branch foo/bar"). */

import React from 'react';
import { api } from '../lib/api';
import { displayCodename, codenameFromBranch, SESSION_STATE_COLOR } from '../lib/git-types';
import type { GithubConnection } from '../lib/git-types';
import { SessionStateDot } from '../screens/SessionStateDot';
import { useSession } from '../lib/useSessionGitState';
import { useGitOpsState, runGitOpsAction, type GitOpsAction } from '../hooks/useGitOpsState';

/* ── inline ConfirmDialog (replace with #63's PrActionConfirmDialog when merged) ── */
function ConfirmDialog({ open, title, body, okText, danger, onCancel, onOk, busy }: {
  open: boolean;
  title: string;
  body: string;
  okText: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onOk: () => void;
}) {
  const okRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!open) return;
    // Focus the OK button so the keyboard path is one Enter away — matches
    // macOS native confirm dialogs.
    const t = setTimeout(() => okRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey, true); };
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div role="presentation" onClick={onCancel} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', zIndex: 9000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)',
    }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="git-confirm-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440, maxWidth: 'calc(100vw - 32px)', padding: 20,
          borderRadius: 14, background: 'var(--bg-elevated)',
          boxShadow: '0 30px 60px rgba(0,0,0,0.25), 0 0 0 0.5px var(--separator-strong)',
          font: '500 var(--fs-body)/1.45 var(--font-text)', color: 'var(--ink)',
        }}>
        <div id="git-confirm-title" style={{ font: '700 var(--fs-headline)/1.2 var(--font-text)', marginBottom: 8 }}>{title}</div>
        <div style={{ color: 'var(--ink-secondary)', marginBottom: 18 }}>{body}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            height: 32, padding: '0 14px', borderRadius: 8, border: '0.5px solid var(--separator-strong)',
            background: 'var(--fill-secondary)', color: 'var(--ink)',
            font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer',
          }}>Cancel</button>
          <button ref={okRef} onClick={onOk} disabled={busy} style={{
            height: 32, padding: '0 16px', borderRadius: 8, border: '0.5px solid transparent',
            background: danger ? 'var(--red)' : 'var(--blue)', color: 'white',
            font: '700 var(--fs-footnote)/1 var(--font-text)', cursor: busy ? 'wait' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}>{busy ? 'Working…' : okText}</button>
        </div>
      </div>
    </div>
  );
}

/* ── inline CommitComposer (small overlay near the dock for the uncommitted state) ── */
function CommitComposer({ open, onCancel, onSubmit, busy }: {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (subject: string, body: string) => void;
}) {
  const [subject, setSubject] = React.useState('');
  const [body, setBody] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!open) { setSubject(''); setBody(''); return; }
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey, true);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey, true); };
  }, [open, onCancel]);
  if (!open) return null;

  const trimmed = subject.trim();
  const ok = trimmed.length >= 3 && trimmed.length <= 72;
  const submit = () => { if (ok && !busy) onSubmit(trimmed, body.trim()); };

  return (
    <div role="presentation" onClick={onCancel} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', zIndex: 9000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)',
    }}>
      <div role="dialog" aria-modal="true" aria-labelledby="git-commit-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 540, maxWidth: 'calc(100vw - 32px)', padding: 20, borderRadius: 14,
          background: 'var(--bg-elevated)',
          boxShadow: '0 30px 60px rgba(0,0,0,0.25), 0 0 0 0.5px var(--separator-strong)',
          color: 'var(--ink)',
        }}>
        <div id="git-commit-title" style={{ font: '700 var(--fs-headline)/1.2 var(--font-text)', marginBottom: 4 }}>Commit changes</div>
        <div style={{ font: '500 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 14 }}>
          Use a Conventional-Commits prefix like <code>feat(desktop):</code> or <code>fix:</code> — the agent reads these for the changelog.
        </div>
        <input ref={inputRef} value={subject} onChange={(e) => setSubject(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder="Subject (e.g. fix(desktop): handle empty branch)"
          maxLength={72} aria-label="Commit subject"
          style={{
            width: '100%', boxSizing: 'border-box', height: 36, padding: '0 12px', borderRadius: 8,
            border: '0.5px solid var(--separator-strong)', background: 'var(--fill-tertiary)', color: 'var(--ink)',
            font: '500 var(--fs-body)/1 var(--font-text)', marginBottom: 10,
          }} />
        <textarea value={body} onChange={(e) => setBody(e.target.value)}
          placeholder="Body (optional). Why, not what."
          aria-label="Commit body"
          style={{
            width: '100%', boxSizing: 'border-box', minHeight: 80, padding: '8px 12px', borderRadius: 8,
            border: '0.5px solid var(--separator-strong)', background: 'var(--fill-tertiary)', color: 'var(--ink)',
            font: '500 var(--fs-body)/1.4 var(--font-text)', resize: 'vertical',
          }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
          <div style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>
            {subject.length}/72
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onCancel} style={{
              height: 32, padding: '0 14px', borderRadius: 8, border: '0.5px solid var(--separator-strong)',
              background: 'var(--fill-secondary)', color: 'var(--ink)',
              font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer',
            }}>Cancel</button>
            <button onClick={submit} disabled={!ok || busy} style={{
              height: 32, padding: '0 16px', borderRadius: 8, border: '0.5px solid transparent',
              background: 'var(--blue)', color: 'white',
              font: '700 var(--fs-footnote)/1 var(--font-text)',
              cursor: ok && !busy ? 'pointer' : 'not-allowed', opacity: ok && !busy ? 1 : 0.5,
            }}>{busy ? 'Asking agent…' : 'Ask agent to commit'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── small helpers ───────────────────────────────────────────────────────── */

function relativeTime(at: number | null | undefined): string {
  if (!at) return '';
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(at).toLocaleDateString();
}

/** ARIA-friendly aria-label for an action button, e.g. "Merge PR #42". */
function ariaLabelFor(action: GitOpsAction, branch: string | null, prNumber: number | null): string {
  const where = prNumber != null ? `PR #${prNumber}` : branch ? `branch ${branch}` : 'this session';
  switch (action.kind) {
    case 'merge': return `Merge ${where}`;
    case 'create-pr': return `Open pull request for ${branch ?? 'branch'}`;
    case 'push': return `Push ${branch ?? 'branch'} to origin`;
    case 'commit': return 'Commit pending changes';
    case 'resolve': return `Resolve conflicts on ${where}`;
    case 'open-pr': return `Open ${where} on GitHub`;
    case 'continue': return 'Continue from the merged commit (T7)';
    case 'view-diff': return 'View diff in the transcript';
    case 'rename-branch': return `Rename ${branch ?? 'branch'} to the task slug`;
    case 'archive': return `Archive worktree for ${branch ?? 'session'}`;
  }
}

/* ── the dock ────────────────────────────────────────────────────────────── */

export interface GitOpsDockProps {
  sessionId: string | null;
  /** Display-friendly codename for the active session (e.g. "Lyon"). */
  codename?: string | null;
}

export function GitOpsDock({ sessionId, codename }: GitOpsDockProps) {
  const dock = useGitOpsState(sessionId);
  const session = useSession(sessionId);
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [pendingConfirm, setPendingConfirm] = React.useState<GitOpsAction | null>(null);
  const [composerOpen, setComposerOpen] = React.useState(false);
  const [gh, setGh] = React.useState<GithubConnection | null>(null);
  const [copied, setCopied] = React.useState(false);

  const pillRef = React.useRef<HTMLButtonElement>(null);
  const popoverRef = React.useRef<HTMLDivElement>(null);

  // On first mount per session: refresh-with-PR so the action label is
  // accurate on day-zero (mirrors the GitStatusBar's behavior).
  const refreshedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!sessionId || refreshedRef.current === sessionId) return;
    refreshedRef.current = sessionId;
    api.refreshSessionGitStatus(sessionId).catch(() => {});
  }, [sessionId]);

  // Pre-flight: GitHub status, so we can disable PR-bound actions before the
  // user clicks and gets a server-side rejection.
  const needsGitHub = !!dock.actions.find(a => a.needsGitHub);
  React.useEffect(() => {
    if (!needsGitHub) { setGh(null); return; }
    let on = true;
    api.githubStatus().then(s => { if (on) setGh(s); }).catch(() => { if (on) setGh(null); });
    return () => { on = false; };
  }, [needsGitHub]);

  // Esc + outside-click + focus-trap (only when expanded).
  React.useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setExpanded(false); pillRef.current?.focus(); }
      else if (e.key === 'Tab') {
        // crude focus trap: keep tab focus inside the popover
        const root = popoverRef.current; if (!root) return;
        const focusables = root.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])');
        if (!focusables.length) return;
        const first = focusables[0]; const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    const onClick = (e: MouseEvent) => {
      const root = popoverRef.current;
      if (root && !root.contains(e.target as Node) && pillRef.current && !pillRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onClick, true);
    // Move focus into the popover.
    setTimeout(() => { popoverRef.current?.querySelector<HTMLElement>('button, [href]')?.focus(); }, 20);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onClick, true); };
  }, [expanded]);

  if (!sessionId || !dock.visible || !dock.state) return null;

  const status = dock.status!;
  const code = codename || codenameFromBranch(status.branch);
  const ghBlocked = needsGitHub && gh != null && (!gh.connected || !gh.hasRepoScope);

  /** Run an action (either directly or behind the confirm dialog). */
  const trigger = (action: GitOpsAction): void => {
    if (action.stub) { setFeedback({ kind: 'ok', text: 'Coming in T7 — Continue from here.' }); return; }
    if (action.kind === 'commit') { setComposerOpen(true); return; }
    if (action.destructive || action.confirm) { setPendingConfirm(action); return; }
    void execute(action);
  };

  const execute = async (action: GitOpsAction): Promise<void> => {
    if (busy) return;
    setBusy(true); setFeedback(null);
    try {
      const r = await runGitOpsAction(action, status);
      if (r.ok) {
        if (action.okText) setFeedback({ kind: 'ok', text: action.okText });
      } else setFeedback({ kind: 'err', text: r.reason || 'Action failed.' });
    } catch (e) {
      setFeedback({ kind: 'err', text: e instanceof Error ? e.message : 'Action failed.' });
    } finally {
      setBusy(false);
      try { await api.refreshSessionGitStatus(sessionId); } catch { /* ignore */ }
    }
  };

  const onConfirm = async (): Promise<void> => {
    const a = pendingConfirm; setPendingConfirm(null);
    if (a) await execute(a);
  };

  const onCommitSubmit = async (subject: string, body: string): Promise<void> => {
    setComposerOpen(false);
    // No direct IPC for `git commit` from the renderer; the safe path is to
    // ask the agent in this chat to make the commit with this exact message.
    // The agent already has Bash; this stays consistent with how every other
    // git op (push/PR/merge/resolve) flows on master.
    if (!session?.projectId) { setFeedback({ kind: 'err', text: 'Session has no project.' }); return; }
    setBusy(true); setFeedback(null);
    try {
      const msg = body ? `${subject}\n\n${body}` : subject;
      const safeSubject = subject.replace(/"/g, '\\"');
      const text = `Please commit the pending changes with this exact message:\n\n${msg}\n\nRun \`git add -A\` then \`git commit -m "${safeSubject}"\`${body ? ` followed by \`-m "<body>"\`` : ''}. Do not push.`;
      await api.sendChat({ projectId: session.projectId, sessionId: sessionId!, text });
      setFeedback({ kind: 'ok', text: 'Asked the agent to commit.' });
    } catch (e) {
      setFeedback({ kind: 'err', text: e instanceof Error ? e.message : 'Failed to send commit request.' });
    } finally {
      setBusy(false);
    }
  };

  const copyBranch = async (): Promise<void> => {
    if (!status.branch) return;
    try { await navigator.clipboard.writeText(status.branch); setCopied(true); setTimeout(() => setCopied(false), 1200); }
    catch { /* clipboard blocked */ }
  };

  const stateColor = SESSION_STATE_COLOR[status.state] || 'var(--ink-tertiary)';
  const primary = dock.primary;
  const popoverId = `git-ops-dock-pop-${sessionId}`;

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      {/* ── Collapsed pill ───────────────────────────────────────────────── */}
      <button ref={pillRef}
        type="button"
        aria-expanded={expanded}
        aria-haspopup="dialog"
        aria-controls={popoverId}
        onClick={() => setExpanded(v => !v)}
        title={code ? `${displayCodename(code)} · ${dock.label}` : dock.label}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, padding: '0 4px 0 9px',
          height: 28, borderRadius: 14,
          background: 'color-mix(in srgb, var(--ink) 4%, transparent)',
          border: `0.5px solid ${expanded ? 'var(--separator-strong)' : 'var(--separator)'}`,
          color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)',
          cursor: 'pointer',
        }}>
        <span aria-hidden="true" style={{
          width: 4, height: 4, borderRadius: 2, background: stateColor, marginRight: 2,
        }} />
        <span>{dock.label}</span>
        {primary && primary.kind !== 'commit' && primary.kind !== 'continue' && status.pr?.number != null && (
          <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>#{status.pr.number}</span>
        )}
        {primary ? (
          // Inline primary action — separate click target inside the pill button
          // would nest <button>s, so we render a styled <span role="button"> that
          // intercepts the click before the pill's toggle.
          <span
            role="button"
            tabIndex={0}
            aria-label={ariaLabelFor(primary, status.branch, status.pr?.number ?? null)}
            aria-disabled={busy || ghBlocked || !!primary.stub}
            onClick={(e) => { e.stopPropagation(); if (busy || ghBlocked) return; trigger(primary); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (busy || ghBlocked) return; trigger(primary); } }}
            title={ghBlocked ? 'Connect GitHub first (Settings → GitHub)' : primary.label}
            style={{
              display: 'inline-flex', alignItems: 'center',
              height: 22, padding: '0 11px', marginLeft: 4, borderRadius: 11,
              background: primary.tone === 'danger' ? 'color-mix(in srgb, var(--red) 18%, transparent)'
                : 'color-mix(in srgb, var(--blue) 16%, transparent)',
              color: primary.tone === 'danger' ? 'var(--red)' : 'var(--blue)',
              font: '700 var(--fs-caption)/1 var(--font-text)',
              cursor: (busy || ghBlocked) ? 'not-allowed' : 'pointer',
              opacity: (busy || ghBlocked || primary.stub) ? 0.65 : 1,
              userSelect: 'none',
            }}>
            {busy ? '…' : primary.label}
          </span>
        ) : (
          <span aria-hidden="true" style={{ width: 6 }} />
        )}
      </button>

      {/* persistent feedback chip (sticks until the next action) */}
      {feedback && (
        <span role="status" style={{
          marginLeft: 8, alignSelf: 'center',
          font: '500 var(--fs-caption)/1 var(--font-text)',
          color: feedback.kind === 'err' ? 'var(--red)' : 'var(--green, #34c759)',
          maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{feedback.kind === 'err' ? '⚠ ' : '✓ '}{feedback.text}</span>
      )}
      {!feedback && ghBlocked && (
        <span role="status" style={{
          marginLeft: 8, alignSelf: 'center',
          font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--orange, #ff9500)',
        }}>⚠ Connect GitHub</span>
      )}

      {/* ── Expanded dock (popover) ─────────────────────────────────────── */}
      {expanded && (
        <div ref={popoverRef} id={popoverId} role="dialog" aria-label="Git operations"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, minWidth: 340,
            maxWidth: 420, padding: 14, borderRadius: 14,
            background: 'var(--bg-elevated)',
            boxShadow: '0 18px 36px rgba(0,0,0,0.18), 0 0 0 0.5px var(--separator-strong)',
            zIndex: 20,
          }}>
          {/* Branch row + base + ahead/behind + dirty count + view-diff */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <SessionStateDot state={status.state} size={9} />
            <span style={{ font: '700 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)' }}>{dock.label}</span>
            {status.pr && (
              <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>· PR #{status.pr.number}</span>
            )}
          </div>
          <button type="button" onClick={copyBranch}
            aria-label={`Copy branch name ${status.branch ?? ''} to clipboard`}
            title={copied ? 'Copied' : 'Click to copy branch name'}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '6px 8px', borderRadius: 7,
              background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)',
              color: 'var(--ink)', font: '500 var(--fs-caption)/1 var(--font-mono)',
              cursor: 'pointer', textAlign: 'left',
            }}>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {status.branch ?? '(detached)'}
            </span>
            <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: copied ? 'var(--green, #34c759)' : 'var(--ink-tertiary)' }}>
              {copied ? '✓ copied' : 'copy'}
            </span>
          </button>
          {status.base && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, font: '500 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>
              <span style={{ color: 'var(--ink-tertiary)' }}>Base</span>
              <span style={{ color: 'var(--ink)', font: '500 var(--fs-caption)/1 var(--font-mono)' }}>{status.base}</span>
              <span style={{ color: 'var(--ink-tertiary)', marginLeft: 'auto', font: '500 var(--fs-caption)/1 var(--font-mono)' }}>
                ↑{status.local.ahead} · ↓{status.local.behind}
              </span>
            </div>
          )}
          {status.snapshot?.lastSubject && (
            <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 7, background: 'var(--fill-tertiary)' }}>
              <div style={{ font: '600 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {status.snapshot.lastSubject}
              </div>
              <div style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 3 }}>
                Last commit · {relativeTime(status.snapshot.lastCommitAt)}
              </div>
            </div>
          )}
          {status.snapshot && status.snapshot.dirtyFiles > 0 && (
            <div style={{ marginTop: 8, font: '500 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>
              <span style={{ color: 'var(--orange, #ff9500)' }}>●</span> {status.snapshot.dirtyFiles} dirty file{status.snapshot.dirtyFiles === 1 ? '' : 's'}
            </div>
          )}

          {/* Action list (all available for this state) */}
          <div role="group" aria-label="Available actions" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {dock.actions.length === 0 && (
              <div style={{ font: '500 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>
                Nothing to do here — the working tree is clean.
              </div>
            )}
            {dock.actions.map((a) => {
              const disabled = busy || a.stub || (a.needsGitHub && ghBlocked);
              return (
                <button key={a.kind} type="button"
                  onClick={() => { setExpanded(false); trigger(a); }}
                  disabled={disabled}
                  aria-label={ariaLabelFor(a, status.branch, status.pr?.number ?? null)}
                  title={a.needsGitHub && ghBlocked ? 'Connect GitHub first (Settings → GitHub)' : a.label}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    height: 32, padding: '0 12px', borderRadius: 8,
                    background: a.kind === dock.primary?.kind ? (a.tone === 'danger' ? 'color-mix(in srgb, var(--red) 14%, transparent)' : 'color-mix(in srgb, var(--blue) 12%, transparent)') : 'var(--fill-secondary)',
                    border: `0.5px solid ${a.kind === dock.primary?.kind ? 'transparent' : 'var(--separator)'}`,
                    color: a.tone === 'danger' ? 'var(--red)' : (a.kind === dock.primary?.kind ? 'var(--blue)' : 'var(--ink)'),
                    font: '600 var(--fs-footnote)/1 var(--font-text)',
                    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
                  }}>
                  <span>{a.label}{a.stub ? ' · soon' : ''}</span>
                  {a.destructive && <span aria-hidden="true" style={{ font: '700 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>destructive</span>}
                </button>
              );
            })}
            {/* always-available branch helper */}
            <button type="button" onClick={() => { setExpanded(false); trigger({ kind: 'rename-branch', label: 'Rename branch to task slug', tone: 'neutral', destructive: false, needsGitHub: false }); }}
              disabled={busy}
              aria-label={ariaLabelFor({ kind: 'rename-branch' } as GitOpsAction, status.branch, null)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                height: 28, padding: '0 12px', borderRadius: 8, marginTop: 4,
                background: 'transparent', border: '0.5px dashed var(--separator)',
                color: 'var(--ink-secondary)', font: '500 var(--fs-caption)/1 var(--font-text)',
                cursor: busy ? 'not-allowed' : 'pointer',
              }}>
              Rename branch to task slug
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingConfirm}
        title={pendingConfirm?.label ?? 'Confirm'}
        body={pendingConfirm?.confirm ?? ''}
        okText={pendingConfirm?.label ?? 'OK'}
        danger={pendingConfirm?.tone === 'danger' || pendingConfirm?.destructive}
        busy={busy}
        onCancel={() => setPendingConfirm(null)}
        onOk={() => { void onConfirm(); }}
      />
      <CommitComposer open={composerOpen} busy={busy}
        onCancel={() => setComposerOpen(false)}
        onSubmit={(s, b) => { void onCommitSubmit(s, b); }} />
    </div>
  );
}
