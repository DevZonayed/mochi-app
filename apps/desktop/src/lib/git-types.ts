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
