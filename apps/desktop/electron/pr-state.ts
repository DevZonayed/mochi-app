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

export interface SessionGitStatus {
  sessionId: string;
  branch: string | null;
  base: string | null;
  local: LocalState;
  pr: PrStatus | null;
  state: SessionGitState;
  lastCheckedAt: number;
}

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
