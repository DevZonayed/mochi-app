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
}
export interface SessionGitStatus {
  sessionId: string;
  branch: string | null;
  base: string | null;
  local: LocalState;
  pr: PrStatus | null;
  state: SessionGitState;
  lastCheckedAt: number;
}
export interface GithubConnection { connected: boolean; login: string | null; scopes: string[] | null; hasRepoScope: boolean; }

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
