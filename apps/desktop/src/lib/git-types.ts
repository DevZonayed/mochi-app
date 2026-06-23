/* Renderer-side mirror of the main-process git/PR types (electron/pr-state.ts,
   electron/github-auth.ts). Kept in sync by hand — these cross the IPC boundary
   as plain JSON. */

export type SessionGitState =
  | 'no-repo' | 'clean' | 'uncommitted' | 'ready-to-push' | 'ready-for-pr'
  | 'pr-mergeable' | 'pr-conflicts' | 'pr-blocked' | 'pr-merged' | 'pr-closed';

export interface LocalState { isRepo: boolean; ahead: number; behind: number; dirty: boolean; pushed: boolean; }
export interface PrCheck { name: string; status: 'pending' | 'success' | 'failure'; }
export interface PrStatus {
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  mergeable: boolean | null;
  mergeableState: 'clean' | 'dirty' | 'blocked' | 'behind' | 'unstable' | 'draft' | 'unknown';
  checks: PrCheck[];
  /** Branch this PR targets — populated by getPullStatus from REST `base.ref`.
      Surfaced to the renderer so the merged banner can show "Merged to <base>"
      and the Continue handler knows where to fork the next session. */
  baseRefName?: string;
  /** Epoch-ms timestamp of the merge. ONLY present when `state === 'merged'`. */
  mergedAt?: number;
}
export interface LocalSnapshot {
  lastSubject: string | null;
  lastCommitAt: number | null;
  dirtyFiles: number;
}
export interface SessionGitStatus {
  sessionId: string;
  branch: string | null;
  base: string | null;
  local: LocalState;
  pr: PrStatus | null;
  state: SessionGitState;
  lastCheckedAt: number;
  snapshot?: LocalSnapshot;
}
export interface GithubConnection { connected: boolean; login: string | null; scopes: string[] | null; hasRepoScope: boolean; }

/* ── PR action human-confirm payloads (mirror electron/pr-state.ts) ──── */

export interface MergePreview {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  mergeMethod: 'merge' | 'squash' | 'rebase' | 'unknown';
  headSha: string | null;
  mergeable: boolean | null;
  mergeableState: PrStatus['mergeableState'];
  checks: PrCheck[];
}
export interface ResolvePreview {
  prNumber: number | null;
  prTitle: string | null;
  prUrl: string | null;
  base: string | null;
  branch: string | null;
  conflictedFiles: string[];
}
export type MergePreviewResult = { ok: true; preview: MergePreview } | { ok: false; reason: string };
export type ResolvePreviewResult = { ok: true; preview: ResolvePreview } | { ok: false; reason: string };

/** The agent's pr_merge / pr_resolve_conflicts tool surfaces this event so the
    renderer can show the hard-button confirmation dialog. Only the desktop sees
    these (Mac-local, never relayed). */
export interface PrConfirmRequest {
  action: 'pr_merge' | 'pr_resolve_conflicts';
  sessionId: string | null;
  /** MergePreview when action === 'pr_merge'; ResolvePreview otherwise. */
  preview: MergePreview | ResolvePreview;
}

/* ── Codename / state helpers — pure, shared by every UI surface ───────── */

/** Display-friendly codename: `lyon` → `Lyon`, `chiang-mai` → `Chiang Mai`. */
export function displayCodename(codename: string | null | undefined): string {
  if (!codename) return '';
  return codename.split('-').map(p => p ? p[0].toUpperCase() + p.slice(1) : '').join(' ');
}

/** Pull the codename segment out of `mochi/<city>/<slug>`. Null if the branch
    doesn't follow the convention (e.g. legacy `mochi/foo-ab12`). */
export function codenameFromBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  const m = /^mochi\/([a-z0-9-]+)\//.exec(branch);
  return m ? m[1] : null;
}

/** Human-friendly state label for badges / chips. */
export const SESSION_STATE_LABELS: Record<SessionGitState, string> = {
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

/** Color map for the SessionStateDot. Returns a CSS-var string. */
export const SESSION_STATE_COLOR: Record<SessionGitState, string> = {
  'no-repo': 'transparent',
  clean: 'var(--ink-tertiary)',
  uncommitted: 'var(--orange)',
  'ready-to-push': 'var(--blue)',
  'ready-for-pr': 'var(--blue)',
  'pr-mergeable': 'var(--green)',
  'pr-conflicts': 'var(--red)',
  'pr-blocked': 'var(--orange)',
  'pr-merged': 'var(--purple)',
  'pr-closed': 'var(--ink-tertiary)',
};

/** Left-border stripe color per state — used on each chat row in the rail so
    the user can scan their work at a glance: gray=clean, amber=uncommitted,
    blue=PR open, green=mergeable, red=conflicts/failing. Soft variants are
    distinguishable from their bold cousins (lighter, lower contrast). The
    values map to the semantic --color-* tokens in @maestro/design-tokens. */
export const SESSION_STATE_STRIPE: Record<SessionGitState, string> = {
  'no-repo':       'transparent',
  clean:           'var(--color-muted)',
  uncommitted:    'var(--color-warning)',
  'ready-to-push': 'var(--color-warning-soft)',
  'ready-for-pr':  'var(--color-info)',
  'pr-mergeable':  'var(--color-success)',
  'pr-conflicts':  'var(--color-danger)',
  'pr-blocked':    'var(--color-danger-soft)',
  'pr-merged':     'var(--color-success-soft)',
  'pr-closed':     'var(--color-muted)',
};

/** Plain-English label for the tooltip + aria-label on each chat row. Slightly
    more specific than SESSION_STATE_LABELS (which is a one-word chip label). */
export const SESSION_STATE_LONG_LABELS: Record<SessionGitState, string> = {
  'no-repo':       'Not a git repo',
  clean:           'Clean — no changes',
  uncommitted:     'Uncommitted changes',
  'ready-to-push': 'Local commits — ready to push',
  'ready-for-pr':  'Pushed — ready to open PR',
  'pr-mergeable':  'Open PR — ready to merge',
  'pr-conflicts':  'PR conflicts — needs resolution',
  'pr-blocked':    'PR blocked — checks pending or behind base',
  'pr-merged':     'PR merged',
  'pr-closed':     'PR closed without merging',
};

/** Worst-state-wins priority (higher = more urgent). Used by the project icon
    rollup so a card screams red when ANY of its sessions has a PR conflict. */
const STATE_PRIORITY: Record<SessionGitState, number> = {
  'no-repo': 0,
  clean: 1,
  'pr-closed': 2,
  'pr-merged': 3,
  uncommitted: 4,
  'ready-to-push': 5,
  'ready-for-pr': 6,
  'pr-blocked': 7,
  'pr-mergeable': 8,
  'pr-conflicts': 9,
};

/** Reduce a project's per-session states into ONE rollup state — the worst. */
export function rollupSessionState(states: SessionGitState[]): SessionGitState | null {
  let best: SessionGitState | null = null;
  let bestRank = -1;
  for (const s of states) {
    const r = STATE_PRIORITY[s] ?? 0;
    if (r > bestRank) { best = s; bestRank = r; }
  }
  return best;
}
