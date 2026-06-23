/* The per-session git/PR state machine — pure, so it unit-tests without Electron
   or the network. `deriveState` is the exact "PR available? merge or resolve?"
   logic (Conductor parity). Types here are shared by github.ts + git-service.ts. */

export type SessionGitState =
  | 'no-repo'
  | 'clean'         // no commits beyond base
  | 'uncommitted'   // dirty working tree
  | 'ready-to-push' // commits ahead, not on the remote yet
  | 'ready-for-pr'  // pushed, commits ahead, no open PR  → "branch has commits → PR available"
  | 'pr-mergeable'  // open PR, clean       → Merge
  | 'pr-conflicts'  // open PR, conflicts   → Resolve
  | 'pr-blocked'    // open PR, blocked/behind/checks pending
  | 'pr-merged'     // → Archive
  | 'pr-closed';    // closed unmerged

export interface LocalState {
  isRepo: boolean;
  ahead: number;
  behind: number;
  dirty: boolean;
  /** remote has the branch and local HEAD isn't ahead of origin/<branch>. */
  pushed: boolean;
}

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

/** Compact "last commit + dirty file count" snapshot for the GitOpsDock's
    expanded view. Optional — older callers (sidebar dot, project rollup)
    don't need it, so we don't pay the `git log -1 / git status` cost
    on the hot path. Populated by `GitService.fullStatus`. */
export interface LocalSnapshot {
  /** First line of `git log -1 --format=%s`. `null` when the branch has no commits. */
  lastSubject: string | null;
  /** Author date of the last commit (epoch ms). `null` when no commits. */
  lastCommitAt: number | null;
  /** Number of modified/added/deleted files in the working tree (porcelain count). */
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
  /** Renderer-facing extras for the GitOpsDock; absent on older callers. */
  snapshot?: LocalSnapshot;
}

/* ── Human-confirm preview payloads ──────────────────────────────────────
   When the agent calls `pr_merge` / `pr_resolve_conflicts` without the
   renderer's `confirmed: true` flag, the handler returns a preview so the UI
   can show a hard-button dialog. See `git-ctx.ts` for the contract. */

/** What the renderer needs to render the confirm dialog for `pr_merge`. */
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

/** What the renderer needs to render the confirm dialog for `pr_resolve_conflicts`. */
export interface ResolvePreview {
  prNumber: number | null;
  prTitle: string | null;
  prUrl: string | null;
  base: string | null;
  branch: string | null;
  /** Files that already carry conflict markers in the worktree (may be empty
      if the worktree is still clean — calling the action will then pull base
      in and the conflicts will be reported on the second call). */
  conflictedFiles: string[];
}

/** Returned by GitService.previewMergePr — `ok:false` when no open PR. */
export type MergePreviewResult =
  | { ok: true; preview: MergePreview }
  | { ok: false; reason: string };

/** Returned by GitService.previewResolveSession. */
export type ResolvePreviewResult =
  | { ok: true; preview: ResolvePreview }
  | { ok: false; reason: string };

/** Derive the single surfaced state from local git facts + (optional) PR facts. */
export function deriveState(local: LocalState, pr: PrStatus | null): SessionGitState {
  if (!local.isRepo) return 'no-repo';

  if (pr) {
    if (pr.state === 'merged') return 'pr-merged';
    if (pr.state === 'closed') return 'pr-closed';
    // open PR: the merge-vs-resolve split
    if (pr.mergeableState === 'clean') return 'pr-mergeable';
    if (pr.mergeableState === 'dirty') return 'pr-conflicts';
    // blocked / behind / unstable / draft / unknown (still computing) → blocked
    return 'pr-blocked';
  }

  if (local.dirty) return 'uncommitted';
  if (local.ahead === 0) return 'clean';
  if (!local.pushed) return 'ready-to-push';
  return 'ready-for-pr';
}
