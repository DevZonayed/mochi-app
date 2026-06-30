/* AiConflictResolveDialog — the T8 entry point. Opens when the operator clicks
   "Resolve with AI" in <GitOpsDock /> while the session is in `pr-conflicts`.

   What it does in one sentence:
     surface the live conflict hunks read-only + collect an optional
     instructions string, then dispatch a SINGLE prefixed chat turn into the
     current session that asks the agent to edit the files clean and then call
     `pr_resolve_conflicts` (which surfaces the existing #63 PrActionConfirm
     dialog for the final commit + push).

   UX rationale:
     • The button is supposed to be the operator's MAIN tool for managing
       merge conflicts (per the user's brief), so the dialog leans heavy on
       the preview + instructions textarea, and treats the agent dispatch
       itself as a one-tap action.
     • Cancel is default-focused (no accidental fires from Enter / Space).
     • The Run button does NOT bind Enter — same discipline as #63 + Track 5
       so a slip of the keyboard never starts a model run.
     • On Run, the dialog CLOSES (the chat composer in the background is the
       proper home for the run; surfacing a live log inside a modal would
       fight with the chat scrollback the operator already has). We persist
       the operator's instructions on submit so re-opens pre-fill the box.

   Accessibility:
     • role="dialog" + aria-modal=true; Esc closes; focus trap restricted to
       the dialog's focusable elements; Cancel auto-focuses on open.
     • Each hunk renders inside a <pre aria-label="Conflict in <path>">.
     • Run button: aria-label="Run AI resolution", disabled while in flight. */

import React from 'react';
import { api } from '../lib/api';
import { ApiError } from '../lib/api';
import type { ConflictFile, ConflictHunk } from '../lib/git-types';

export interface AiConflictResolveDialogProps {
  open: boolean;
  /** Session whose worktree owns the conflicts. */
  sessionId: string;
  /** Project the session belongs to (needed for api.sendChat). */
  projectId: string;
  /** Branch name for the dialog's header subtitle (e.g. "mochi/lyon/fix-x"). */
  branch: string | null;
  /** PR title for the dialog header (falls back to the session's title). */
  prTitle: string | null;
  /** Initial value for the "Additional instructions" textarea. Pulled from
      `ChatSession.conflictResolveHint`. Pre-fills on re-runs. */
  initialHint?: string | null;
  /** Optional hook called with the operator's submitted instructions string
      on a successful Run. Caller persists it (e.g. via
      `api.setConflictResolveHint`) so the next open pre-fills the textarea.
      Optional — the dialog still functions without it. */
  onPersistHint?: (hint: string) => void;
  onClose: () => void;
}

/** Build the prefixed system context for the agent's chat turn.
    Exported for the renderer test so the prompt contract is locked. */
export function buildConflictResolutionPrompt(args: {
  prTitle: string | null;
  branch: string | null;
  files: ConflictFile[];
  instructions: string;
}): string {
  const { prTitle, branch, files, instructions } = args;
  const fileList = files.map(f => `  • ${f.path}${f.unreadable ? ' (unreadable)' : ` (${f.hunks.length} hunk${f.hunks.length === 1 ? '' : 's'})`}`).join('\n');
  const header = [
    '[Conflict resolution mode]',
    `The current PR (${prTitle ?? branch ?? 'this branch'}) has merge conflicts in the following files:`,
    fileList || '  • (none — git reports no conflicted files; double-check the worktree)',
    '',
    instructions.trim()
      ? `The operator has provided these additional instructions: "${instructions.trim()}"`
      : 'The operator did not provide additional instructions — use your best judgment.',
    '',
    'Resolve each file. Edit out the <<<<<<</=======/>>>>>>> markers. Preserve the intended behavior of both sides where possible. When all conflicts are clean, call pr_resolve_conflicts (it will prompt the operator to confirm and finalize).',
  ].join('\n');

  // Append the live hunks as fenced blocks so the agent has the same view the
  // operator does. Cap each hunk's payload so a multi-MB binary smush doesn't
  // blow the turn budget; the agent can always re-read the file itself.
  const hunkSections = files.map(f => {
    if (f.unreadable) return `\n--- ${f.path} ---\n(file unreadable — agent must read it directly)`;
    if (!f.hunks.length) return `\n--- ${f.path} ---\n(no parsed hunks — file may have unusual markers; agent should re-read)`;
    const blocks = f.hunks.map((h, i) => {
      const ours = capLines(h.ours).join('\n');
      const theirs = capLines(h.theirs).join('\n');
      const base = h.base ? `\n||||||| base\n${capLines(h.base).join('\n')}` : '';
      return [
        `Hunk ${i + 1} (lines ${h.startLine}–${h.endLine})`,
        '```',
        `<<<<<<< ${h.oursLabel}`,
        ours,
        `${base}\n=======`.replace(/^\n/, ''),
        theirs,
        `>>>>>>> ${h.theirsLabel}`,
        '```',
      ].join('\n');
    });
    return `\n--- ${f.path} ---\n${blocks.join('\n\n')}`;
  });

  return `${header}\n${hunkSections.join('\n')}`;
}

/** Trim a `ours`/`theirs` payload to a sensible upper bound so a giant
    conflict doesn't drown the chat turn. The agent will re-read the file on
    disk anyway — this is just the preview surface. */
function capLines(lines: string[], max = 60): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `… (${lines.length - max} more lines, truncated)`];
}

/* ── component ─────────────────────────────────────────────────────────── */

export function AiConflictResolveDialog({ open, sessionId, projectId, branch, prTitle, initialHint, onPersistHint, onClose }: AiConflictResolveDialogProps) {
  const [files, setFiles] = React.useState<ConflictFile[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [instructions, setInstructions] = React.useState<string>('');
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const dialogRef = React.useRef<HTMLDivElement>(null);

  // Load hunks on open + reset the form. The hint pre-fill is intentionally
  // applied here so reopening the dialog after a previous run shows the last
  // typed instructions.
  React.useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    setInstructions(initialHint ?? '');
    setLoading(true); setLoadError(null);
    let on = true;
    api.getConflictHunks(sessionId)
      .then((r) => { if (on) { setFiles(r.files); if (!r.files.length && r.reason) setLoadError(r.reason); } })
      .catch((e: unknown) => { if (on) setLoadError(e instanceof Error ? e.message : 'Failed to read conflicts.'); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [open, sessionId, initialHint]);

  // Esc closes, focus trap on Tab, default-focus on Cancel.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key === 'Tab') {
        const root = dialogRef.current; if (!root) return;
        const focusables = Array.from(root.querySelectorAll<HTMLElement>('button, textarea, [href], [tabindex]:not([tabindex="-1"])')).filter(el => !el.hasAttribute('disabled'));
        if (!focusables.length) return;
        const first = focusables[0]; const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    const t = setTimeout(() => cancelRef.current?.focus(), 30);
    return () => { window.removeEventListener('keydown', onKey, true); clearTimeout(t); };
  }, [open, onClose]);

  if (!open) return null;

  const totalHunks = files.reduce((n, f) => n + f.hunks.length, 0);
  const fileCount = files.length;
  const canRun = !submitting && !loading && fileCount > 0;

  const run = async (): Promise<void> => {
    if (!canRun) return;
    setSubmitting(true); setSubmitError(null);
    try {
      const text = buildConflictResolutionPrompt({ prTitle, branch, files, instructions });
      await api.sendChat({ projectId, sessionId, text });
      // Forward the operator's instructions to the optional persistence hook
      // (a follow-up commit wires it; the optional chain keeps this commit
      // self-contained so the dialog dispatches even without persistence).
      onPersistHint?.(instructions.trim());
      onClose();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e instanceof Error ? e.message : 'Failed to dispatch the resolve turn.');
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div role="presentation" data-testid="ai-conflict-overlay" onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.36)', zIndex: 9100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)',
    }}>
      <div ref={dialogRef}
        role="dialog" aria-modal="true" aria-labelledby="ai-resolve-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 680, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 64px)',
          display: 'flex', flexDirection: 'column',
          padding: 0, borderRadius: 14, background: 'var(--bg-elevated)',
          boxShadow: '0 32px 64px rgba(0,0,0,0.28), 0 0 0 0.5px var(--separator-strong)',
          color: 'var(--ink)',
        }}>
        {/* Header */}
        <div style={{ padding: '18px 22px 14px', borderBottom: '0.5px solid var(--separator)' }}>
          <div id="ai-resolve-title" style={{ font: '700 var(--fs-title3, var(--fs-headline))/1.2 var(--font-text)' }}>
            Resolve merge conflicts with AI
          </div>
          <div style={{ marginTop: 4, font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>
            {prTitle ? <>{prTitle} · </> : null}
            {branch ? <code style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)' }}>{branch}</code> : 'no branch'}
            {fileCount > 0 && (
              <span style={{ marginLeft: 8, color: 'var(--ink-tertiary)' }}>
                · {fileCount} file{fileCount === 1 ? '' : 's'} · {totalHunks} hunk{totalHunks === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>

        {/* Body — scrollable */}
        <div style={{ padding: '14px 22px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {loading && (
            <div style={{ color: 'var(--ink-tertiary)', font: '500 var(--fs-body)/1.4 var(--font-text)' }}>Reading conflicts…</div>
          )}
          {!loading && loadError && (
            <div role="alert" style={{ color: 'var(--red)', font: '500 var(--fs-body)/1.4 var(--font-text)', marginBottom: 8 }}>
              ⚠ {loadError}
            </div>
          )}
          {!loading && !loadError && files.length === 0 && (
            <div style={{ color: 'var(--ink-tertiary)', font: '500 var(--fs-body)/1.4 var(--font-text)' }}>
              No active conflicts found in the worktree. If the PR shows conflicts on GitHub, click the "Pull base" action on the dock first to start the merge.
            </div>
          )}

          {files.map((f) => (
            <ConflictFileView key={f.path} file={f} />
          ))}

          {/* Instructions textarea — the headline interaction. */}
          <label htmlFor="ai-resolve-instructions" style={{
            display: 'block', marginTop: files.length ? 16 : 0,
            font: '600 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)',
          }}>
            Additional instructions <span style={{ color: 'var(--ink-tertiary)', fontWeight: 500 }}>(optional)</span>
          </label>
          <textarea id="ai-resolve-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder={`e.g. "prefer the branch version for routing changes; keep master's schema migration; merge import lists alphabetically"`}
            aria-label="Additional instructions for AI conflict resolution"
            rows={3}
            maxLength={2000}
            style={{
              width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '10px 12px',
              borderRadius: 8, border: '0.5px solid var(--separator-strong)',
              background: 'var(--fill-tertiary)', color: 'var(--ink)',
              font: '500 var(--fs-body)/1.45 var(--font-text)', resize: 'vertical',
            }} />

          {submitError && (
            <div role="alert" style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 7,
              background: 'color-mix(in srgb, var(--red) 14%, transparent)',
              color: 'var(--red)', font: '500 var(--fs-footnote)/1.4 var(--font-text)',
            }}>⚠ {submitError}</div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 22px', borderTop: '0.5px solid var(--separator)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ font: '500 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>
            The agent will edit each file in your worktree and request final confirmation before commit + push.
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button ref={cancelRef} type="button" onClick={onClose}
              aria-label="Cancel AI conflict resolution"
              style={{
                height: 32, padding: '0 14px', borderRadius: 8,
                border: '0.5px solid var(--separator-strong)',
                background: 'var(--fill-secondary)', color: 'var(--ink)',
                font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer',
              }}>Cancel</button>
            <button type="button" onClick={() => { void run(); }}
              disabled={!canRun}
              aria-label="Run AI resolution"
              data-testid="ai-resolve-run"
              style={{
                height: 32, padding: '0 16px', borderRadius: 8,
                border: '0.5px solid transparent',
                background: 'var(--blue)', color: 'white',
                font: '700 var(--fs-footnote)/1 var(--font-text)',
                cursor: canRun ? 'pointer' : 'not-allowed', opacity: canRun ? 1 : 0.5,
              }}>{submitting ? 'Dispatching…' : 'Run'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── one file's hunks ───────────────────────────────────────────────────── */

function ConflictFileView({ file }: { file: ConflictFile }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4,
        font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)',
      }}>
        <span>{file.path}</span>
        {file.unreadable && <span style={{ color: 'var(--orange)', font: '500 var(--fs-caption)/1 var(--font-text)' }}>unreadable</span>}
        {!file.unreadable && !file.hunks.length && <span style={{ color: 'var(--ink-tertiary)', font: '500 var(--fs-caption)/1 var(--font-text)' }}>no parsed hunks</span>}
      </div>
      {file.hunks.map((h, i) => <ConflictHunkView key={i} path={file.path} index={i} hunk={h} />)}
    </div>
  );
}

function ConflictHunkView({ path, index, hunk }: { path: string; index: number; hunk: ConflictHunk }) {
  // Render as a single <pre> with inline coloring per side. Plain mono font;
  // syntax highlighting was considered but rejected — every project has its
  // own language stack and adding a highlighter just for this surface is
  // overkill (the agent gets the same text).
  const lineRange = `${hunk.startLine}–${hunk.endLine}`;
  return (
    <pre aria-label={`Conflict in ${path}, hunk ${index + 1}`}
      style={{
        margin: '6px 0', padding: '10px 12px', borderRadius: 8,
        background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)',
        font: '500 var(--fs-caption)/1.5 var(--font-mono)', color: 'var(--ink)',
        overflowX: 'auto', whiteSpace: 'pre', maxHeight: 280,
      }}>
      <div style={{ color: 'var(--ink-tertiary)', font: '500 var(--fs-caption)/1 var(--font-text)', marginBottom: 4 }}>
        Hunk {index + 1} · lines {lineRange}
      </div>
      <Marker text={`<<<<<<< ${hunk.oursLabel}`} side="ours" />
      {hunk.ours.map((l, i) => <Line key={`o${i}`} text={l} side="ours" />)}
      {hunk.base && (
        <>
          <Marker text="||||||| base" side="base" />
          {hunk.base.map((l, i) => <Line key={`b${i}`} text={l} side="base" />)}
        </>
      )}
      <Marker text="=======" side="sep" />
      {hunk.theirs.map((l, i) => <Line key={`t${i}`} text={l} side="theirs" />)}
      <Marker text={`>>>>>>> ${hunk.theirsLabel}`} side="theirs" />
    </pre>
  );
}

function colorFor(side: 'ours' | 'theirs' | 'base' | 'sep'): string {
  switch (side) {
    case 'ours':   return 'color-mix(in srgb, var(--blue) 18%, transparent)';
    case 'theirs': return 'color-mix(in srgb, var(--purple, #af52de) 18%, transparent)';
    case 'base':   return 'color-mix(in srgb, var(--orange) 14%, transparent)';
    case 'sep':    return 'transparent';
  }
}
function Marker({ text, side }: { text: string; side: 'ours' | 'theirs' | 'base' | 'sep' }) {
  return <div style={{ background: colorFor(side), padding: '0 4px', color: side === 'sep' ? 'var(--ink-tertiary)' : 'var(--ink)' }}>{text}</div>;
}
function Line({ text, side }: { text: string; side: 'ours' | 'theirs' | 'base' }) {
  return <div style={{ background: colorFor(side), padding: '0 4px' }}>{text || ' '}</div>;
}
