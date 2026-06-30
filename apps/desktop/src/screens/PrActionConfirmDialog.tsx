/* PrActionConfirmDialog — the HARD-BUTTON gate for pr_merge / pr_resolve_conflicts.

   Why a real modal (not the existing window.confirm + AskUserQuestion path):
   when the AGENT calls pr_merge or pr_resolve_conflicts the destructive action
   MUST go through a human click. The agent's MCP tool returns immediately with
   a `needsConfirm` preview and emits a `pr-confirm-request` event the renderer
   listens for here. We render a modal with the PR title / mergeable state /
   conflicted files, and two buttons:

     • Cancel (default-focused, Esc closes)         — does nothing
     • Confirm Merge / Apply Resolution             — requires a CLICK
       (Enter is NOT bound — prevents an accidental keystroke from landing a
        merge or pulling base into the worktree)

   On Confirm, we re-invoke the existing IPC handlers (mergeSessionPR /
   resolveSession), which are the renderer-only paths that execute without
   gating. The agent's `confirmed: true` flag never reaches the engine — only
   this dialog can trigger the destructive call. See electron/git-ctx.ts for
   the contract. */

import React from 'react';
import { api } from '../lib/api';
import type { MergePreview, ResolvePreview, PrConfirmRequest } from '../lib/git-types';

interface DialogState { req: PrConfirmRequest; openedAt: number }

interface ToastState { kind: 'ok' | 'err'; text: string; sessionId: string | null }

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 9999,
  background: 'rgba(0,0,0,0.45)',
  display: 'grid', placeItems: 'center',
  backdropFilter: 'blur(2px)',
  WebkitBackdropFilter: 'blur(2px)',
};
const cardStyle: React.CSSProperties = {
  width: 'min(440px, 92vw)',
  background: 'var(--bg-elevated)',
  color: 'var(--ink)',
  borderRadius: 14,
  border: '0.5px solid var(--separator)',
  boxShadow: 'var(--card-shadow)',
  padding: 18,
  display: 'flex', flexDirection: 'column', gap: 12,
  font: '500 var(--fs-footnote)/1.4 var(--font-text)',
};
const btnBase: React.CSSProperties = {
  height: 32, padding: '0 14px', borderRadius: 8,
  font: '600 var(--fs-footnote)/1 var(--font-text)',
  cursor: 'pointer',
};
const btnCancel: React.CSSProperties = {
  ...btnBase,
  background: 'var(--fill-secondary)',
  color: 'var(--ink)',
  border: '0.5px solid var(--separator-strong)',
};
const btnConfirm: React.CSSProperties = {
  ...btnBase,
  background: 'var(--blue)',
  color: '#FFFFFF',
  border: '0.5px solid var(--blue-press)',
};
const btnDanger: React.CSSProperties = {
  ...btnBase,
  background: 'var(--color-danger)',
  color: '#FFFFFF',
  border: '0.5px solid color-mix(in srgb, var(--color-danger) 70%, black)',
};

function isMergePreview(p: PrConfirmRequest): p is PrConfirmRequest & { action: 'pr_merge'; preview: MergePreview } {
  return p.action === 'pr_merge';
}

/** Mount once at the app root. Subscribes to `pr-confirm-request` events and
 *  shows the modal until the user clicks Cancel or Confirm. */
export function PrActionConfirmDialog() {
  const [state, setState] = React.useState<DialogState | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<ToastState | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);

  // Subscribe to the agent's confirm-request events. Most-recent-wins: a new
  // request replaces a pending one (rare — the agent would have to call pr_merge
  // twice in flight). Auto-clears on close so the modal can be re-opened.
  React.useEffect(() => {
    const off = api.subscribe({
      onPrConfirmRequest: (req) => {
        setErr(null);
        setState({ req, openedAt: Date.now() });
      },
    });
    return off;
  }, []);

  // Esc → cancel; intentionally NO Enter binding (the click is the gate).
  React.useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Focus Cancel on open — accidental Enter / Space goes to Cancel, not Confirm.
  React.useEffect(() => {
    if (state) {
      // Defer to next frame so the button is mounted.
      const id = requestAnimationFrame(() => { cancelRef.current?.focus(); });
      return () => cancelAnimationFrame(id);
    }
  }, [state]);

  function close() { setState(null); setErr(null); setBusy(false); }
  function cancel() { if (!busy) close(); }

  async function confirm() {
    if (!state || busy) return;
    const { req } = state;
    setBusy(true); setErr(null);
    try {
      if (isMergePreview(req)) {
        if (!req.sessionId) throw new Error('session id missing — cannot merge');
        const r = await api.mergeSessionPR(req.sessionId);
        if (!r.ok) throw new Error(r.reason || 'Merge failed');
        setToast({ kind: 'ok', text: `Merged PR #${req.preview.prNumber}.`, sessionId: req.sessionId });
      } else {
        if (!req.sessionId) throw new Error('session id missing — cannot resolve');
        const r = await api.resolveSession(req.sessionId);
        if (!r.ok && (!r.conflicts || r.conflicts.length === 0)) {
          throw new Error(r.reason || 'Resolve failed');
        }
        const note = r.conflicts && r.conflicts.length
          ? `Pulled base; ${r.conflicts.length} file(s) need conflict markers resolved.`
          : 'Base merged cleanly and pushed.';
        setToast({ kind: 'ok', text: note, sessionId: req.sessionId });
      }
      // Refresh the chip's status post-action so the UI catches up.
      try { await api.refreshSessionGitStatus(req.sessionId!); } catch { /* non-fatal */ }
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed.');
      setBusy(false);
    }
  }

  // Auto-clear the toast after 4s. Stays out of the agent's transcript — this
  // is a desktop UI confirmation, not an agent message.
  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <>
      {state && (
        <div role="dialog" aria-modal="true" aria-labelledby="pr-confirm-title" style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}>
          <div style={cardStyle}>
            {isMergePreview(state.req)
              ? <MergeBody preview={state.req.preview as MergePreview} err={err} />
              : <ResolveBody preview={state.req.preview as ResolvePreview} err={err} />}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button ref={cancelRef} onClick={cancel} disabled={busy} style={{ ...btnCancel, ...(busy ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}>
                Cancel
              </button>
              {/* IMPORTANT: type="button" so Enter on focus doesn't submit a parent form,
                 and we do NOT call confirm() on Enter — the click event IS the gate. */}
              <button type="button" onClick={confirm} disabled={busy}
                style={isMergePreview(state.req) ? btnConfirm : btnDanger}>
                {busy
                  ? <Spinner />
                  : (isMergePreview(state.req) ? 'Confirm Merge' : 'Apply Resolution')}
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div role="status" aria-live="polite" style={{
          position: 'fixed', bottom: 22, right: 22, zIndex: 10000,
          maxWidth: 340, padding: '10px 14px', borderRadius: 10,
          background: toast.kind === 'ok' ? 'var(--color-success)' : 'var(--color-danger)',
          color: '#FFFFFF',
          font: '500 var(--fs-footnote)/1.4 var(--font-text)',
          boxShadow: 'var(--card-shadow)',
        }}>
          {toast.text}
        </div>
      )}
    </>
  );
}

function MergeBody({ preview, err }: { preview: MergePreview; err: string | null }) {
  return (
    <>
      <div id="pr-confirm-title" style={{ font: '700 var(--fs-headline)/1.2 var(--font-display)', color: 'var(--ink)' }}>
        Confirm merge
      </div>
      <div style={{ color: 'var(--ink-secondary)' }}>
        An agent prepared this merge. The desktop will only land it after you click <strong>Confirm Merge</strong>.
      </div>
      <div style={{
        background: 'var(--fill-tertiary)', borderRadius: 10, padding: 12,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{ font: '600 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink)' }}>
          PR #{preview.prNumber} — {preview.prTitle}
        </div>
        <Row label="Method" value={preview.mergeMethod === 'unknown' ? 'auto (will pick when merging)' : preview.mergeMethod} />
        <Row label="Mergeable" value={mergeableLabel(preview.mergeable, preview.mergeableState)} />
        <Row label="Checks" value={checksSummary(preview.checks)} />
        {preview.headSha && <Row label="Head" value={preview.headSha.slice(0, 7)} mono />}
      </div>
      {err && <ErrLine text={err} />}
    </>
  );
}

function ResolveBody({ preview, err }: { preview: ResolvePreview; err: string | null }) {
  return (
    <>
      <div id="pr-confirm-title" style={{ font: '700 var(--fs-headline)/1.2 var(--font-display)', color: 'var(--ink)' }}>
        Apply conflict resolution
      </div>
      <div style={{ color: 'var(--ink-secondary)' }}>
        An agent prepared this resolution. The desktop will only pull the base branch into your worktree after you click <strong>Apply Resolution</strong>.
      </div>
      <div style={{
        background: 'var(--fill-tertiary)', borderRadius: 10, padding: 12,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        {preview.prNumber && preview.prTitle && (
          <div style={{ font: '600 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink)' }}>
            PR #{preview.prNumber} — {preview.prTitle}
          </div>
        )}
        <Row label="Branch" value={preview.branch ?? '?'} mono />
        <Row label="Base" value={preview.base ?? '?'} mono />
        <Row label="Existing conflicts" value={preview.conflictedFiles.length ? `${preview.conflictedFiles.length} file(s)` : 'none'} />
        {preview.conflictedFiles.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-secondary)' }}>
            {preview.conflictedFiles.slice(0, 8).map(f => <li key={f} style={{ font: '400 var(--fs-caption)/1.3 var(--font-mono)' }}>{f}</li>)}
            {preview.conflictedFiles.length > 8 && <li style={{ color: 'var(--ink-tertiary)' }}>… and {preview.conflictedFiles.length - 8} more</li>}
          </ul>
        )}
      </div>
      {err && <ErrLine text={err} />}
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <span style={{ minWidth: 88, color: 'var(--ink-tertiary)', font: '500 var(--fs-caption)/1.2 var(--font-text)' }}>{label}</span>
      <span style={{ color: 'var(--ink)', font: mono ? '500 var(--fs-caption)/1.2 var(--font-mono)' : '500 var(--fs-footnote)/1.3 var(--font-text)' }}>{value}</span>
    </div>
  );
}

function ErrLine({ text }: { text: string }) {
  return (
    <div role="alert" style={{ color: 'var(--color-danger)', font: '500 var(--fs-footnote)/1.3 var(--font-text)' }}>
      {text}
    </div>
  );
}

function Spinner() {
  return (
    <span aria-label="working" style={{
      display: 'inline-block', width: 14, height: 14, borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#FFFFFF',
      animation: 'pr-confirm-spin 0.7s linear infinite',
    }}>
      <style>{`@keyframes pr-confirm-spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}

function mergeableLabel(mergeable: boolean | null, state: string): string {
  if (state === 'clean') return 'clean — ready';
  if (state === 'dirty') return 'has conflicts';
  if (state === 'blocked') return 'blocked';
  if (state === 'behind') return 'behind base';
  if (state === 'unstable') return 'checks failing';
  if (state === 'draft') return 'draft';
  if (mergeable == null) return state || 'computing…';
  return mergeable ? 'mergeable' : 'not mergeable';
}

function checksSummary(checks: { name: string; status: 'pending' | 'success' | 'failure' }[]): string {
  if (!checks.length) return 'no checks';
  const ok = checks.filter(c => c.status === 'success').length;
  const fail = checks.filter(c => c.status === 'failure').length;
  const pending = checks.filter(c => c.status === 'pending').length;
  const parts: string[] = [];
  if (ok) parts.push(`${ok} passed`);
  if (fail) parts.push(`${fail} failing`);
  if (pending) parts.push(`${pending} pending`);
  return parts.join(' · ');
}
