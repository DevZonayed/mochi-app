/* Renders ABOVE the transcript when a session's PR has been merged.

   The behavior contract (Track 7):
   • Visible ONLY when `useSessionGitState(sessionId).state === 'pr-merged'`.
   • Shows "Merged on <date> to <baseBranch>" on the left.
   • Two buttons on the right:
       – "View read-only" (secondary, default focus): dismisses the banner for
          this mount; the composer stays locked (the lock is driven by the
          session state, not the banner).
       – "Continue from here →" (primary): asks the parent to spawn a new
          session forked off the merged base ref (handler lives in the parent
          so it can also open the new tab).
   • Dismiss is per-mount only — re-opening the chat brings the banner back.
     This is deliberate: the user's "I know it's merged" acknowledgement
     shouldn't be persisted in storage when the underlying state is permanent.

   We deliberately DON'T tie the composer lock to "is the banner showing" — the
   `pr-merged` state is what locks input, end of story. The banner is one of
   several surfaces that EXPLAIN the lock; dismissing it just hides the
   explanation. */

import React from 'react';
import type { PrStatus } from '../lib/git-types';

interface Props {
  pr: PrStatus;
  /** Spawn the continuation session (parent owns the actual createSession +
      tab-switch dance). Optional — if absent, the button hides; this keeps the
      component robust when a chat surface hasn't wired the handler yet. */
  onContinue?: () => void;
  /** Disable the primary button while the continuation is in-flight, so a
      double-click doesn't spawn two new sessions on a slow network. */
  continuing?: boolean;
}

function formatMergedAt(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return 'recently';
  const d = new Date(ms);
  // Local short date — the operator's wall clock is what they care about.
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleDateString(undefined, opts);
}

export function MergedSessionBanner({ pr, onContinue, continuing }: Props): React.ReactElement | null {
  const [dismissed, setDismissed] = React.useState(false);
  // Default focus on the safe "view read-only" button so the user doesn't
  // accidentally spawn a new session by hitting Enter on a freshly-opened tab.
  const viewRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { if (!dismissed) viewRef.current?.focus(); }, [dismissed]);

  if (dismissed) return null;

  const date = formatMergedAt(pr.mergedAt);
  const base = pr.baseRefName ?? 'the base branch';

  return (
    <div role="status" aria-live="polite" style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      margin: '0 24px', padding: '10px 14px', borderRadius: 12,
      background: 'color-mix(in srgb, var(--green) 9%, var(--bg-elevated))',
      border: '0.5px solid color-mix(in srgb, var(--green) 32%, var(--separator))',
      color: 'var(--ink)',
    }}>
      <span aria-hidden="true" style={{
        display: 'inline-grid', placeItems: 'center', width: 22, height: 22, flexShrink: 0,
        borderRadius: '50%', background: 'var(--green)', color: '#fff',
        font: '700 13px/1 var(--font-text)',
      }}>✓</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ font: '600 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink)' }}>
          Merged on {date} to <code style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--green)', background: 'transparent' }}>{base}</code>
        </div>
        <div style={{ font: '400 var(--fs-caption)/1.35 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>
          This chat is now view-only. Continue from here to keep working in a new session.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button ref={viewRef} onClick={() => setDismissed(true)} style={{
          height: 30, padding: '0 12px', borderRadius: 'var(--r-pill)',
          background: 'var(--fill-secondary)', color: 'var(--ink)', cursor: 'pointer',
          font: '600 var(--fs-footnote)/1 var(--font-text)', border: 'none',
        }}>View read-only</button>
        {onContinue && (
          <button onClick={onContinue} disabled={continuing} style={{
            height: 30, padding: '0 14px', borderRadius: 'var(--r-pill)',
            background: continuing ? 'var(--fill-secondary)' : 'var(--blue)',
            color: continuing ? 'var(--ink-secondary)' : '#fff',
            cursor: continuing ? 'default' : 'pointer',
            font: '600 var(--fs-footnote)/1 var(--font-text)', border: 'none',
          }}>{continuing ? 'Creating…' : 'Continue from here →'}</button>
        )}
      </div>
    </div>
  );
}
