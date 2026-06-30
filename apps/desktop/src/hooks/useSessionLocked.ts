/* "Is this session read-only because its PR was merged?"

   ONE source of truth for the composer-disabled + banner-visible gates. A
   merged PR means the work is done and on the base branch — letting the user
   keep typing into that chat would either (a) sit in a stale worktree whose
   branch is about to be cleaned up, or (b) make commits that can't be turned
   into a PR (the original PR is closed). So we lock the composer and steer
   the user to "Continue from here" which spawns a new session off the (now
   updated) base.

   Single-state rule:  `pr-merged` → locked. EVERYTHING else (including the
   pre-merge `pr-mergeable`, post-merge but somehow re-opened, closed-without-
   merge, etc.) → unlocked. The user can still copy/export from a locked
   session — the lock is only on NEW input.

   Wraps the existing useSessionGitState cache: no extra fetches, no extra
   subscribers — same per-id pub/sub. */

import { useSessionStateOnly } from '../lib/useSessionGitState';

export function useSessionLocked(sessionId: string | null | undefined): boolean {
  const state = useSessionStateOnly(sessionId);
  return state === 'pr-merged';
}
